import { Context } from "@deepseek-ai/cordis";
import { agentEvents, type Agent } from "@deepseek-ai/dsh-agent";
import { describe, expect, it, vi } from "vitest";

import {
  Config,
  DEFAULT_EXCLUDED_PRESETS,
  McpToolExclusion,
  apply,
  hiddenMcpToolNames,
  isMcpToolName,
  mcpToolNames,
  withoutHiddenMcpSections,
  type SessionHiddenServers,
} from "../src/mcp-tool-exclusion.js";

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

interface RestrictCall {
  deny: string[];
  dispose: () => void;
}

function makeHarness(
  options: {
    preset?: string | undefined;
    deferInject?: boolean;
    presets?: boolean;
    /** Servers the session turned off, read through a fake sandbox manager. */
    disabled?: SessionHiddenServers | ((agent: Agent) => SessionHiddenServers);
  } = {},
) {
  const ctx = new Context();
  const schemaNames = [
    "bash",
    "read",
    "mcp__buildkite__list_builds",
    "read_mcp_resource",
  ];
  const restrictions: RestrictCall[] = [];
  const tools = {
    schemas: () =>
      schemaNames.map((name) => ({ name, description: "", parameters: {} })),
    restrict: vi.fn((filter: { deny: string[] }) => {
      const call: RestrictCall = {
        deny: [...filter.deny],
        dispose: vi.fn(() => undefined),
      };
      restrictions.push(call);
      return call.dispose;
    }),
  };
  const fiberDisposals: ReturnType<typeof vi.fn>[] = [];
  const pendingInjections: Array<() => void> = [];
  let preset = Object.hasOwn(options, "preset") ? options.preset : "minimal";
  const agent = {
    id: "session-minimal",
    session: {
      id: "session-minimal",
      // The creation fact, deliberately kept apart from the live preset the
      // registry reports: the Web UI picks a preset for a blank session
      // through agentPresets.select, which never rewrites this header.
      header: { agentPreset: "standard" },
    },
    ctx: {
      inject: (_services: string[], callback: (scope: unknown) => void) => {
        let owned: RestrictCall | undefined;
        const scopedTools = {
          ...tools,
          restrict: (filter: { deny: string[] }): (() => void) => {
            const disposer = tools.restrict(filter);
            owned = restrictions[restrictions.length - 1];
            return disposer;
          },
        };
        const run = () => callback({ tools: scopedTools });
        if (options.deferInject === true) {
          pendingInjections.push(run);
        } else {
          run();
        }
        // Cordis tears the injected fiber's restriction effect down with the
        // fiber, so the mock dispose lifts this injection's mask.
        const dispose = vi.fn(() => owned?.dispose());
        fiberDisposals.push(dispose);
        return { dispose };
      },
    },
  } as unknown as Agent;
  const agents = { list: () => [] as Agent[] };
  ctx.provide("agents", agents);
  ctx.provide("tools", tools);
  if (options.presets !== false) {
    ctx.provide("agentPresets", {
      composedPreset: () => preset,
    });
  }
  let disabled = options.disabled;
  if (disabled !== undefined) {
    ctx.provide("sandboxManager", {
      hiddenMcpServers: (agent: Agent) =>
        typeof disabled === "function"
          ? disabled(agent)
          : (disabled ?? { servers: [], everyServer: false }),
    });
  }
  return {
    agent,
    agents,
    ctx,
    fiberDisposals,
    pendingInjections,
    restrictions,
    schemaNames,
    selectPreset: (next: string | undefined) => {
      preset = next;
    },
    setDisabled: (next: SessionHiddenServers) => {
      disabled = next;
    },
    tools,
  };
}

describe("isMcpToolName", () => {
  it("matches server tools and the shared resource tools", () => {
    expect(isMcpToolName("mcp__buildkite__list_builds")).toBe(true);
    expect(isMcpToolName("list_mcp_resources")).toBe(true);
    expect(isMcpToolName("list_mcp_resource_templates")).toBe(true);
    expect(isMcpToolName("read_mcp_resource")).toBe(true);
    expect(isMcpToolName("mcp_resources")).toBe(false);
    expect(isMcpToolName("bash")).toBe(false);
  });
});

describe("mcpToolNames", () => {
  it("keeps only MCP names, sorted", () => {
    expect(
      mcpToolNames([
        "read",
        "mcp__notion__search",
        "bash",
        "mcp__buildkite__list_builds",
        "read_mcp_resource",
      ]),
    ).toEqual([
      "mcp__buildkite__list_builds",
      "mcp__notion__search",
      "read_mcp_resource",
    ]);
  });
});

