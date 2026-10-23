import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionSummary } from "@deepseek-ai/dsh-api-session-controller";
import type { WorkspaceId } from "@deepseek-ai/dsh-api-workspace-controller";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Config,
  DEFAULT_EXCLUDED_PRESETS,
  apply,
  createSessionTools,
  type SessionToolDeps,
} from "../src/session-tools.js";

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const caller = {
  id: "caller",
  session: { header: { origin: undefined } },
} as unknown as Agent;

function fakeExec(
  agent: Agent | undefined = caller,
  signal: AbortSignal = new AbortController().signal,
): ToolRunContext {
  return { agent, signal } as unknown as ToolRunContext;
}

function definitions(deps: SessionToolDeps): Map<string, ToolDefinition> {
  return new Map(createSessionTools(deps).map((tool) => [tool.name, tool]));
}

async function run(
  deps: SessionToolDeps,
  name: string,
  args: unknown,
  exec: ToolRunContext = fakeExec(),
): Promise<unknown> {
  const tool = definitions(deps).get(name);
  if (tool === undefined) {
    throw new Error(`missing tool ${name}`);
  }
  return tool.execute(args, exec);
}

const repoWorkspace = {
  id: "ws-repo" as WorkspaceId,
  path: "/repo",
  title: "repo",
  sessionIds: ["caller" as SessionId],
};

const scratchWorkspace = {
  id: "ws-scratch" as WorkspaceId,
  path: "/scratch",
  title: "Scratch",
  sessionIds: [],
};

const sandboxProfiles = [
  { name: "docker", backend: "docker" },
  { name: "k8s", backend: "kas" },
];

const modelCatalog = {
  default: { provider: "deepseek", model: "deepseek-chat" },
  routableProviders: ["deepseek"],
  groups: [
    {
      id: "deepseek",
      name: "DeepSeek",
      models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
    },
  ],
  failures: [],
};

function makeDeps(
  overrides: {
    list?: () => Promise<{ items: SessionSummary[] }>;
    create?: () => Promise<{ sessionId: string; agentPreset?: string }>;
    prompt?: () => Promise<{ accepted: true }>;
  } = {},
): SessionToolDeps {
  return {
    sessions: {
      list: overrides.list ?? (async () => ({ items: [] as SessionSummary[] })),
      create:
        overrides.create ??
        (async () => ({ sessionId: "child", agentPreset: "standard" })),
      rename: async ({ title }: { title: string }) => ({ title, seq: 1 }),
      prompt: overrides.prompt ?? (async () => ({ accepted: true as const })),
      cancel: () => ({ accepted: true as const }),
      follow: async function* () {
        yield emptySnapshot();
      },
      modelCatalog: async () => modelCatalog,
      selectModel: async (request: {
        provider: string;
        model: string;
        reasoningEffort?: string;
      }) => ({
        selected: {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: request.reasoningEffort }),
        },
      }),
    } as unknown as SessionToolDeps["sessions"],
    sandbox: {
      listSandboxProfiles: async () => ({
        profiles: sandboxProfiles,
        selected: "docker",
        locked: false,
      }),
      setSessionProfile: async (_sessionId: string, profile: string) => ({
        profiles: sandboxProfiles,
        selected: profile,
        locked: false,
      }),
    },
    workspaces: {
      list: () => [repoWorkspace, scratchWorkspace],
    },
    scratchWorkspace: "/scratch",
  };
}

function emptySnapshot(): unknown {
  return {
    type: "snapshot",
    header: {
      version: 1,
      id: "child",
      createdAt: 0,
      cwd: "/repo",
      isSeeded: false,
    },
    cursor: 0,
    records: [],
    hasMore: false,
    projections: { asOfSeq: 0, values: {} },
  };
}

function assistantSnapshot(text: string): unknown {
  return {
    ...(emptySnapshot() as Record<string, unknown>),
    cursor: 1,
    records: [
      {
        type: "event",
        event: {
          type: "assistant/message",
          seq: 1,
          time: 0,
          data: { message: { content: [{ type: "text", text }] } },
        },
      },
    ],
    projections: { asOfSeq: 1, values: {} },
  };
}

function row(value: Record<string, unknown>): SessionSummary {
  return {
    agentAvailable: false,
    updatedAt: 0,
    running: false,
    blank: false,
    ...value,
  } as unknown as SessionSummary;
}

