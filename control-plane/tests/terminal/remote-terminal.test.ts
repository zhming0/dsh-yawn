import { describe, expect, it } from "vitest";

import type {
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";

import {
  TerminalActivityState,
  TerminalQueryKind,
} from "../../src/gen/dsh/yawn/v1/terminal_pb.js";
import type { RunnerClient } from "../../src/runner-client.js";
import { TerminalPool } from "../../src/terminal/remote-terminal.js";

const SESSION_WORKSPACE = "/data/.dsh-yawn/workspace-anchors/owner-repo";
const SANDBOX_WORKSPACE = "/workspace/repository";

/** The path frames the seam hands a terminal, the way it does in production. */
const FRAME = {
  sessionWorkspace: SESSION_WORKSPACE,
  sandboxWorkspace: SANDBOX_WORKSPACE,
};

const pool = new TerminalPool();

/** Allocate one terminal the way `SandboxSubprocessRuntime.spawnTerminal` does. */
function spawnTerminal(
  runner: FakeTerminalRunner,
  spec: SubprocessTerminalSpawnSpec,
): Promise<SubprocessTerminalHandle> {
  return pool.spawn(Promise.resolve(runner.client), spec, FRAME);
}

interface TerminalRequestRecord {
  control: {
    case: string;
    value: unknown;
  };
}

type TerminalResponseRecord = {
  event: { case: string; value: unknown };
};

interface FakeTerminalRunner {
  readonly client: RunnerClient;
  readonly requests: TerminalRequestRecord[];
  readonly responses: ResponseQueue;
  readonly requestEnded: Promise<void>;
  readonly allocation: () => AbortSignal | undefined;
}

/** A pull-based response stream the test pushes into. */
class ResponseQueue implements AsyncIterable<TerminalResponseRecord> {
  private readonly buffered: TerminalResponseRecord[] = [];
  private waiting:
    | {
        resolve: (result: IteratorResult<TerminalResponseRecord>) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  private ended = false;
  private failure: Error | undefined;

  push(response: TerminalResponseRecord): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    if (waiting === undefined) {
      this.buffered.push(response);
      return;
    }
    waiting.resolve({ done: false, value: response });
  }

  end(): void {
    this.ended = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.resolve({ done: true, value: undefined as never });
  }

  fail(error: Error): void {
    this.failure = error;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.reject(error);
  }

  private next(): Promise<IteratorResult<TerminalResponseRecord>> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) {
      return Promise.resolve({ done: false, value: buffered });
    }
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (this.ended) {
      return Promise.resolve({ done: true, value: undefined as never });
    }
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<TerminalResponseRecord> {
    return {
      next: () => this.next(),
      return: () => {
        this.end();
        return Promise.resolve({ done: true, value: undefined as never });
      },
    };
  }
}

/** A runner client whose terminal RPC is driven by the test. */
function fakeTerminalRunner(): FakeTerminalRunner {
  const requests: TerminalRequestRecord[] = [];
  const responses = new ResponseQueue();
  let markEnded: () => void = () => {};
  const requestEnded = new Promise<void>((resolve) => {
    markEnded = resolve;
  });
  let allocationSignal: AbortSignal | undefined;
  const client = {
    terminals: {
      terminal: async function* (
        request: AsyncIterable<TerminalRequestRecord>,
        options?: { signal?: AbortSignal },
      ) {
        allocationSignal = options?.signal;
        void (async () => {
          for await (const message of request) {
            requests.push(message);
          }
          markEnded();
        })();
        for await (const response of responses) {
          yield response;
        }
      },
    },
  } as unknown as RunnerClient;
  return {
    client,
    requests,
    responses,
    requestEnded,
    allocation: () => allocationSignal,
  };
}

function startedEvent(pid: number): TerminalResponseRecord {
  return { event: { case: "started", value: { pid: BigInt(pid) } } };
}

function outputEvent(text: string): TerminalResponseRecord {
  return {
    event: { case: "output", value: new TextEncoder().encode(text) },
  };
}

function exitedEvent(exitCode: number, signal = ""): TerminalResponseRecord {
  return { event: { case: "exited", value: { exitCode, signal } } };
}