describe("Config", () => {
  it("defaults the excluded preset list to minimal", () => {
    expect(Config(undefined)).toEqual({
      excludedPresets: [...DEFAULT_EXCLUDED_PRESETS],
    });
    expect(Config({})).toEqual({
      excludedPresets: [...DEFAULT_EXCLUDED_PRESETS],
    });
    expect(Config({ excludedPresets: ["standard"] })).toEqual({
      excludedPresets: ["standard"],
    });
  });
});

describe("apply", () => {
  it("denies MCP tools on a minimal agent and follows registry changes", async () => {
    const harness = makeHarness();
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });

    expect(harness.restrictions.map((call) => call.deny)).toEqual([
      ["mcp__buildkite__list_builds", "read_mcp_resource"],
    ]);

    harness.schemaNames.push("mcp__notion__search");
    harness.ctx.emit("tools/change");
    expect(harness.restrictions.map((call) => call.deny)).toEqual([
      ["mcp__buildkite__list_builds", "read_mcp_resource"],
      [
        "mcp__buildkite__list_builds",
        "mcp__notion__search",
        "read_mcp_resource",
      ],
    ]);
    expect(harness.restrictions[0]?.dispose).toHaveBeenCalledTimes(1);

    harness.schemaNames.length = 0;
    harness.ctx.emit("tools/change");
    expect(harness.restrictions).toHaveLength(2);
    expect(harness.restrictions[1]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("covers agents that already exist when the row mounts", async () => {
    const harness = makeHarness();
    harness.agents.list = () => [harness.agent];
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    expect(harness.restrictions).toHaveLength(1);
  });

  it("leaves other presets alone", async () => {
    const harness = makeHarness({ preset: "standard" });
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.restrictions).toHaveLength(0);
  });

  it("does nothing when the agent runs no preset", async () => {
    const harness = makeHarness({ preset: undefined });
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.restrictions).toHaveLength(0);
  });

  it("follows a preset selected on a blank session", async () => {
    const harness = makeHarness({ preset: "standard" });
    harness.agents.list = () => [harness.agent];
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.restrictions).toHaveLength(0);

    // The Web UI picks `minimal` for the blank session. The preset registry
    // rebinds the composition and emits `tools/change`; the session header
    // keeps naming the preset the session started with.
    harness.selectPreset("minimal");
    harness.ctx.emit("tools/change");
    expect(harness.agent.session.header.agentPreset).toBe("standard");
    expect(harness.restrictions.map((call) => call.deny)).toEqual([
      ["mcp__buildkite__list_builds", "read_mcp_resource"],
    ]);
  });

  it("lifts the restriction when the live preset changes away", async () => {
    const harness = makeHarness();
    harness.agents.list = () => [harness.agent];
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.restrictions).toHaveLength(1);

    harness.selectPreset("standard");
    harness.ctx.emit("tools/change");
    expect(harness.fiberDisposals[0]).toHaveBeenCalledTimes(1);
    expect(harness.restrictions[0]?.dispose).toHaveBeenCalledTimes(1);
    harness.ctx.emit("tools/change");
    expect(harness.restrictions).toHaveLength(1);
  });

  it("is inert when no preset registry is mounted", async () => {
    const harness = makeHarness({ preset: "minimal", presets: false });
    harness.agents.list = () => [harness.agent];
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    harness.ctx.emit("tools/change");
    expect(harness.restrictions).toHaveLength(0);
  });

  it("keeps the previous mask when a new restrict fails", async () => {
    const harness = makeHarness();
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.restrictions).toHaveLength(1);

    harness.schemaNames.push("mcp__notion__search");
    harness.tools.restrict.mockImplementationOnce(() => {
      throw new Error("unknown global tool");
    });
    harness.ctx.emit("tools/change");
    expect(harness.restrictions).toHaveLength(1);
    expect(harness.restrictions[0]?.dispose).not.toHaveBeenCalled();

    harness.ctx.emit("tools/change");
    expect(harness.restrictions).toHaveLength(2);
    expect(harness.restrictions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("is inert for an empty excluded list", async () => {
    const harness = makeHarness();
    apply(harness.ctx, { excludedPresets: [] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.restrictions).toHaveLength(0);
  });

  it("does not restrict an agent disposed before its tools scope is live", async () => {
    const harness = makeHarness({ deferInject: true });
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.fiberDisposals[0]).not.toHaveBeenCalled();

    agentEvents(harness.ctx, harness.agent).emit("agent/disposed", {});
    expect(harness.fiberDisposals[0]).toHaveBeenCalledTimes(1);
    for (const run of harness.pendingInjections.splice(0)) {
      run();
    }
    expect(harness.restrictions).toHaveLength(0);
  });

  it("drops one agent's policy when it is disposed", async () => {
    const harness = makeHarness();
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    agentEvents(harness.ctx, harness.agent).emit("agent/disposed", {});
    expect(harness.fiberDisposals[0]).toHaveBeenCalledTimes(1);

    harness.ctx.emit("tools/change");
    expect(harness.restrictions).toHaveLength(1);
  });
});

