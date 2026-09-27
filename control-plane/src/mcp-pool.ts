import type { Context } from "@deepseek-ai/cordis";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import { createScope, type Scope } from "@deepseek-ai/dsh-scope";

import type { McpServerView, McpTestResult } from "./mcp-remote.js";
import type { McpServerEntry, McpServerStore } from "./mcp-store.js";
import { validateMcpServerEntry } from "./mcp-store.js";

/** A connection test may wait this long for the MCP handshake. */
const testTimeoutMs = 15_000;

/**
 * A new agent waits at most this long for its workspace's servers before its
 * first step. A server that answers later still publishes its tools, and the
 * agent sees them from the step after that.
 */
const agentMountWaitMs = 10_000;

/**
 * Reported when a mount settled and later lost every tool. The mcp-client
 * unregisters a server's tools once its reconnect budget runs out, and its
 * fiber never settles again, so the registry is the only signal left.
 */
const noToolsRegistered =
  "no tools are registered — the connection was lost or the server advertises none";

export type McpClientConfig = mcpClient.StreamableHttpConfig;

/** The part of a Cordis fiber this pool uses: startup settlement and disposal. */
export interface McpMount {
  settled: PromiseLike<void>;
  dispose(): Promise<void>;
}

export interface McpPoolOptions {
  ctx: Context;
  store: McpServerStore;
  warn: (message: string) => void;
  /**
   * Replacement client mount for tests; defaults to a real Cordis fiber
   * started through `ctx`, whose scope decides who sees what it registers.
   */
  mount?: (config: McpClientConfig, ctx: Context) => McpMount;
}

interface LiveMount {
  entry: McpServerEntry;
  token: string | undefined;
  /**
   * Every fiber this entry started, in start order. A failed first mount can
   * be replaced by a reconnect mount, so the entry has to keep the first one
   * to dispose rather than dropping it in favour of its replacement.
   */
  fibers: Set<McpMount>;
  status: "starting" | "connected" | "error";
  error?: string;
  /** Set the moment the entry stops being wanted, before any await. */
  retired: boolean;
  /**
   * The private scope a workspace server's status mount lives in. No agent
   * scope descends from it, so nothing it registers reaches a session.
   * Undefined for a global server, which mounts at the root.
   */
  scope: PrivateScope | undefined;
}

interface PrivateScope {
  key: object;
  scope: Scope;
}

/** One workspace server mounted inside one agent's scope. */
interface AgentServerMount {
  url: string;
  token: string | undefined;
  fiber: McpMount;
}

interface AttachedAgent {
  /** The agent's scoped context; mounts started through it are its alone. */
  ctx: Context;
  repositoryUrl: string | undefined;
  servers: Map<string, AgentServerMount>;
}

/**
 * Owns the live mcp-client mounts for the stored servers. One mount is one
 * Cordis fiber; reconciling against the store mounts, disposes, and remounts
 * as the configuration changes, without ever blocking on a server handshake.
 *
 * Where a mount starts decides who sees it: mcp-client registers its tools,
 * resource provider, and instructions in the scope of the context that
 * mounted it. A global server mounts once at the root, so every agent sees
 * it. A workspace server mounts once inside each attached agent of that
 * workspace, so no other session sees its tools, resources, or instructions,
 * plus once in a private scope nobody sees, which drives its status row.
 */
export class McpPool {
  private readonly ctx: Context;
  private readonly store: McpServerStore;
  private readonly warn: (message: string) => void;
  private readonly mount: (config: McpClientConfig, ctx: Context) => McpMount;
  private readonly mounts = new Map<string, LiveMount>();
  private readonly agents = new Map<string, AttachedAgent>();
  /**
   * Contexts of agents already disposed. Keyed by context, not id: a resumed
   * session reuses its agent id, and its new agent must still attach.
   */
  private readonly detached = new WeakSet<Context>();
  /** Probe names in flight; they are not store entries, so sync ignores them. */
  private readonly probes = new Set<string>();
  /** Serializes mount changes; see {@link serialize}. */
  private chain: Promise<unknown> = Promise.resolve();
  private probeCount = 0;

  constructor(options: McpPoolOptions) {
    this.ctx = options.ctx;
    this.store = options.store;
    this.warn = options.warn;
    this.mount = options.mount ?? ((config, ctx) => mountClient(ctx, config));
  }

  /** Reconcile every live mount with the stored configuration. */
  async sync(): Promise<void> {
    await this.serialize(() => this.reconcile());
  }