function closedEvent(): TerminalResponseRecord {
  return { event: { case: "closed", value: {} } };
}

function terminalSpec(
  overrides: Partial<SubprocessTerminalSpawnSpec> = {},
): SubprocessTerminalSpawnSpec {
  return {
    argv: ["/bin/bash"],
    cwd: SANDBOX_WORKSPACE,
    rows: 24,
    cols: 80,
    terminalType: "xterm-256color",
    graceMs: 1000,
    env: { DSH_SESSION_ID: "session-one" },
    ...overrides,
  };
}

/** Let the handle's serialized control chain reach the request stream. */
function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function lastRequest(runner: FakeTerminalRunner): TerminalRequestRecord {
  return runner.requests[runner.requests.length - 1]!;
}

describe("sandbox terminal seam", () => {
  it("allocates a terminal and translates session-frame paths", async () => {
    const runner = fakeTerminalRunner();
    const spawning = spawnTerminal(
      runner,
      terminalSpec({
        argv: ["/bin/bash", `${SESSION_WORKSPACE}/profile.sh`],
        cwd: `${SESSION_WORKSPACE}/src`,
      }),
    );
    runner.responses.push(startedEvent(7));
    const handle = await spawning;

    expect(handle.pid).toBe(7);
    expect(runner.requests[0]).toEqual({
      control: {
        case: "start",
        value: {
          argv: ["/bin/bash", `${SANDBOX_WORKSPACE}/profile.sh`],
          cwd: `${SANDBOX_WORKSPACE}/src`,
          env: { DSH_SESSION_ID: "session-one" },
          rows: 24,
          cols: 80,
          terminalType: "xterm-256color",
          graceMs: 1000,
        },
      },
    });

    const terminating = handle.terminate();
    runner.responses.push(exitedEvent(0));
    runner.responses.end();
    await terminating;
  });

  it("streams output and resolves the exit facts", async () => {
    const runner = fakeTerminalRunner();
    const spawning = spawnTerminal(runner, terminalSpec());
    runner.responses.push(startedEvent(11));
    const handle = await spawning;

    runner.responses.push(outputEvent("hello "));
    runner.responses.push(outputEvent("terminal"));
    runner.responses.push(exitedEvent(3));
    runner.responses.end();

    await expect(handle.done).resolves.toEqual({
      exitCode: 3,
      signal: null,
    });
    await expect(collect(handle.output)).resolves.toBe("hello terminal");
    await handle.terminate();
  });

  it("sends input, resize, queries, and signals in order", async () => {
    const runner = fakeTerminalRunner();
    const spawning = spawnTerminal(runner, terminalSpec());
    runner.responses.push(startedEvent(12));
    const handle = await spawning;

    await handle.write("echo hi\n");
    expect(lastRequest(runner)).toEqual({
      control: { case: "input", value: new TextEncoder().encode("echo hi\n") },
    });

    await handle.resize(100, 40);
    expect(lastRequest(runner)).toEqual({
      control: { case: "resize", value: { cols: 100, rows: 40 } },
    });

    const foreground = handle.inspectForeground();
    await settled();
    expect(lastRequest(runner)).toEqual({
      control: {
        case: "query",
        value: { kind: TerminalQueryKind.FOREGROUND },
      },
    });
    runner.responses.push({
      event: {
        case: "foreground",
        value: { present: true, processGroupId: 42, inputWaiting: false },
      },
    });
    await expect(foreground).resolves.toEqual({
      processGroupId: 42,
      inputWaiting: false,
    });

    const activity = handle.inspectActivity();
    await settled();
    runner.responses.push({
      event: {
        case: "activity",
        value: { state: TerminalActivityState.BUSY },
      },
    });
    await expect(activity).resolves.toEqual({ state: "busy", revision: 1 });
    const stillBusy = handle.inspectActivity();
    await settled();
    runner.responses.push({
      event: {
        case: "activity",
        value: { state: TerminalActivityState.BUSY },
      },
    });
    await expect(stillBusy).resolves.toEqual({ state: "busy", revision: 1 });

    const signaled = handle.signalForeground("SIGINT");
    await settled();
    expect(lastRequest(runner)).toEqual({
      control: { case: "signal", value: "SIGINT" },
    });
    runner.responses.push({ event: { case: "signaled", value: 42 } });
    await expect(signaled).resolves.toBe(42);

    const terminating = handle.terminate();
    runner.responses.push(exitedEvent(0));
    runner.responses.end();
    await terminating;
  });

  it("reports no foreground group and refuses an unanswered signal", async () => {
    const runner = fakeTerminalRunner();
    const spawning = spawnTerminal(runner, terminalSpec());
    runner.responses.push(startedEvent(13));
    const handle = await spawning;

    const foreground = handle.inspectForeground();
    await settled();
    runner.responses.push({
      event: {
        case: "foreground",
        value: { present: false, processGroupId: 0, inputWaiting: false },
      },
    });
    await expect(foreground).resolves.toBeUndefined();

    const signaled = handle.signalForeground("SIGKILL");
    await settled();
    runner.responses.push({ event: { case: "signaled", value: 0 } });
    await expect(signaled).rejects.toThrow("no foreground process group");

    const terminating = handle.terminate();
    runner.responses.push(exitedEvent(0));
    runner.responses.end();
    await terminating;
  });

  it("ends output and the request stream when the runner reports closed", async () => {
    const runner = fakeTerminalRunner();
    const spawning = spawnTerminal(runner, terminalSpec());
    runner.responses.push(startedEvent(17));
    const handle = await spawning;

    runner.responses.push(outputEvent("bye"));
    runner.responses.push(exitedEvent(0));
    runner.responses.push(closedEvent());
    await runner.requestEnded;
    runner.responses.end();

    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null });
    await expect(collect(handle.output)).resolves.toBe("bye");
    await expect(handle.inspectActivity()).resolves.toEqual({
      state: "idle",
      revision: 1,
    });
    await expect(handle.inspectForeground()).resolves.toBeUndefined();
    await handle.terminate();
    await expect(handle.write("late\n")).rejects.toThrow("terminal is closed");
  });

  it("terminates by ending the request stream", async () => {
    const runner = fakeTerminalRunner();
    const spawning = spawnTerminal(runner, terminalSpec());
    runner.responses.push(startedEvent(14));
    const handle = await spawning;

    const terminating = handle.terminate();
    await runner.requestEnded;
    runner.responses.push(exitedEvent(0));
    runner.responses.end();
    await terminating;

    // A second terminate is a no-op on the same session.
    await handle.terminate();
  });

  it("rejects the allocation when the runner cannot start the terminal", async () => {
    const runner = fakeTerminalRunner();
    const spawning = spawnTerminal(runner, terminalSpec());
    runner.responses.fail(new Error("pty allocation failed"));

    await expect(spawning).rejects.toThrow("pty allocation failed");
    // A failed allocation still releases whatever the runner created.
    await runner.requestEnded;
  });

  it("keeps a published terminal alive when the allocation signal aborts", async () => {
    const runner = fakeTerminalRunner();
    const allocation = new AbortController();
    const spawning = spawnTerminal(
      runner,
      terminalSpec({ signal: allocation.signal }),
    );
    runner.responses.push(startedEvent(15));
    const handle = await spawning;

    allocation.abort(new Error("request cancelled"));
    expect(runner.allocation()?.aborted).toBe(false);
    await handle.write("still here\n");
    expect(lastRequest(runner)).toMatchObject({
      control: { case: "input" },
    });

    const terminating = handle.terminate();
    runner.responses.push(exitedEvent(0));
    runner.responses.end();
    await terminating;
  });

  it("fails the handle when the transport dies", async () => {
    const runner = fakeTerminalRunner();
    const spawning = spawnTerminal(runner, terminalSpec());
    runner.responses.push(startedEvent(16));
    const handle = await spawning;

    runner.responses.fail(new Error("runner tunnel closed"));
    await expect(handle.done).rejects.toThrow("runner tunnel closed");
    await expect(handle.write("lost\n")).rejects.toThrow("terminal is closed");
    await expect(collect(handle.output)).rejects.toThrow(
      "runner tunnel closed",
    );
  });
});
