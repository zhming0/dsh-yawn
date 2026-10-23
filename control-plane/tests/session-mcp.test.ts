import { mkdtemp, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SandboxManager } from "../src/manager/index.js";
import { McpChoice } from "../src/manager/mcp-choice.js";
import type { McpPool } from "../src/mcp-pool.js";
import type { McpServerEntry } from "../src/mcp-store.js";
import type { McpServerView } from "../src/mcp-remote.js";
import type { SessionStore } from "../src/state-store.js";
import { FakeBackend, gatewayFor, removeDirectory } from "./fakes.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "dsh-yawn-control-plane-"));
});

afterEach(async () => {
  await removeDirectory(directory);
});

function server(
  serverName: string,
  overrides: Partial<McpServerView> = {},
): McpServerView {
  return {
    serverName,
    url: `https://${serverName}.example.com/mcp`,
    auth: "none",
    enabled: true,
    offByDefault: false,
    hasToken: false,
    status: "connected",
    toolCount: 3,
    ...overrides,
  };
}

/** The saved fields of a view, which is all the choice needs from the store. */
function entry(view: McpServerView): McpServerEntry {
  return {
    serverName: view.serverName,
    url: view.url,
    auth: view.auth,
    enabled: view.enabled,
    offByDefault: view.offByDefault,
  };
}

function agentFor(
  id: string,
  messages: Array<{ role: string }> = [],
  header: Record<string, unknown> = {},
): Agent {
  return {
    id,
    session: { header, deriveMessages: () => messages },
  } as unknown as Agent;
}

function managerWith(
  agents: Record<string, Agent>,
  ctx: Context = new Context(),
  views: () => McpServerView[] = () => [
    server("buildkite"),
    server("notion", { status: "needs-auth", toolCount: 0 }),
    server("off", { enabled: false, status: "disabled", toolCount: 0 }),
  ],
) {
  const backend = new FakeBackend();
  const pool = { sync: async () => undefined, views } as unknown as McpPool;
  // The manager reads server choices from its store and status from the pool;
  // keep the two in step so the fake pool is enough.
  writeFileSync(
    join(directory, "mcp.json"),
    JSON.stringify({ version: 1, servers: views().map(entry) }),
  );
  return new SandboxManager(
    ctx,
    {
      stateDir: directory,
      repository: "https://github.com/example/public.git",
      profiles: { standard: { backend: "docker" } },
    },
    {
      backends: { standard: backend },
      gateway: gatewayFor(backend),
      mcpPool: pool,
      agentLookup: (sessionId) => agents[sessionId],
    },
  );
}