  /**
   * Run one mount-changing operation at a time. Callers reconcile on every
   * list, and the Web page polls while a mount settles, so two runs could
   * otherwise interleave a dispose with a mount for the same server.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reconcile(): Promise<void> {
    await this.store.refresh();
    // Every enabled entry gets a status mount: global ones at the root, which
    // is also what serves them, workspace ones in a private scope.
    const wanted = new Map(
      this.store
        .entries()
        .filter(({ entry }) => entry.enabled)
        .map(({ entry }) => [entry.serverName, entry]),
    );
    for (const [serverName, live] of [...this.mounts]) {
      const entry = wanted.get(serverName);
      if (
        entry === undefined ||
        live.entry.url !== entry.url ||
        live.token !== this.store.tokenFor(serverName)
      ) {
        await this.unmount(serverName);
      }
    }
    for (const entry of wanted.values()) {
      if (this.mounts.has(entry.serverName)) {
        continue;
      }
      this.mountEntry(entry);
    }
    const stale = [...this.agents.values()].flatMap(
      (agent) => this.reconcileAgent(agent).stale,
    );
    await disposeAll(stale);
  }

  /**
   * Mount a new agent's workspace servers inside its scope, and wait for them
   * (up to {@link agentMountWaitMs}) so the agent's first step already lists
   * their tools. The loop assembles a step's tools and prompt before any
   * per-step hook runs, so this has to happen when the agent is created.
   */
  async attachAgent(
    agentId: string,
    ctx: Context,
    repositoryUrl: string | undefined,
  ): Promise<void> {
    const started = await this.serialize(async () => {
      // The caller resolves the workspace before getting here, and a
      // short-lived subagent can be disposed in that gap; recording it would
      // keep mounting into a dead scope on every later sync.
      if (this.detached.has(ctx)) {
        return [];
      }
      const previous = this.agents.get(agentId);
      this.agents.delete(agentId);
      await disposeAll(
        [...(previous?.servers.values() ?? [])].map(({ fiber }) => fiber),
      );
      const agent: AttachedAgent = { ctx, repositoryUrl, servers: new Map() };
      this.agents.set(agentId, agent);
      return this.reconcileAgent(agent).started;
    });
    // mcp-client settles after its first connection attempt either way; a
    // server that hangs is cut off here and keeps connecting in the
    // background.
    await Promise.race([
      Promise.allSettled(started.map((fiber) => fiber.settled)),
      new Promise((resolve) => setTimeout(resolve, agentMountWaitMs).unref()),
    ]);
  }

  /**
   * Forget a disposed agent; its scope already took its mounts down. Marked
   * before queueing, so an attach still in flight for it records nothing.
   */
  async detachAgent(agentId: string, ctx: Context): Promise<void> {
    this.detached.add(ctx);
    await this.serialize(async () => {
      const agent = this.agents.get(agentId);
      // A resumed session may already have attached a new agent under the
      // same id; that one is not this detach's to remove.
      if (agent?.ctx !== ctx) {
        return;
      }
      this.agents.delete(agentId);
      await disposeAll([...agent.servers.values()].map(({ fiber }) => fiber));
    });
  }

  /**
   * Bring one agent's mounts in line with its workspace's enabled servers.
   * Returns the fibers it started and the ones the caller must dispose.
   */
  private reconcileAgent(agent: AttachedAgent): {
    started: McpMount[];
    stale: McpMount[];
  } {
    const wanted =
      agent.repositoryUrl === undefined
        ? []
        : this.store
            .list({ kind: "workspace", repositoryUrl: agent.repositoryUrl })
            .filter((entry) => entry.enabled);
    const wantedByName = new Map(
      wanted.map((entry) => [entry.serverName, entry]),
    );
    const stale: McpMount[] = [];
    for (const [serverName, mounted] of [...agent.servers]) {
      const entry = wantedByName.get(serverName);
      if (
        entry === undefined ||
        mounted.url !== entry.url ||
        mounted.token !== this.store.tokenFor(serverName)
      ) {
        agent.servers.delete(serverName);
        stale.push(mounted.fiber);
      }
    }
    const started: McpMount[] = [];
    for (const entry of wanted) {
      if (agent.servers.has(entry.serverName)) {
        continue;
      }
      const token = this.store.tokenFor(entry.serverName);
      try {
        // Reconnecting and never rejecting: a session must not fail to start
        // because one server is down, and the status row already reports it.
        const fiber = this.mount(
          buildConfig(entry.serverName, entry.url, token, false),
          agent.ctx,
        );
        agent.servers.set(entry.serverName, { url: entry.url, token, fiber });
        started.push(fiber);
      } catch (reason) {
        this.warn(
          `MCP client for ${entry.serverName} could not mount in a session: ${describe(reason)}`,
        );
      }
    }
    return { started, stale };
  }

