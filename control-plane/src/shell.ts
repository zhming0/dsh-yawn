import type { Context } from "@deepseek-ai/cordis";
import {
  ShellExecutor,
  type CollectedOutput,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellExecution,
  type ShellProcessRead,
  type ShellRunResult,
} from "@deepseek-ai/dsh-shell";
import type {
  SubprocessOutputRead,
  SubprocessOutputReader,
} from "@deepseek-ai/dsh-subprocess";
import z from "@deepseek-ai/schemastery";
import { metrics } from "@opentelemetry/api";

import type { RunnerClient } from "./runner-client.js";
import { pathInSandbox } from "./sandbox-path.js";

const execDuration = metrics
  .getMeter("dsh-yawn-control-plane")
  .createHistogram("dsh.sandbox.exec.duration", { unit: "ms" });

export interface Config {
  cwd?: string;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  outputMaxBytes?: number;
}

interface ResolvedConfig {
  cwd: string;
  timeoutMs: number;
  maxTimeoutMs: number;
  outputMaxBytes: number;
}

export class SandboxShellExecutor extends ShellExecutor {
  static inject = ["sandboxManager", "agents"];
  static Config = z.object({
    cwd: z.string(),
    timeoutMs: z.number().min(1).default(300_000),
    maxTimeoutMs: z.number().min(1).default(3_600_000),
    outputMaxBytes: z
      .natural()
      .min(1)
      .default(1024 * 1024),
  });
  private readonly config: ResolvedConfig;
  private readonly live = new Set<RemoteShellProcess>();

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.config = {
      cwd: config.cwd ?? ctx.sandboxManager.workspace,
      timeoutMs: config.timeoutMs ?? 300_000,
      maxTimeoutMs: config.maxTimeoutMs ?? 3_600_000,
      outputMaxBytes: config.outputMaxBytes ?? 1024 * 1024,
    };
    ctx.effect(() => async () => {
      for (const process of this.live) {
        process.kill();
      }
      await Promise.all([...this.live].map((process) => process.done));
    });
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = Math.min(
      request.timeoutMs ?? this.config.timeoutMs,
      this.config.maxTimeoutMs,
    );
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("shell timeout must be positive");
    }
    const sessionWorkspace =
      this.ctx.agents.requireInitiator().session.header.cwd;
    return {
      command: request.command,
      workdir: pathInSandbox(
        request.workdir ?? this.config.cwd,
        sessionWorkspace,
        this.config.cwd,
      ),
      timeoutMs,
      onExpiry: request.onExpiry ?? "kill",
      stdoutMaxBytes: request.stdoutMaxBytes ?? this.config.outputMaxBytes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }),
      sandboxPolicy: request.sandboxPolicy,
    };
  }

  /**
   * Prepare and spawn under the resolved deadline. Preparation is the runner
   * client, which may wake a hibernated sandbox; the deadline runs through
   * it, so expiry during the wake settles as a timed-out handle with no
   * output instead of a rejected execute.
   */
  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    spec.signal?.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    const timer =
      spec.onExpiry === "none"
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort(new Error("shell timeout"));
          }, spec.timeoutMs);
    timer?.unref();
    try {
      const client = await this.ctx.sandboxManager.clientForCurrentAgent();
      spec.signal?.throwIfAborted();
      if (timedOut) {
        return RemoteShellProcess.expired(spec);
      }
      const process = new RemoteShellProcess(
        spec,
        spec.stdoutMaxBytes,
        this.config.outputMaxBytes,
        { timedOut: () => timedOut, clearTimer: () => clearTimeout(timer) },
        client,
        controller,
      );
      this.live.add(process);
      void process.done.finally(() => this.live.delete(process));
      void process.spawn();
      return process;
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  }
}

