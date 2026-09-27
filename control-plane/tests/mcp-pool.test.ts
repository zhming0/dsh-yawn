import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  McpPool,
  type McpClientConfig,
  type McpMount,
} from "../src/mcp-pool.js";
import { GLOBAL_MCP_SCOPE, McpServerStore } from "../src/mcp-store.js";

/** A mount stand-in whose startup settlement the test controls. */
class FakeMount implements McpMount {
  readonly settled: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  disposed = false;

  constructor(
    readonly config: McpClientConfig,
    readonly ctx: Context,
  ) {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    this.settled = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.resolve = resolve;
    this.reject = reject;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function mountRecorder(): {
  mounts: FakeMount[];
  mount: (config: McpClientConfig, ctx: Context) => McpMount;
} {
  const mounts: FakeMount[] = [];
  return {
    mounts,
    mount: (config, ctx) => {
      const created = new FakeMount(config, ctx);
      mounts.push(created);
      return created;
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A tools registry the test drives directly. `schemas()` is the pool's only
 * view of what a mount published, so tests add and remove names to stand for
 * a client registering and unregistering its tools.
 */
function registryContext(): { ctx: Context; tools: Set<string> } {
  const tools = new Set<string>();
  const ctx = new Context();
  ctx.provide("tools", {
    schemas: () => [...tools].map((name) => ({ name })),
  });
  return { ctx, tools };
}

describe("MCP pool", () => {
  let directory: string;
  let store: McpServerStore;
  let pool: McpPool;
  let mounts: FakeMount[];
  let tools: Set<string>;
  let rootCtx: Context;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-mcp-"));
    store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();
    const recorder = mountRecorder();
    mounts = recorder.mounts;
    const registry = registryContext();
    tools = registry.tools;
    rootCtx = registry.ctx;
    pool = new McpPool({
      ctx: registry.ctx,
      store,
      warn: () => {},
      mount: recorder.mount,
    });
  });

  afterEach(async () => {
    await pool.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it("mounts enabled entries and skips disabled ones", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      token: "alpha-token",
      enabled: true,
    });
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "beta",
      url: "https://beta.example/mcp",
      enabled: false,
    });

    await pool.sync();

    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.config).toEqual({
      transport: "streamable-http",
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      headers: { Authorization: "Bearer alpha-token" },
      toolCallTimeoutMs: 60_000,
      // A live mount rejects on a failed handshake so the row can say so.
      failOnStartupError: true,
      reconnect: {
        enabled: true,
        initialDelayMs: 500,
        maxDelayMs: 30_000,
        maxAttempts: 10,
      },
    });
    expect(pool.views()).toEqual([
      {
        serverName: "alpha",
        url: "https://alpha.example/mcp",
        enabled: true,
        hasToken: true,
        scope: "global",
        status: "starting",
        toolCount: 0,
      },
      {
        serverName: "beta",
        url: "https://beta.example/mcp",
        enabled: false,
        hasToken: false,
        scope: "global",
        status: "disabled",
        toolCount: 0,
      },
    ]);

    // A settled configuration is not remounted by the next reconcile.
    await pool.sync();
    expect(mounts).toHaveLength(1);
    expect(pool.views().map((view) => view.status)).toEqual([
      "starting",
      "disabled",
    ]);
  });