  /** Browser-facing status for every stored server, in every scope. */
  views(): McpServerView[] {
    return this.store.entries().map(({ entry, scope }) => {
      const live = this.mounts.get(entry.serverName);
      const toolCount =
        live === undefined
          ? 0
          : this.toolCount(entry.serverName, live.scope?.key);
      // Tools in the registry outrank a recorded failure: a reconnect that
      // succeeded after the first handshake failed publishes its tools
      // without settling anything, and the row must stop reporting the old
      // error once that happens. The reverse holds too — a mount that settled
      // and then lost its tools is one whose reconnect budget ran out, and
      // calling that connected is the same "connected, no tools" lie the
      // two-phase mount exists to avoid.
      const status =
        live === undefined
          ? "disabled"
          : toolCount > 0
            ? "connected"
            : live.status === "connected"
              ? "error"
              : live.status;
      const error =
        status === "error" ? (live?.error ?? noToolsRegistered) : undefined;
      return {
        serverName: entry.serverName,
        url: entry.url,
        enabled: entry.enabled,
        hasToken: this.store.tokenFor(entry.serverName) !== undefined,
        scope: scope.kind,
        ...(scope.kind === "workspace"
          ? { repositoryUrl: scope.repositoryUrl }
          : {}),
        status,
        toolCount: status === "connected" ? toolCount : 0,
        ...(error === undefined ? {} : { error }),
      };
    });
  }

  /**
   * Remount one server, so a row can recover after its reconnect budget ran
   * out. Its session mounts restart too, since they share the same budget.
   */
  async retry(serverName: string): Promise<void> {
    await this.serialize(async () => {
      await this.unmount(serverName);
      const stale: McpMount[] = [];
      for (const agent of this.agents.values()) {
        const mounted = agent.servers.get(serverName);
        if (mounted !== undefined) {
          agent.servers.delete(serverName);
          stale.push(mounted.fiber);
        }
      }
      await disposeAll(stale);
      const entry = this.store.get(serverName);
      if (entry !== undefined && entry.enabled) {
        this.mountEntry(entry);
      }
      for (const agent of this.agents.values()) {
        this.reconcileAgent(agent);
      }
    });
  }

  /**
   * Try one unsaved configuration; the probe never outlives the call. It
   * mounts in a private scope, so no session sees its tools or its token.
   */
  async testConnection(entry: McpServerEntry): Promise<McpTestResult> {
    validateMcpServerEntry(entry);
    const token =
      entry.token === null
        ? undefined
        : entry.token === undefined || entry.token === ""
          ? this.store.tokenFor(entry.serverName)
          : entry.token;
    const probeName = this.probeName(entry.serverName);
    const { key, scope } = this.privateScope();
    let fiber: McpMount | undefined;
    try {
      fiber = this.mount(
        buildConfig(probeName, entry.url, token, true),
        scope.ctx,
      );
      await withTimeout(fiber.settled, testTimeoutMs);
      return { ok: true, toolCount: this.toolCount(probeName, key) };
    } catch (reason) {
      return { ok: false, toolCount: 0, error: describe(reason) };
    } finally {
      this.probes.delete(probeName);
      try {
        await fiber?.dispose();
        await scope.dispose();
      } catch (reason) {
        this.warn(
          `MCP test client for ${entry.serverName} failed to dispose: ${describe(reason)}`,
        );
      }
    }
  }

  /** Dispose every live mount; one failure does not strand the others. */
  async dispose(): Promise<void> {
    const names = [...this.mounts.keys()];
    const agents = [...this.agents];
    const results = await Promise.allSettled([
      ...names.map((serverName) => this.unmount(serverName)),
      ...agents.map(([agentId, { ctx }]) => this.detachAgent(agentId, ctx)),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        this.warn(
          `MCP client mount failed to dispose: ${describe(result.reason)}`,
        );
      }
    }
  }

  private mountEntry(entry: McpServerEntry): void {
    const token = this.store.tokenFor(entry.serverName);
    const global = this.store
      .list({ kind: "global" })
      .some((candidate) => candidate.serverName === entry.serverName);
    const live: LiveMount = {
      entry,
      token,
      fibers: new Set(),
      status: "starting",
      retired: false,
      scope: global ? undefined : this.privateScope(),
    };
    try {
      // The first mount rejects on a failed handshake, which is the only
      // signal that tells a dead server from a live one. Without it a broken
      // server would settle and be reported as connected with zero tools.
      this.startMount(
        live,
        buildConfig(entry.serverName, entry.url, token, true),
      );
    } catch (reason) {
      live.status = "error";
      live.error = describe(reason);
    }
    this.mounts.set(entry.serverName, live);
    const first = [...live.fibers][0];
    if (first === undefined) {
      return;
    }
    // Settlement must stay off the mounting path; a server handshake can take
    // the MCP SDK's full request timeout.
    void first.settled.then(
      () => {
        live.status = "connected";
      },
      (reason: unknown) => {
        live.status = "error";
        live.error = describe(reason);
        this.retryAfterFailure(entry.serverName, live);
      },
    );
  }