async function runShell(
  client: RunnerClient,
  spec: ShellExecSpec,
  signal: AbortSignal,
  stdout: TailBuffer,
  stderr: TailBuffer,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  const stream = client.exec(
    {
      argv: ["/bin/bash", "-lc", spec.command],
      cwd: spec.workdir,
      env: { ...spec.env, ...spec.dshEnv },
      stdin: new TextEncoder().encode(spec.stdin ?? ""),
    },
    { signal },
  );
  let outcome:
    | { exitCode: number | null; signal: NodeJS.Signals | null }
    | undefined;
  for await (const response of stream) {
    if (response.event.case === "stdout") {
      stdout.append(response.event.value);
    } else if (response.event.case === "stderr") {
      stderr.append(response.event.value);
    } else if (response.event.case === "exited") {
      outcome = {
        exitCode:
          response.event.value.signal === ""
            ? response.event.value.exitCode
            : null,
        signal:
          response.event.value.signal === ""
            ? null
            : (response.event.value.signal as NodeJS.Signals),
      };
    }
  }
  if (outcome === undefined) {
    throw new Error("runner exec stream ended without an exit status");
  }
  return outcome;
}

class TailBuffer {
  private text = "";
  private bytes = 0;
  private dropped = false;
  private written = 0;
  private readonly decoder = new TextDecoder();

  constructor(private readonly maxBytes: number) {}

  append(chunk: Uint8Array): void {
    const next = this.decoder.decode(chunk, { stream: true });
    this.text += next;
    this.written += next.length;
    this.bytes += chunk.byteLength;
    if (this.bytes > this.maxBytes) {
      this.dropped = true;
      const encoded = new TextEncoder().encode(this.text);
      const tail = encoded.subarray(
        Math.max(0, encoded.byteLength - this.maxBytes),
      );
      this.text = new TextDecoder().decode(tail);
      this.bytes = tail.byteLength;
    }
  }

  collected(): CollectedOutput {
    return { text: this.text, truncated: this.dropped };
  }

  /** Whole-stream character offsets over the retained capture: the buffer is
   * never cleared, so the observed readers, the foreground result, and the
   * consuming cursor all see one capture instead of stealing from one
   * another. A reader behind the retained tail gets the tail and a `lossy`
   * flag, matching the seam's offset-reader contract. */
  readFrom(fromChar: number): SubprocessOutputRead {
    const base = this.written - this.text.length;
    if (fromChar < base) {
      return { text: this.text, nextOffset: this.written, lossy: true };
    }
    return {
      text: this.text.slice(fromChar - base),
      nextOffset: this.written,
      lossy: false,
    };
  }

  /** One consuming read since `fromChar` without touching the capture: the
   * cursor belongs to the caller, so a drain cannot steal bytes the observed
   * readers or a later foreground result still need. */
  readSince(fromChar: number): {
    text: string;
    lossy: boolean;
    nextCursor: number;
  } {
    const view = this.readFrom(fromChar);
    return {
      text: view.text,
      lossy: view.lossy || this.dropped,
      nextCursor: view.nextOffset,
    };
  }
}

class TailReader implements SubprocessOutputReader {
  constructor(private readonly buffer: TailBuffer) {}
  readFrom(fromByte: number): SubprocessOutputRead {
    return this.buffer.readFrom(fromByte);
  }
}

interface RemoteShellDeps {
  /** Whether the executor's own timer fired first; the first-cause fact. */
  timedOut: () => boolean;
  clearTimer: () => void;
}

class RemoteShellProcess implements ShellExecution {
  status: "running" | "completed" | "killed" = "running";
  exitCode: number | null = null;
  signal: NodeJS.Signals | null = null;
  readonly stdout: TailBuffer;
  readonly stderr: TailBuffer;
  /** Consuming-cursor positions for readOutput; the captures themselves are
   * shared with the observed readers and result(). */
  private stdoutCursor = 0;
  private stderrCursor = 0;
  readonly observed: {
    stdout: SubprocessOutputReader;
    stderr: SubprocessOutputReader;
  };
  readonly done: Promise<void>;
  private finish!: () => void;
  private failure: { error: unknown } | undefined;
  private resultPromise: Promise<ShellRunResult> | undefined;