  it("gives every enabled server a status mount and reports scope", async () => {
    const one = "https://github.com/example/one";
    const two = "https://github.com/example/two";
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    await store.upsert(
      { kind: "workspace", repositoryUrl: one },
      {
        serverName: "beta",
        url: "https://beta.example/mcp",
        enabled: true,
      },
    );
    await store.upsert(
      { kind: "workspace", repositoryUrl: two },
      {
        serverName: "gamma",
        url: "https://gamma.example/mcp",
        enabled: false,
      },
    );

    await pool.sync();

    // One status mount per enabled entry, whichever scope it belongs to. The
    // global one mounts at the root, which is what serves it to every
    // session; the workspace one mounts in a scope no session sees.
    expect(mounts.map((mount) => mount.config.serverName)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(mounts[0]?.ctx).toBe(rootCtx);
    expect(mounts[1]?.ctx).not.toBe(rootCtx);
    expect(
      pool
        .views()
        .map((view) => [view.serverName, view.scope, view.repositoryUrl]),
    ).toEqual([
      ["alpha", "global", undefined],
      ["beta", "workspace", one],
      ["gamma", "workspace", two],
    ]);

    // Removing a workspace's server unmounts it; the others stay.
    await store.remove({ kind: "workspace", repositoryUrl: one }, "beta");
    await pool.sync();
    expect(mounts.map((mount) => mount.config.serverName)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(mounts[0]?.disposed).toBe(false);
    expect(mounts[1]?.disposed).toBe(true);
    expect(pool.views().map((view) => view.serverName)).toEqual([
      "alpha",
      "gamma",
    ]);
  });

  it("reports starting, then connected or error as the fiber settles", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "beta",
      url: "https://beta.example/mcp",
      enabled: true,
    });
    await pool.sync();
    expect(pool.views().map((view) => view.status)).toEqual([
      "starting",
      "starting",
    ]);

    // A settled mount only reads as connected while its tools are registered.
    tools.add("mcp__alpha__one");
    mounts[0]?.resolve();
    mounts[1]?.reject(new Error("connection refused"));
    await tick();

    expect(pool.views()[0]).toMatchObject({
      status: "connected",
      toolCount: 1,
    });
    expect(pool.views()[1]).toMatchObject({
      status: "error",
      error: "connection refused",
    });
  });

  it("stops reporting connected once a settled mount loses its tools", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    await pool.sync();
    tools.add("mcp__alpha__one");
    mounts[0]?.resolve();
    await tick();
    expect(pool.views()[0]).toMatchObject({
      status: "connected",
      toolCount: 1,
    });

    // The client unregisters a server's tools when its reconnect budget runs
    // out, and the fiber never settles again, so the registry is the signal.
    tools.clear();
    expect(pool.views()[0]).toMatchObject({ status: "error", toolCount: 0 });
    expect(pool.views()[0]?.error).toContain("no tools are registered");
  });

  it("reports the cause behind a failed mount", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    await pool.sync();

    // The client's own message names no reason; the actionable part is the
    // cause, which is where a 401 or a refused connection sits.
    mounts[0]?.reject(
      new Error(
        "mcp-client(alpha): initial connection or tool synchronization failed",
        { cause: new Error("Streamable HTTP error: 401 Unauthorized") },
      ),
    );
    await tick();

    expect(pool.views()[0]?.error).toBe(
      "mcp-client(alpha): initial connection or tool synchronization failed: " +
        "Streamable HTTP error: 401 Unauthorized",
    );
  });

  it("keeps one mount when syncs overlap", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });

    // The Web page polls while a mount settles, so these overlap in practice.
    await Promise.all([pool.sync(), pool.sync(), pool.sync()]);

    expect(mounts).toHaveLength(1);
    expect(pool.views()[0]).toMatchObject({ status: "starting" });
  });

  it("retry remounts an entry whose tools were unregistered", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    await pool.sync();
    tools.add("mcp__alpha__one");
    mounts[0]?.resolve();
    await tick();
    tools.clear();
    expect(pool.views()[0]).toMatchObject({ status: "error" });

    await pool.retry("alpha");

    // A fresh mount replaces the exhausted one and starts over.
    expect(mounts).toHaveLength(2);
    expect(mounts[0]?.disposed).toBe(true);
    expect(mounts[1]?.config.failOnStartupError).toBe(true);
    expect(pool.views()[0]).toMatchObject({ status: "starting" });

    tools.add("mcp__alpha__one");
    mounts[1]?.resolve();
    await tick();
    expect(pool.views()[0]).toMatchObject({
      status: "connected",
      toolCount: 1,
    });
  });

  it("retry leaves a disabled entry unmounted", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: false,
    });
    await pool.retry("alpha");
    expect(mounts).toHaveLength(0);
    expect(pool.views()[0]).toMatchObject({ status: "disabled" });
  });

  it("replaces a failed mount with a reconnectable one and keeps the error", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    await pool.sync();

    mounts[0]?.reject(new Error("connection refused"));
    await tick();

    // The reconnect mount settles on activation rather than on the handshake.
    expect(mounts).toHaveLength(2);
    expect(mounts[1]?.config.failOnStartupError).toBe(false);
    expect(mounts[0]?.disposed).toBe(false);
    expect(pool.views()).toMatchObject([
      { status: "error", error: "connection refused" },
    ]);

    // Its settlement must not overwrite the failure the row is reporting.
    mounts[1]?.resolve();
    await tick();
    expect(pool.views()).toMatchObject([
      { status: "error", error: "connection refused" },
    ]);
  });

  it("disposes and re-mounts when the URL or token changes", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      token: "one",
      enabled: true,
    });
    await pool.sync();
    expect(mounts).toHaveLength(1);

    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://changed.example/mcp",
      enabled: true,
    });
    await pool.sync();
    expect(mounts).toHaveLength(2);
    expect(mounts[0]?.disposed).toBe(true);
    expect(mounts[1]?.config.url).toBe("https://changed.example/mcp");
    expect(mounts[1]?.config.headers).toEqual({
      Authorization: "Bearer one",
    });

    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://changed.example/mcp",
      token: "two",
      enabled: true,
    });
    await pool.sync();
    expect(mounts).toHaveLength(3);
    expect(mounts[1]?.disposed).toBe(true);
    expect(mounts[2]?.config.headers).toEqual({
      Authorization: "Bearer two",
    });
  });

  it("disposes a mount when its entry is disabled or removed", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    await pool.sync();

    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: false,
    });
    await pool.sync();
    expect(mounts[0]?.disposed).toBe(true);
    expect(pool.views()).toMatchObject([{ status: "disabled" }]);

    await store.remove(GLOBAL_MCP_SCOPE, "alpha");
    await pool.sync();
    expect(pool.views()).toEqual([]);
  });

  it("disposes both fibers when a removed entry had already reconnected", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    await pool.sync();

    // Let the failure settle first, so the entry owns its reconnect mount by
    // the time the removal arrives: disposal must reach both fibers.
    mounts[0]?.reject(new Error("connection refused"));
    await tick();
    expect(mounts).toHaveLength(2);

    await store.remove(GLOBAL_MCP_SCOPE, "alpha");
    await pool.sync();
    await tick();

    expect(mounts.map((mount) => mount.disposed)).toEqual([true, true]);
    expect(pool.views()).toEqual([]);
  });

  it("picks up configuration written by another store instance", async () => {
    const other = new McpServerStore({ path: join(directory, "mcp.json") });
    await other.initialize();
    await other.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });

    await pool.sync();
    expect(mounts).toHaveLength(1);
  });

  it("tests an entry on a disposable probe", async () => {
    const result = pool.testConnection({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      token: "typed",
      enabled: true,
    });

    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.config.serverName).toBe("probe_alpha");
    expect(mounts[0]?.config.failOnStartupError).toBe(true);
    expect(mounts[0]?.config.headers).toEqual({
      Authorization: "Bearer typed",
    });

    mounts[0]?.resolve();
    await expect(result).resolves.toEqual({ ok: true, toolCount: 0 });
    expect(mounts[0]?.disposed).toBe(true);
  });

  it("falls back to the saved token and disposes a failing probe", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      token: "saved",
      enabled: true,
    });

    const result = pool.testConnection({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    expect(mounts[0]?.config.headers).toEqual({
      Authorization: "Bearer saved",
    });

    mounts[0]?.reject(new Error("boom"));
    await expect(result).resolves.toEqual({
      ok: false,
      toolCount: 0,
      error: "boom",
    });
    expect(mounts[0]?.disposed).toBe(true);
  });

  it("probes under a name that does not collide with a live mount", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    await pool.sync();

    const result = pool.testConnection({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    expect(mounts).toHaveLength(2);
    expect(mounts[1]?.config.serverName).toBe("probe_alpha");

    mounts[1]?.resolve();
    await expect(result).resolves.toEqual({ ok: true, toolCount: 0 });
    expect(mounts[1]?.disposed).toBe(true);
  });

  it("rejects an invalid test entry without mounting", async () => {
    await expect(
      pool.testConnection({
        serverName: "bad name",
        url: "https://alpha.example/mcp",
        enabled: true,
      }),
    ).rejects.toThrow("invalid MCP server name");
    expect(mounts).toEqual([]);
  });

  it("disposes every live mount", async () => {
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "beta",
      url: "https://beta.example/mcp",
      enabled: true,
    });
    await pool.sync();

    await pool.dispose();
    expect(mounts.map((mount) => mount.disposed)).toEqual([true, true]);
  });

  describe("session mounts", () => {
    const one = "https://github.com/example/one";
    const two = "https://github.com/example/two";

    beforeEach(async () => {
      await store.upsert(GLOBAL_MCP_SCOPE, {
        serverName: "alpha",
        url: "https://alpha.example/mcp",
        enabled: true,
      });
      await store.upsert(
        { kind: "workspace", repositoryUrl: one },
        { serverName: "beta", url: "https://beta.example/mcp", enabled: true },
      );
      await store.upsert(
        { kind: "workspace", repositoryUrl: two },
        {
          serverName: "gamma",
          url: "https://gamma.example/mcp",
          enabled: false,
        },
      );
      await pool.sync();
    });

    /** Mounts started through one agent's context, by server name. */
    function mountsIn(ctx: Context): FakeMount[] {
      return mounts.filter((mount) => mount.ctx === ctx);
    }

    /** Attach an agent and settle whatever it mounted. */
    async function attach(
      agentId: string,
      repositoryUrl: string | undefined,
    ): Promise<Context> {
      const ctx = new Context();
      const attached = pool.attachAgent(agentId, ctx, repositoryUrl);
      await tick();
      for (const mount of mountsIn(ctx)) {
        mount.resolve();
      }
      await attached;
      return ctx;
    }

    it("mounts a workspace's servers inside that workspace's agents only", async () => {
      const inOne = await attach("agent-one", `${one}.git`);
      const inTwo = await attach("agent-two", two);
      const inNone = await attach("agent-none", undefined);

      // The global server is never mounted per agent: the root serves it.
      expect(mountsIn(inOne).map((mount) => mount.config)).toEqual([
        expect.objectContaining({
          serverName: "beta",
          url: "https://beta.example/mcp",
          // A session must not fail to start because a server is down.
          failOnStartupError: false,
        }),
      ]);
      expect(mountsIn(inTwo)).toEqual([]);
      expect(mountsIn(inNone)).toEqual([]);
    });

    it("waits for a new agent's mounts before its first step", async () => {
      const ctx = new Context();
      let done = false;
      const attached = pool
        .attachAgent("agent-one", ctx, one)
        .then(() => (done = true));
      await tick();
      expect(done).toBe(false);
      mountsIn(ctx)[0]?.reject(new Error("refused"));
      await attached;
      expect(done).toBe(true);
    });

    it("follows store edits for attached agents", async () => {
      const inOne = await attach("agent-one", one);
      const inTwo = await attach("agent-two", two);

      await store.upsert(
        { kind: "workspace", repositoryUrl: two },
        {
          serverName: "gamma",
          url: "https://gamma.example/mcp",
          enabled: true,
        },
      );
      await store.upsert(
        { kind: "workspace", repositoryUrl: one },
        { serverName: "beta", url: "https://beta.example/v2", enabled: true },
      );
      await pool.sync();

      expect(mountsIn(inTwo).map((mount) => mount.config.serverName)).toEqual([
        "gamma",
      ]);
      const [before, after] = mountsIn(inOne);
      expect(before?.disposed).toBe(true);
      expect(after?.config.url).toBe("https://beta.example/v2");

      await store.remove({ kind: "workspace", repositoryUrl: one }, "beta");
      await pool.sync();
      expect(after?.disposed).toBe(true);
    });

    it("disposes an agent's mounts on detach, and restarts them on retry", async () => {
      const first = await attach("agent-one", one);
      const second = await attach("agent-two", one);

      await pool.retry("beta");
      expect(mountsIn(first).map((mount) => mount.disposed)).toEqual([
        true,
        false,
      ]);

      await pool.detachAgent("agent-one", first);
      expect(mountsIn(first).every((mount) => mount.disposed)).toBe(true);
      expect(mountsIn(second).at(-1)?.disposed).toBe(false);

      await pool.dispose();
      expect(mountsIn(second).every((mount) => mount.disposed)).toBe(true);
    });

    it("records nothing for an agent disposed before its attach ran", async () => {
      // The manager resolves the workspace before attaching, so a short-lived
      // subagent's detach can arrive first.
      const ctx = new Context();
      await pool.detachAgent("agent-one", ctx);
      await pool.attachAgent("agent-one", ctx, one);
      expect(mountsIn(ctx)).toEqual([]);

      // Later syncs must not mount into its disposed scope either.
      await store.upsert(
        { kind: "workspace", repositoryUrl: one },
        {
          serverName: "delta",
          url: "https://delta.example/mcp",
          enabled: true,
        },
      );
      await pool.sync();
      expect(mountsIn(ctx)).toEqual([]);
    });

    it("keeps a resumed agent when the old one's detach arrives late", async () => {
      const old = await attach("agent-one", one);
      const resumed = await attach("agent-one", one);

      await pool.detachAgent("agent-one", old);
      await store.upsert(
        { kind: "workspace", repositoryUrl: one },
        {
          serverName: "delta",
          url: "https://delta.example/mcp",
          enabled: true,
        },
      );
      await pool.sync();

      expect(mountsIn(resumed).map((mount) => mount.config.serverName)).toEqual(
        ["beta", "delta"],
      );
      expect(mountsIn(resumed).every((mount) => !mount.disposed)).toBe(true);
    });
  });
});