/** Let the store's queued write, and any fire-and-forget one, settle. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe("session MCP choice", () => {
  it("lists enabled servers and keeps a blank session's choice across restarts", async () => {
    const agents = { blank: agentFor("blank") };
    const ctx = new Context();
    const changed = vi.fn();
    ctx.on("sandbox-manager/session-mcp-change", changed);
    const manager = managerWith(agents, ctx);

    expect(await manager.getSessionMcp("blank")).toEqual({
      servers: [
        { serverName: "buildkite", status: "connected", toolCount: 3 },
        { serverName: "notion", status: "needs-auth", toolCount: 0 },
      ],
      disabled: [],
      locked: false,
    });
    changed.mockClear();

    await expect(manager.setSessionMcp("blank", ["github"])).rejects.toThrow(
      "unknown MCP server: github",
    );
    expect(
      (await manager.setSessionMcp("blank", ["notion", "notion"])).disabled,
    ).toEqual(["notion"]);
    expect(changed).toHaveBeenCalledTimes(1);
    // Buildkite is still on, so the shared resource tools stay.
    expect(manager.hiddenMcpServers(agents.blank)).toEqual({
      servers: ["notion"],
      everyServer: false,
    });
    await manager.setSessionMcp("blank", ["buildkite", "notion"]);
    // The disabled `off` server does not count.
    expect(manager.hiddenMcpServers(agents.blank).everyServer).toBe(true);
    await manager.setSessionMcp("blank", ["notion"]);

    const restarted = managerWith(agents);
    expect((await restarted.getSessionMcp("blank")).disabled).toEqual([
      "notion",
    ]);
  });

  it("locks the choice once the session has a prompt", async () => {
    const agents = {
      started: agentFor("started", [{ role: "system" }, { role: "user" }]),
    };
    const manager = managerWith(agents);
    expect((await manager.getSessionMcp("started")).locked).toBe(true);
    await expect(manager.setSessionMcp("started", ["notion"])).rejects.toThrow(
      "MCP servers cannot change after the first prompt",
    );
    // A session with no live agent cannot be checked, so it is locked too.
    expect((await manager.getSessionMcp("gone")).locked).toBe(true);
  });

  it("tells live agents when the server configuration changes", async () => {
    const ctx = new Context();
    const changed = vi.fn();
    ctx.on("sandbox-manager/session-mcp-change", changed);
    const manager = managerWith({}, ctx);
    // Booting the manager announces itself; count only the writes below.
    await manager.getSessionMcp("blank");
    changed.mockClear();

    // Turning a server off by default leaves its mount alone, so no
    // `tools/change` follows; this notice is what updates the tool masks.
    await manager.setMcpServer({
      serverName: "stripe",
      url: "https://stripe.example/mcp",
      auth: "none",
      enabled: true,
      offByDefault: true,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    await manager.deleteMcpServer("stripe");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("tells live agents when it freezes a session's servers", async () => {
    const ctx = new Context();
    const changed = vi.fn();
    ctx.on("sandbox-manager/session-mcp-change", changed);
    const manager = managerWith({ blank: agentFor("blank") }, ctx, () => [
      server("stripe", { offByDefault: true }),
    ]);
    // Booting the manager announces itself; count only the turn below.
    await manager.getSessionMcp("blank");
    changed.mockClear();

    ctx.emit(
      "session/event",
      { id: "blank" } as unknown as Session,
      {
        type: "turn/start",
        data: { turn: 1 },
      } as unknown as SessionEvent,
    );
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await manager.getSessionMcp("blank")).disabled).toEqual(["stripe"]);
    // The frozen record outlives the process: a restart reads it back. The
    // write is a background one, so wait for it to land first.
    const statePath = join(directory, "sessions.json");
    await vi.waitFor(async () => {
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        disabledMcpServers?: Record<string, string[]>;
      };
      expect(state.disabledMcpServers?.blank).toEqual(["stripe"]);
    });
    const reopened = managerWith(
      { blank: agentFor("blank") },
      new Context(),
      () => [server("stripe")],
    );
    expect((await reopened.getSessionMcp("blank")).disabled).toEqual([
      "stripe",
    ]);
  });

  it("applies the root session's choice to its subagents", async () => {
    const agents: Record<string, Agent> = { root: agentFor("root") };
    agents.child = agentFor("child", [], {
      origin: "subagent",
      parentSession: "root",
    });
    const manager = managerWith(agents);
    await manager.setSessionMcp("root", ["buildkite"]);
    expect(manager.hiddenMcpServers(agents.child).servers).toEqual([
      "buildkite",
    ]);
  });
});

describe("McpChoice.set", () => {
  it("publishes the change before the write settles, so a prompt never sees half of it", async () => {
    let state: string[] = [];
    let finishWrite: () => void = () => undefined;
    const store = {
      disabledMcpServers: () => state,
      setDisabledMcpServers: (_sessionId: string, names: string[]) => {
        state = names;
        return new Promise<void>((resolve) => {
          finishWrite = resolve;
        });
      },
    } as unknown as SessionStore;
    const seen: string[][] = [];
    const choice: McpChoice = new McpChoice({
      store,
      servers: () => [entry(server("notion"))],
      views: () => [server("notion")],
      started: () => false,
      changed: () => seen.push([...choice.hidden("blank").servers]),
      warn: () => undefined,
    });

    const pending = choice.set("blank", ["notion"]);
    expect(seen).toEqual([["notion"]]);
    finishWrite();
    expect((await pending).disabled).toEqual(["notion"]);
  });
});

describe("McpChoice.hidden", () => {
  it("does not project the tool registry to decide what one session hides", () => {
    const store = {
      disabledMcpServers: () => undefined,
    } as unknown as SessionStore;
    const views = vi.fn(() => {
      throw new Error("the hidden set must not read live server status");
    });
    const choice = new McpChoice({
      store,
      servers: () => [entry(server("stripe", { offByDefault: true }))],
      views,
      started: () => false,
      changed: () => undefined,
      warn: () => undefined,
    });

    expect(choice.hidden("blank")).toEqual({
      servers: ["stripe"],
      everyServer: true,
    });
    expect(views).not.toHaveBeenCalled();
  });
});

describe("servers that start turned off", () => {
  function choiceWith(options: {
    defaults: string[];
    chosen?: string[] | undefined;
    onWrite?: (names: string[]) => void;
  }) {
    const servers = () =>
      ["buildkite", "stripe"].map((name) =>
        server(name, { offByDefault: options.defaults.includes(name) }),
      );
    const store = {
      disabledMcpServers: () => options.chosen,
      setDisabledMcpServers: (_sessionId: string, names: string[]) => {
        options.chosen = names;
        options.onWrite?.(names);
        return Promise.resolve();
      },
    } as unknown as SessionStore;
    return new McpChoice({
      store,
      servers: () => servers().map(entry),
      views: servers,
      started: () => false,
      changed: () => undefined,
      warn: () => undefined,
    });
  }

  it("starts a new session with the configured servers turned off", () => {
    const choice = choiceWith({ defaults: ["stripe"] });
    expect(choice.view("blank").disabled).toEqual(["stripe"]);
    expect(choice.hidden("blank")).toEqual({
      servers: ["stripe"],
      everyServer: false,
    });
  });

  it("lets the session's own choice win over the default", () => {
    const choice = choiceWith({ defaults: ["stripe"], chosen: [] });
    expect(choice.view("blank").disabled).toEqual([]);
  });

  it("freezes everything on for a conversation already under way", () => {
    const written: string[][] = [];
    const choice = choiceWith({
      defaults: ["stripe"],
      onWrite: (names) => written.push(names),
    });
    // Its earlier turns ran when every server was on.
    choice.freeze("blank", 4);
    expect(written).toEqual([[]]);
    expect(choice.hidden("blank")).toEqual({
      servers: [],
      everyServer: false,
    });
  });

  it("freezes the default into the session's own record", () => {
    const written: string[][] = [];
    const choice = choiceWith({
      defaults: ["stripe"],
      onWrite: (names) => written.push(names),
    });
    choice.freeze("blank", 1);
    expect(written).toEqual([["stripe"]]);
    expect(choice.hidden("blank").servers).toEqual(["stripe"]);
  });

  it("keeps a choice the session already made", () => {
    const written: string[][] = [];
    const choice = choiceWith({
      defaults: ["stripe"],
      chosen: [],
      onWrite: (names) => written.push(names),
    });
    choice.freeze("blank", 1);
    expect(written).toEqual([]);
    expect(choice.hidden("blank").servers).toEqual([]);
  });

  it("holds the choice a session started with when the default changes", async () => {
    let stripeOff = true;
    const ctx = new Context();
    const manager = managerWith({ blank: agentFor("blank") }, ctx, () => [
      server("buildkite"),
      server("stripe", { offByDefault: stripeOff, toolCount: 20 }),
    ]);
    expect((await manager.getSessionMcp("blank")).disabled).toEqual(["stripe"]);

    // The first prompt starts: the session fixes what it runs with.
    ctx.emit(
      "session/event",
      { id: "blank" } as unknown as Session,
      {
        type: "turn/start",
        data: { turn: 1 },
      } as unknown as SessionEvent,
    );
    await flush();

    // The operator then changes the server's default.
    stripeOff = false;
    expect((await manager.getSessionMcp("blank")).disabled).toEqual(["stripe"]);
    expect(manager.hiddenMcpServers(agentFor("blank")).servers).toEqual([
      "stripe",
    ]);
  });

  it("warns when the frozen choice cannot be saved", async () => {
    const messages: string[] = [];
    const store = {
      disabledMcpServers: () => undefined,
      setDisabledMcpServers: () => Promise.reject(new Error("disk full")),
    } as unknown as SessionStore;
    new McpChoice({
      store,
      servers: () => [entry(server("stripe", { offByDefault: true }))],
      views: () => [server("stripe", { offByDefault: true })],
      started: () => false,
      changed: () => undefined,
      warn: (message) => messages.push(message),
    }).freeze("blank", 1);
    await flush();
    expect(messages).toEqual([
      "could not freeze the MCP server choice of session blank: disk full",
    ]);
  });
});