describe("McpToolExclusion.dispose", () => {
  it("ignores registry changes and syncs after disposal", () => {
    const harness = makeHarness();
    harness.agents.list = () => [harness.agent];
    const exclusion = new McpToolExclusion({
      excludedPresets: ["minimal"],
      presetFor: () => "minimal",
      sessionHiddenFor: () => ({ servers: [], everyServer: false }),
      agents: () => harness.agents.list(),
      toolNames: () => harness.schemaNames,
      warn: () => undefined,
    });
    exclusion.sync(harness.agent);
    expect(harness.restrictions).toHaveLength(1);

    exclusion.dispose();
    exclusion.reconcile();
    exclusion.sync(harness.agent);
    expect(harness.restrictions).toHaveLength(1);
  });
});

const none: SessionHiddenServers = { servers: [], everyServer: false };

function hiding(servers: string[], everyServer = false) {
  return { servers: new Set(servers), everyServer };
}

describe("hiddenMcpToolNames", () => {
  const names = [
    "bash",
    "mcp__buildkite__list_builds",
    "mcp__notion__search",
    "mcp__notion-extra__search",
    "list_mcp_resources",
    "read_mcp_resource",
  ];

  it("hides every MCP name for an excluded preset", () => {
    expect(hiddenMcpToolNames(names, "all")).toEqual(mcpToolNames(names));
  });

  it("hides only the named servers, matching the whole server name", () => {
    expect(hiddenMcpToolNames(names, hiding(["notion"]))).toEqual([
      "mcp__notion__search",
    ]);
  });

  it("keeps the resource tools until every configured server is hidden", () => {
    // Every server with tools is hidden, but the caller reports another
    // configured server (still connecting, or resources only), so the shared
    // resource tools stay.
    expect(
      hiddenMcpToolNames(
        names,
        hiding(["buildkite", "notion", "notion-extra"], false),
      ),
    ).toEqual([
      "mcp__buildkite__list_builds",
      "mcp__notion-extra__search",
      "mcp__notion__search",
    ]);
    expect(
      hiddenMcpToolNames(
        names,
        hiding(["buildkite", "notion", "notion-extra"], true),
      ),
    ).toEqual(mcpToolNames(names));
  });
});