afterEach(() => {
  vi.useRealTimers();
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

describe("list_workspaces", () => {
  it("projects ids, paths, counts, and the scratch marker", async () => {
    const deps = makeDeps();
    expect(await run(deps, "list_workspaces", {})).toEqual([
      {
        workspace_id: "ws-repo",
        title: "repo",
        path: "/repo",
        session_count: 1,
        scratch: false,
      },
      {
        workspace_id: "ws-scratch",
        title: "Scratch",
        path: "/scratch",
        session_count: 0,
        scratch: true,
      },
    ]);
  });
});

describe("list_models", () => {
  it("returns the deployment catalog", async () => {
    expect(await run(makeDeps(), "list_models", {})).toEqual(modelCatalog);
  });
});

describe("list_sandbox_profiles", () => {
  it("returns the profile names and deployment default", async () => {
    expect(await run(makeDeps(), "list_sandbox_profiles", {})).toEqual({
      profiles: sandboxProfiles,
      selected: "docker",
      locked: false,
    });
  });
});

describe("create_session", () => {
  it("creates in a workspace and sends the first message with caller attribution", async () => {
    const calls: unknown[] = [];
    const deps = makeDeps();
    deps.sessions.create = (async (request: unknown) => {
      calls.push(request);
      return { sessionId: "child", agentPreset: "standard" };
    }) as never;
    const prompts: unknown[] = [];
    deps.sessions.prompt = (async (request: unknown) => {
      prompts.push(request);
      return { accepted: true };
    }) as never;
    deps.sessions.rename = async ({ title }: { title: string }) => {
      return { title, seq: 1 };
    };

    const result = (await run(deps, "create_session", {
      workspace_id: "ws-repo",
      title: "Worker",
      prompt: "fix the bug",
    })) as Record<string, unknown>;

    expect(calls).toEqual([{ workspaceId: "ws-repo" }]);
    expect(result).toMatchObject({
      session_id: "child",
      workspace_id: "ws-repo",
      title: "Worker",
    });
    expect(prompts).toEqual([
      expect.objectContaining({
        sessionId: "child",
        mode: "queue",
        content: [
          {
            type: "text",
            text: "[from session caller]\n\nfix the bug",
          },
        ],
      }),
    ]);
  });

  it("keeps the session when the first prompt fails", async () => {
    const deps = makeDeps({
      prompt: async () => {
        throw new Error("model unavailable");
      },
    });
    const result = (await run(deps, "create_session", {
      workspace_id: "ws-repo",
      prompt: "fix the bug",
    })) as Record<string, unknown>;
    expect(result.session_id).toBe("child");
    expect(result.prompt_error).toBe("model unavailable");
  });

  it("defaults to the Scratch workspace", async () => {
    const calls: unknown[] = [];
    const deps = makeDeps();
    deps.sessions.create = (async (request: unknown) => {
      calls.push(request);
      return { sessionId: "child" };
    }) as never;
    await run(deps, "create_session", {});
    expect(calls).toEqual([{ workspaceId: "ws-scratch" }]);
  });

  it("resolves a workspace by title and passes cwd through", async () => {
    const calls: unknown[] = [];
    const deps = makeDeps();
    deps.sessions.create = (async (request: unknown) => {
      calls.push(request);
      return { sessionId: "child" };
    }) as never;
    await run(deps, "create_session", { workspace: "repo" });
    await run(deps, "create_session", { cwd: "/tmp/elsewhere" });
    expect(calls).toEqual([
      { workspaceId: "ws-repo" },
      { cwd: "/tmp/elsewhere" },
    ]);
  });

  it("applies sandbox profile and model before the first prompt", async () => {
    const order: string[] = [];
    const calls: unknown[] = [];
    const deps = makeDeps();
    deps.sessions.create = (async (request: unknown) => {
      calls.push(request);
      return { sessionId: "child" };
    }) as never;
    deps.sandbox.setSessionProfile = async (
      _sessionId: string,
      profile: string,
    ) => {
      order.push(`profile:${profile}`);
      return { profiles: sandboxProfiles, selected: profile, locked: false };
    };
    deps.sessions.selectModel = async (request: {
      sessionId: string;
      provider: string;
      model: string;
      reasoningEffort?: string;
    }) => {
      order.push(
        `model:${request.provider}/${request.model}/${request.reasoningEffort ?? ""}`,
      );
      return {
        selected: {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: request.reasoningEffort }),
        },
      };
    };
    deps.sessions.prompt = async () => {
      order.push("prompt");
      return { accepted: true as const };
    };

    const result = (await run(deps, "create_session", {
      workspace_id: "ws-repo",
      sandbox_profile: "k8s",
      model: {
        provider: "deepseek",
        model: "deepseek-chat",
        reasoning_effort: "high",
      },
      prompt: "go",
    })) as Record<string, unknown>;

    expect(calls).toEqual([{ workspaceId: "ws-repo" }]);
    expect(order).toEqual([
      "profile:k8s",
      "model:deepseek/deepseek-chat/high",
      "prompt",
    ]);
    expect(result).toMatchObject({
      session_id: "child",
      sandbox_profile: "k8s",
      model: {
        provider: "deepseek",
        model: "deepseek-chat",
        reasoning_effort: "high",
      },
    });
  });

  it("leaves model and profile at their defaults when omitted", async () => {
    const deps = makeDeps();
    const setProfile = vi.fn();
    const selectModel = vi.fn();
    deps.sandbox.setSessionProfile = setProfile as never;
    deps.sessions.selectModel = selectModel as never;
    await run(deps, "create_session", { workspace_id: "ws-repo" });
    expect(setProfile).not.toHaveBeenCalled();
    expect(selectModel).not.toHaveBeenCalled();
  });

  it("rejects an unknown sandbox profile before creating", async () => {
    const deps = makeDeps();
    const create = vi.fn();
    deps.sessions.create = create as never;
    await expect(
      run(deps, "create_session", { sandbox_profile: "missing" }),
    ).rejects.toThrow(/unknown sandbox profile/);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an unavailable model before creating", async () => {
    const deps = makeDeps();
    const create = vi.fn();
    deps.sessions.create = create as never;
    await expect(
      run(deps, "create_session", {
        model: { provider: "deepseek", model: "missing" },
      }),
    ).rejects.toThrow(/not available/);
    expect(create).not.toHaveBeenCalled();
  });

  it("skips the first prompt when applying the profile fails", async () => {
    const deps = makeDeps();
    deps.sandbox.setSessionProfile = async () => {
      throw new Error("profile gone");
    };
    const prompt = vi.fn();
    deps.sessions.prompt = prompt as never;
    const result = (await run(deps, "create_session", {
      sandbox_profile: "docker",
      prompt: "go",
    })) as Record<string, unknown>;
    expect(result.sandbox_profile_error).toBe("profile gone");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("rejects mixing workspace and cwd", async () => {
    await expect(
      run(makeDeps(), "create_session", {
        workspace_id: "ws-repo",
        cwd: "/repo",
      }),
    ).rejects.toThrow(/not both/);
  });
});

describe("send_message", () => {
  it("prefixes the caller id and forwards the mode", async () => {
    const prompts: unknown[] = [];
    const deps = makeDeps();
    deps.sessions.prompt = (async (request: unknown) => {
      prompts.push(request);
      return { accepted: true };
    }) as never;

    expect(
      await run(deps, "send_message", {
        session_id: "child",
        text: "status?",
        mode: "steer",
      }),
    ).toEqual({ accepted: true, session_id: "child" });
    expect(prompts).toEqual([
      expect.objectContaining({
        sessionId: "child",
        mode: "steer",
        content: [{ type: "text", text: "[from session caller]\n\nstatus?" }],
      }),
    ]);
  });

  it("refuses to message itself", async () => {
    await expect(
      run(makeDeps(), "send_message", {
        session_id: "caller",
        text: "hello",
      }),
    ).rejects.toThrow(/itself/);
  });

  it("refuses empty text", async () => {
    await expect(
      run(makeDeps(), "send_message", {
        session_id: "child",
        text: "   ",
      }),
    ).rejects.toThrow(/must not be empty/);
  });
});

describe("wait_session", () => {
  it("waits for a running session to become idle", async () => {
    vi.useFakeTimers();
    let running = true;
    const deps = makeDeps();
    deps.sessions.list = async () => ({
      items: [
        row({
          sessionId: "child",
          updatedAt: 2,
          running,
          blank: false,
        }),
      ],
    });

    const pending = run(deps, "wait_session", { session_id: "child" });
    await vi.advanceTimersByTimeAsync(10);
    running = false;
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toMatchObject({
      session_id: "child",
      running: false,
      timed_out: false,
    });
  });

  it("returns after a short grace for an already idle session", async () => {
    vi.useFakeTimers();
    const deps = makeDeps({
      list: async () => ({
        items: [
          row({
            sessionId: "child",
            updatedAt: 2,
            running: false,
            blank: false,
          }),
        ],
      }),
    });
    const pending = run(deps, "wait_session", {
      session_id: "child",
      timeout_seconds: 5,
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toMatchObject({
      running: false,
      timed_out: false,
    });
  });

  it("returns the last assistant message when the session is idle", async () => {
    const deps = makeDeps({
      list: async () => ({
        items: [
          row({
            sessionId: "child",
            updatedAt: 2,
            running: false,
            blank: false,
          }),
        ],
      }),
    });
    deps.sessions.follow = async function* () {
      yield assistantSnapshot("child result");
    } as never;
    const result = (await run(deps, "wait_session", {
      session_id: "child",
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ session_id: "child", running: false });
    expect(result.last_message).toEqual(
      expect.stringContaining("child result"),
    );
  });

  it("returns timed_out when the session stays running", async () => {
    vi.useFakeTimers();
    const deps = makeDeps({
      list: async () => ({
        items: [
          row({
            sessionId: "child",
            updatedAt: 2,
            running: true,
            blank: false,
          }),
        ],
      }),
    });
    const pending = run(deps, "wait_session", {
      session_id: "child",
      timeout_seconds: 1,
    });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await pending).toMatchObject({
      session_id: "child",
      running: true,
      timed_out: true,
    });
  });

  it("refuses to wait on a subagent", async () => {
    const deps = makeDeps({
      list: async () => ({
        items: [
          row({
            sessionId: "sub",
            updatedAt: 2,
            running: true,
            blank: false,
            origin: "subagent",
          }),
        ],
      }),
    });
    await expect(
      run(deps, "wait_session", { session_id: "sub" }),
    ).rejects.toThrow(/subagent/);
  });

  it("refuses to wait for itself", async () => {
    await expect(
      run(makeDeps(), "wait_session", { session_id: "caller" }),
    ).rejects.toThrow(/itself/);
  });
});

describe("interrupt_session", () => {
  it("cancels another session", async () => {
    const calls: unknown[] = [];
    const deps = makeDeps();
    deps.sessions.cancel = ((request: unknown) => {
      calls.push(request);
      return { accepted: true };
    }) as never;
    expect(
      await run(deps, "interrupt_session", { session_id: "child" }),
    ).toEqual({
      accepted: true,
      session_id: "child",
    });
    expect(calls).toEqual([{ sessionId: "child" }]);
  });

  it("refuses to interrupt itself", async () => {
    await expect(
      run(makeDeps(), "interrupt_session", { session_id: "caller" }),
    ).rejects.toThrow(/itself/);
  });
});

interface Harness {
  ctx: Context;
  agent: Agent;
  registered: string[];
  agents: Agent[];
  selectPreset: (preset: string | undefined) => void;
}

function makeHarness(
  options: {
    preset?: string;
    origin?: "subagent";
  } = {},
): Harness {
  const ctx = new Context();
  let preset: string | undefined = options.preset ?? "standard";
  const registered: string[] = [];
  const agent = {
    id: "session-1",
    session: { header: { origin: options.origin } },
    ctx: {
      inject: (_services: string[], callback: (scope: unknown) => void) => {
        const effects: Array<() => void> = [];
        const scopedTools = {
          register: (definition: ToolDefinition) => {
            registered.push(definition.name);
            return () => {
              const index = registered.indexOf(definition.name);
              if (index >= 0) {
                registered.splice(index, 1);
              }
            };
          },
        };
        callback({
          tools: scopedTools,
          effect: (factory: () => () => void) => {
            effects.push(factory());
          },
        });
        return {
          dispose: () => {
            for (const dispose of effects.splice(0)) {
              dispose();
            }
          },
        };
      },
    },
  } as unknown as Agent;
  const agents: Agent[] = [];
  ctx.provide("agents", { list: () => agents });
  ctx.provide("tools", {});
  ctx.provide("sessionController", {});
  ctx.provide("workspaceRegistry", {
    list: () => [repoWorkspace, scratchWorkspace],
  });
  ctx.provide("sandboxManager", { scratchWorkspace: "/scratch" });
  ctx.provide("agentPresets", { composedPreset: () => preset });
  return {
    ctx,
    agent,
    registered,
    agents,
    selectPreset: (next) => {
      preset = next;
    },
  };
}

describe("apply", () => {
  it("registers the tools on eligible agents and follows preset changes", async () => {
    const harness = makeHarness();
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    harness.agents.push(harness.agent);
    harness.ctx.emit("agent/created", {
      agent: harness.agent,
      source: "startup",
    });
    await flush();
    expect(harness.registered).toHaveLength(7);

    harness.selectPreset("minimal");
    harness.ctx.emit("tools/change");
    await flush();
    expect(harness.registered).toEqual([]);

    harness.selectPreset("standard");
    harness.ctx.emit("tools/change");
    await flush();
    expect(harness.registered).toHaveLength(7);
  });

  it("skips subagents", async () => {
    const harness = makeHarness({ origin: "subagent" });
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    harness.agents.push(harness.agent);
    harness.ctx.emit("agent/created", {
      agent: harness.agent,
      source: "startup",
    });
    await flush();
    expect(harness.registered).toEqual([]);
  });

  it("covers agents that already exist and removes disposed ones", async () => {
    const harness = makeHarness();
    harness.agents.push(harness.agent);
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    expect(harness.registered).toHaveLength(7);

    harness.ctx.emit("agent/disposed", { agent: harness.agent });
    expect(harness.registered).toEqual([]);
  });
});