  constructor(
    private readonly spec: ShellExecSpec,
    stdoutMaxBytes: number,
    stderrMaxBytes: number,
    private readonly deps: RemoteShellDeps | undefined,
    private readonly client: RunnerClient | undefined,
    private readonly controller: AbortController | undefined,
  ) {
    this.stdout = new TailBuffer(stdoutMaxBytes);
    this.stderr = new TailBuffer(stderrMaxBytes);
    this.observed = {
      stdout: new TailReader(this.stdout),
      stderr: new TailReader(this.stderr),
    };
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  /** The settled handle an expiry during preparation returns: timed out,
   * empty output, and no process was ever spawned. */
  static expired(spec: ShellExecSpec): RemoteShellProcess {
    const process = new RemoteShellProcess(
      spec,
      0,
      0,
      undefined,
      undefined,
      undefined,
    );
    process.status = "completed";
    process.resultPromise = Promise.resolve(process.depsResult(true));
    process.finish();
    return process;
  }

  private depsResult(timedOut: boolean): ShellRunResult {
    return {
      exitCode: null,
      signal: null,
      timedOut,
      aborted: false,
      timeoutMs: this.spec.timeoutMs,
      stdout: this.stdout.collected(),
      stderr: this.stderr.collected(),
    };
  }

  async spawn(): Promise<void> {
    const started = Date.now();
    try {
      const outcome = await runShell(
        this.client!,
        this.spec,
        combineSignals(this.spec.signal, this.controller!.signal),
        this.stdout,
        this.stderr,
      );
      this.exitCode = outcome.exitCode;
      this.signal = outcome.signal;
      this.status = outcome.signal === null ? "completed" : "killed";
    } catch (error) {
      if (!this.spec.signal?.aborted && !this.deps?.timedOut()) {
        // Infrastructure failure: the read path carries the note, result()
        // carries the rejection.
        this.stderr.append(
          new TextEncoder().encode(`spawn failed: ${String(error)}\n`),
        );
        this.failure = { error };
      } else {
        this.signal = "SIGTERM";
      }
      this.status = "killed";
    } finally {
      this.deps?.clearTimer();
      execDuration.record(Date.now() - started, { kind: "shell" });
      this.finish();
    }
  }

  result(): Promise<ShellRunResult> {
    this.resultPromise ??= new Promise((resolve, reject) => {
      void this.done.then(() => {
        if (this.failure !== undefined) {
          reject(
            this.failure.error instanceof Error
              ? this.failure.error
              : new Error(String(this.failure.error)),
          );
          return;
        }
        const timedOut = this.deps?.timedOut() ?? false;
        resolve({
          exitCode: this.exitCode,
          signal: this.signal,
          timedOut,
          aborted: !timedOut && this.spec.signal?.aborted === true,
          timeoutMs: this.spec.timeoutMs,
          stdout: this.stdout.collected(),
          stderr: this.stderr.collected(),
        });
      });
    });
    return this.resultPromise;
  }

  readOutput(): ShellProcessRead {
    const stdout = this.stdout.readSince(this.stdoutCursor);
    this.stdoutCursor = stdout.nextCursor;
    const stderr = this.stderr.readSince(this.stderrCursor);
    this.stderrCursor = stderr.nextCursor;
    return {
      delta: `${stdout.text}${stderr.text.length === 0 ? "" : `\n[stderr]\n${stderr.text}`}`,
      lossy: stdout.lossy || stderr.lossy,
    };
  }

  kill(): boolean {
    if (this.status !== "running") {
      return false;
    }
    this.controller?.abort(new Error("background process killed"));
    return true;
  }
}

function combineSignals(
  first?: AbortSignal,
  second?: AbortSignal,
): AbortSignal {
  const signals = [first, second].filter(
    (value): value is AbortSignal => value !== undefined,
  );
  return signals.length === 0
    ? new AbortController().signal
    : AbortSignal.any(signals);
}

export const testing = { TailBuffer };
export default SandboxShellExecutor;