  /** Mount one fiber for an entry and record it for disposal. */
  private startMount(live: LiveMount, config: McpClientConfig): void {
    const fiber = this.mount(config, live.scope?.scope.ctx ?? this.ctx);
    live.fibers.add(fiber);
  }

  /**
   * Replace a failed first mount with a reconnectable one so a server that is
   * briefly unreachable still recovers on its own. The replacement settles
   * immediately (it reports startup errors rather than rejecting), so the
   * failed status stays on screen instead of being overwritten by it.
   */
  private retryAfterFailure(serverName: string, live: LiveMount): void {
    if (live.retired || this.mounts.get(serverName) !== live) {
      return;
    }
    try {
      this.startMount(
        live,
        buildConfig(serverName, live.entry.url, live.token, false),
      );
    } catch (reason) {
      this.warn(
        `MCP client for ${serverName} could not start a reconnect mount: ${describe(reason)}`,
      );
    }
  }

  private async unmount(serverName: string): Promise<void> {
    const live = this.mounts.get(serverName);
    if (live === undefined) {
      return;
    }
    // Retire and clear before the await: a mount whose handshake fails while
    // this disposal is in flight must not start a replacement nothing owns.
    live.retired = true;
    this.mounts.delete(serverName);
    await Promise.allSettled([...live.fibers].map((fiber) => fiber.dispose()));
    await live.scope?.scope.dispose();
  }

  /** A scope with no parent link: no agent's view includes what it holds. */
  private privateScope(): PrivateScope {
    const key = {};
    return { key, scope: createScope(this.ctx, key) };
  }

  /**
   * The probe counts its tools by name prefix in a view that also holds the
   * root's global tools, so it takes a name no real server uses.
   */
  private probeName(serverName: string): string {
    let name = `probe_${serverName}`.slice(0, 32);
    while (this.mounts.has(name) || this.probes.has(name)) {
      this.probeCount += 1;
      name = `probe_${this.probeCount.toString(36)}`;
    }
    this.probes.add(name);
    return name;
  }

  /**
   * Count the tools a mount published, when the registry is reachable. A
   * scoped mount's tools are only in its scope's view.
   */
  private toolCount(serverName: string, scopeKey?: object): number {
    const tools = this.ctx.get("tools") as
      | { schemas(scope?: object): Array<{ name: string }> }
      | undefined;
    if (tools === undefined) {
      return 0;
    }
    const prefix = `mcp__${serverName}__`;
    try {
      return tools
        .schemas(scopeKey)
        .filter((tool) => tool.name.startsWith(prefix)).length;
    } catch {
      return 0;
    }
  }
}

function mountClient(ctx: Context, config: McpClientConfig): McpMount {
  const fiber = ctx.plugin(mcpClient, config);
  return {
    settled: fiber.then(() => undefined),
    dispose: () => fiber.dispose(),
  };
}

async function disposeAll(fibers: McpMount[]): Promise<void> {
  await Promise.allSettled(fibers.map((fiber) => fiber.dispose()));
}

function buildConfig(
  serverName: string,
  url: string,
  token: string | undefined,
  failOnStartupError: boolean,
): McpClientConfig {
  return {
    transport: "streamable-http",
    serverName,
    url,
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    toolCallTimeoutMs: 60_000,
    failOnStartupError,
    reconnect: {
      enabled: true,
      initialDelayMs: 500,
      maxDelayMs: 30_000,
      maxAttempts: 10,
    },
  };
}

function withTimeout<T>(value: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`MCP connection test timed out after ${ms} ms`));
    }, ms);
    Promise.resolve(value).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
    );
  });
}

/**
 * Flatten an error and its causes. A failed mount reports only "initial
 * connection or tool synchronization failed" at the top, and the reason a user
 * can act on — a 401, a refused connection — is the cause beneath it.
 */
function describe(reason: unknown): string {
  if (!(reason instanceof Error)) {
    return String(reason);
  }
  const parts = [reason.message];
  const seen = new Set<unknown>([reason]);
  let cause: unknown = reason.cause;
  while (cause instanceof Error && !seen.has(cause) && parts.length < 5) {
    seen.add(cause);
    parts.push(cause.message);
    cause = cause.cause;
  }
  return parts.join(": ");
}
