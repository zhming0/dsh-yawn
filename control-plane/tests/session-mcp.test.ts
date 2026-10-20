import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SandboxManager } from "../src/manager/index.js";
import { McpChoice } from "../src/manager/mcp-choice.js";
import type { McpPool } from "../src/mcp-pool.js";
import type { McpServerView } from "../src/mcp-remote.js";
import type { SessionStore } from "../src/state-store.js";
import { FakeBackend, gatewayFor } from "./fakes.js";

function server(
  serverName: string,
  overrides: Partial<McpServerView> = {},
): McpServerView {
  return {
    serverName,
    url: `https://${serverName}.example.com/mcp`,
    auth: "none",
    enabled: true,
    hasToken: false,
    status: "connected",
    toolCount: 3,
    ...overrides,
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

describe("session MCP choice", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-control-plane-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function managerWith(agents: Record<string, Agent>, ctx = new Context()) {
    const backend = new FakeBackend();
    const pool = {
      sync: async () => undefined,
      views: () => [
        server("buildkite"),
        server("notion", { status: "needs-auth", toolCount: 0 }),
        server("off", { enabled: false, status: "disabled", toolCount: 0 }),
      ],
    } as unknown as McpPool;
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

  it("applies the root session's choice to its subagents", async () => {
    const agents: Record<string, Agent> = {
      root: agentFor("root"),
    };
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
    const choice = new McpChoice({
      store,
      servers: () => [server("notion")],
      started: () => false,
      changed: () => seen.push([...choice.hidden("blank").servers]),
    });

    const pending = choice.set("blank", ["notion"]);
    expect(seen).toEqual([["notion"]]);
    finishWrite();
    expect((await pending).disabled).toEqual(["notion"]);
  });
});