describe("withoutHiddenMcpSections", () => {
  // Copied verbatim from dsh-mcp-resources 0.2.1-rc.2 `lib/index.js`. If a dsh
  // upgrade changes this sentence, update both this fixture and
  // RESOURCE_SERVER_LIST in src/mcp-tool-exclusion.ts.
  const resourceText = (names: string[]) => `## MCP resource servers

Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: ${JSON.stringify(names)}.`;
  const resource = (names: string[]) => ({
    name: "mcp-resource-servers",
    text: resourceText(names),
    interpolate: false,
  });
  const sections = [
    { name: "tool:bash", text: "bash" },
    { name: "mcp:buildkite", text: "### MCP server: buildkite" },
    { name: "mcp:notion", text: "### MCP server: notion" },
    resource(["buildkite", "notion"]),
  ];
  const noWarning = () => {
    throw new Error("unexpected warning");
  };

  it("drops hidden servers' instructions and names", () => {
    expect(
      withoutHiddenMcpSections(sections, hiding(["notion"]), noWarning),
    ).toEqual([
      { name: "tool:bash", text: "bash" },
      { name: "mcp:buildkite", text: "### MCP server: buildkite" },
      resource(["buildkite"]),
    ]);
  });

  it("drops the resource section when no listed server is left", () => {
    expect(
      withoutHiddenMcpSections(
        sections,
        hiding(["buildkite", "notion"]),
        noWarning,
      ),
    ).toEqual([{ name: "tool:bash", text: "bash" }]);
  });

  it("drops the resource section when every server is hidden", () => {
    expect(
      withoutHiddenMcpSections(
        [resource(["buildkite", "files"])],
        hiding(["buildkite"], true),
        noWarning,
      ),
    ).toEqual([]);
  });

  it("keeps a resource section it cannot read, and says so", () => {
    const odd = { name: "mcp-resource-servers", text: "servers: notion" };
    const warn = vi.fn();
    expect(withoutHiddenMcpSections([odd], hiding(["notion"]), warn)).toEqual([
      odd,
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("apply with a session choice", () => {
  it("hides the session's servers and follows its changes", async () => {
    const harness = makeHarness({ preset: "standard", disabled: none });
    harness.schemaNames.push("mcp__notion__search");
    harness.agents.list = () => [harness.agent];
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    expect(harness.restrictions).toHaveLength(0);

    harness.setDisabled({ servers: ["notion"], everyServer: false });
    harness.ctx.emit("sandbox-manager/session-mcp-change");
    expect(harness.restrictions.map((call) => call.deny)).toEqual([
      ["mcp__notion__search"],
    ]);

    harness.setDisabled({
      servers: ["buildkite", "notion"],
      everyServer: true,
    });
    harness.ctx.emit("sandbox-manager/session-mcp-change");
    expect(harness.restrictions.map((call) => call.deny)).toEqual([
      ["mcp__notion__search"],
      [
        "mcp__buildkite__list_builds",
        "mcp__notion__search",
        "read_mcp_resource",
      ],
    ]);

    harness.setDisabled(none);
    harness.ctx.emit("sandbox-manager/session-mcp-change");
    expect(harness.fiberDisposals[0]).toHaveBeenCalledTimes(1);
    expect(harness.restrictions[1]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("projects the registry once for every agent in one reconcile", async () => {
    const ctx = new Context();
    const schemaNames = ["bash", "mcp__notion__search"];
    const schemas = vi.fn(() => schemaNames.map((name) => ({ name })));
    const restrict = vi.fn(() => () => undefined);
    const tools = { schemas, restrict };
    const agents = Array.from({ length: 5 }, (_, index) => {
      const id = `session-${index}`;
      return {
        id,
        session: { id, header: {} },
        ctx: {
          inject: (_services: string[], callback: (scope: unknown) => void) => {
            callback({ tools });
            return { dispose: () => undefined };
          },
        },
      } as unknown as Agent;
    });
    ctx.provide("agents", { list: () => agents });
    ctx.provide("tools", tools);
    ctx.provide("sandboxManager", {
      hiddenMcpServers: () => ({ servers: ["notion"], everyServer: false }),
    });
    apply(ctx, { excludedPresets: [] });
    await flush();
    expect(restrict).toHaveBeenCalledTimes(5);

    schemas.mockClear();
    ctx.emit("tools/change");

    // Five live agents used to mean five deep clones of every tool schema.
    expect(schemas).toHaveBeenCalledTimes(1);
  });

  it("hides a turned-off server's tools again after it reconnects", async () => {
    const harness = makeHarness({
      preset: "standard",
      disabled: { servers: ["notion"], everyServer: false },
    });
    harness.schemaNames.push("mcp__notion__search");
    harness.agents.list = () => [harness.agent];
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    expect(harness.restrictions.map((call) => call.deny)).toEqual([
      ["mcp__notion__search"],
    ]);

    // An OAuth renewal remounts the server: its tools leave the registry,
    // then come back, possibly with a new one, each with its own tools/change.
    harness.schemaNames.splice(
      harness.schemaNames.indexOf("mcp__notion__search"),
      1,
    );
    harness.ctx.emit("tools/change");
    expect(harness.restrictions[0]?.dispose).toHaveBeenCalledTimes(1);
    harness.schemaNames.push("mcp__notion__search", "mcp__notion__create_page");
    harness.ctx.emit("tools/change");
    expect(harness.restrictions.at(-1)?.deny).toEqual([
      "mcp__notion__create_page",
      "mcp__notion__search",
    ]);
    expect(harness.restrictions.at(-1)?.dispose).not.toHaveBeenCalled();
  });

  it("drops the hidden servers' prompt sections for that agent only", async () => {
    const other = { id: "session-other" } as unknown as Agent;
    // The other agent's session made no choice.
    const harness = makeHarness({
      preset: "standard",
      disabled: (agent) =>
        agent === other ? none : { servers: ["notion"], everyServer: false },
    });
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();

    const assembly = {
      sections: [
        { name: "mcp:buildkite", text: "buildkite" },
        { name: "mcp:notion", text: "notion" },
      ],
      contexts: [],
      tools: [],
      variables: {},
    };
    // dsh-agent's assembleContextFor sets both fields to the same agent.
    const assemble = (agent: Agent) =>
      harness.ctx.waterfall(
        "system-prompt/assemble",
        assembly,
        { agent, scope: agent },
        () => Promise.resolve(assembly),
      );
    const mine = await assemble(harness.agent);
    expect(mine.sections.map((section) => section.name)).toEqual([
      "mcp:buildkite",
    ]);
    const theirs = await assemble(other);
    expect(theirs.sections.map((section) => section.name)).toEqual([
      "mcp:buildkite",
      "mcp:notion",
    ]);
  });
});
