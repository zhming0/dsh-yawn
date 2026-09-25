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
import { McpServerStore } from "../src/mcp-store.js";

/** A mount stand-in whose startup settlement the test controls. */
class FakeMount implements McpMount {
  readonly settled: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  disposed = false;

  constructor(readonly config: McpClientConfig) {
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
  mount: (config: McpClientConfig) => McpMount;
} {
  const mounts: FakeMount[] = [];
  return {
    mounts,
    mount: (config) => {
      const created = new FakeMount(config);
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

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-mcp-"));
    store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();
    const recorder = mountRecorder();
    mounts = recorder.mounts;
    const registry = registryContext();
    tools = registry.tools;
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
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      token: "alpha-token",
      enabled: true,
    });
    await store.upsert({
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
        status: "starting",
        toolCount: 0,
      },
      {
        serverName: "beta",
        url: "https://beta.example/mcp",
        enabled: false,
        hasToken: false,
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

  it("reports starting, then connected or error as the fiber settles", async () => {
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    await store.upsert({
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
    await store.upsert({
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
    await store.upsert({
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
    await store.upsert({
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
    await store.upsert({
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
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: false,
    });
    await pool.retry("alpha");
    expect(mounts).toHaveLength(0);
    expect(pool.views()[0]).toMatchObject({ status: "disabled" });
  });

  it("replaces a failed mount with a reconnectable one and keeps the error", async () => {
    await store.upsert({
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
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      token: "one",
      enabled: true,
    });
    await pool.sync();
    expect(mounts).toHaveLength(1);

    await store.upsert({
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

    await store.upsert({
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
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    await pool.sync();

    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: false,
    });
    await pool.sync();
    expect(mounts[0]?.disposed).toBe(true);
    expect(pool.views()).toMatchObject([{ status: "disabled" }]);

    await store.remove("alpha");
    await pool.sync();
    expect(pool.views()).toEqual([]);
  });

  it("disposes both fibers when a removed entry had already reconnected", async () => {
    await store.upsert({
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

    await store.remove("alpha");
    await pool.sync();
    await tick();

    expect(mounts.map((mount) => mount.disposed)).toEqual([true, true]);
    expect(pool.views()).toEqual([]);
  });

  it("picks up configuration written by another store instance", async () => {
    const other = new McpServerStore({ path: join(directory, "mcp.json") });
    await other.initialize();
    await other.upsert({
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
    await store.upsert({
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
    await store.upsert({
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
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    await store.upsert({
      serverName: "beta",
      url: "https://beta.example/mcp",
      enabled: true,
    });
    await pool.sync();

    await pool.dispose();
    expect(mounts.map((mount) => mount.disposed)).toEqual([true, true]);
  });
});
