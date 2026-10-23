/**
 * Native tools that let one session manage other top-level sessions.
 *
 * dsh already has subagents, but a subagent shares its parent's sandbox and
 * lives inside the parent's turn. These tools act on ordinary top-level
 * sessions instead: each one has its own sandbox, appears in the Web UI, and
 * survives the turn that created it. A session can list workspaces and
 * sessions, create a child session, send it a message, wait for it to become
 * idle, and cancel its active turn. The child reports a result back with
 * `send_message`; these tools deliberately never return another session's
 * transcript, because that would merge untrusted context into the caller.
 *
 * The tools are registered per agent rather than globally, so subagents and
 * preset-excluded agents (the stock `minimal` preset by default) never see
 * them. Registering through `agent.ctx` is what makes the tool set follow an
 * agent's live preset; `tools/change` re-reads the preset after the Web UI
 * rebinds a blank session.
 *
 * The calling agent is taken from the tool execution, not from an argument:
 * `send_message` and `create_session` prepend `[from session <id>]` so the
 * target can answer, and `send_message`, `wait_session`, and
 * `interrupt_session` reject the calling session itself.
 *
 * @module @zhming0/dsh-yawn/session-tools
 */

import { randomUUID } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import type {
  SessionRequestId,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller";
import type { WorkspaceId } from "@deepseek-ai/dsh-api-workspace-controller";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

import type { SessionProfileView } from "./session-profile-remote.js";
import {
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

/** Presets excluded unless the row config names another list. */
export const DEFAULT_EXCLUDED_PRESETS = ["minimal"] as const;

export interface Config {
  /**
   * Agent preset ids that must not see the session tools. The default is the
   * stock shell-only preset; an empty list gives every top-level session the
   * tools.
   */
  excludedPresets: string[];
}

export const Config = z.object({
  excludedPresets: z.array(z.string()).default([...DEFAULT_EXCLUDED_PRESETS]),
}) as z<Partial<Config>, Config>;

/** The session-controller methods these tools use. */
type SessionControl = Pick<
  Context["sessionController"],
  | "list"
  | "create"
  | "rename"
  | "prompt"
  | "cancel"
  | "follow"
  | "selectModel"
  | "modelCatalog"
>;

/** The sandbox-manager methods these tools use. */
interface SandboxControl {
  listSandboxProfiles(): Promise<SessionProfileView>;
  setSessionProfile(
    sessionId: string,
    profile: string,
  ): Promise<SessionProfileView>;
}

/** The workspace registry methods these tools use. */
interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[];
}

interface WorkspaceLike {
  readonly id: WorkspaceId;
  readonly path: string;
  readonly title: string;
  readonly sessionIds: readonly SessionId[];
}

export interface SessionToolDeps {
  sessions: SessionControl;
  sandbox: SandboxControl;
  workspaces: WorkspaceRegistryLike;
  /** Host directory of the Scratch workspace, used when no workspace is named. */
  scratchWorkspace: string;
}

/** A JSON object this module builds for a tool result. */
type JsonRecord = { [key: string]: JsonValue };

/**
 * Build the tool definitions once; the same stateless definitions register in
 * every eligible agent's scope.
 */
export function createSessionTools(deps: SessionToolDeps): ToolDefinition[] {
  const listWorkspaces = defineTool({
    name: "list_workspaces",
    description:
      "List DSH workspaces with their ids, titles, paths, and session counts. Use a workspace_id with create_session.",
    parameters: {},
    output: {
      schema: { type: "json" },
      render: (_args, value) => textValue(value),
    },
    async execute() {
      return deps.workspaces.list().map((workspace) => ({
        workspace_id: String(workspace.id),
        title: workspace.title,
        path: workspace.path,
        session_count: workspace.sessionIds.length,
        scratch: workspace.path === deps.scratchWorkspace,
      }));
    },
  });

  const listModels = defineTool({
    name: "list_models",
    description:
      "List routable provider/model routes and the deployment default. Use a provider and model id as the model argument of create_session.",
    parameters: {},
    output: {
      schema: { type: "json" },
      render: (_args, value) => textValue(value),
    },
    async execute() {
      return (await deps.sessions.modelCatalog()) as unknown as JsonValue;
    },
  });

  const listSandboxProfiles = defineTool({
    name: "list_sandbox_profiles",
    description:
      "List sandbox profile names and backends, plus the deployment default. Use a name as the sandbox_profile argument of create_session.",
    parameters: {},
    output: {
      schema: { type: "json" },
      render: (_args, value) => textValue(value),
    },
    async execute() {
      return (await deps.sandbox.listSandboxProfiles()) as unknown as JsonValue;
    },
  });

  const createSession = defineTool({
    name: "create_session",
    description:
      "Create a new top-level DSH session in a workspace (Scratch by default). The session runs in its own sandbox and appears in the Web UI. Optionally send a first message; without one the session stays idle until send_message. Returns the new session_id.",
    parameters: {
      workspace_id: {
        type: "string",
        description:
          "Workspace id from list_workspaces. Defaults to the Scratch workspace.",
      },
      workspace: {
        type: "string",
        description:
          "Workspace id, title, or path, used only when workspace_id is omitted.",
      },
      cwd: {
        type: "string",
        description:
          "Host directory for an ungrouped session. Prefer workspace_id; this is not a sandbox path.",
      },
      title: {
        type: "string",
        description: "Title shown in the Web UI. Optional.",
      },
      prompt: {
        type: "string",
        description:
          "First message to send to the new session. Optional; the message carries the calling session id.",
      },
      mode: {
        type: "string",
        enum: ["queue", "steer"],
        description:
          "How the first prompt enters the session: queue for its next turn, or steer to interrupt. Defaults to queue.",
      },
      agent_preset: {
        type: "string",
        description:
          "Agent preset id for the new session. Optional; uses the deployment default. Use a preset with these session tools if the child should report back.",
      },
      sandbox_profile: {
        type: "string",
        description:
          "Sandbox profile name from list_sandbox_profiles. Optional; uses the deployment default.",
      },
      model: {
        type: "object",
        additionalProperties: false,
        properties: {
          provider: {
            type: "string",
            required: true,
            description: "Provider id from list_models.",
          },
          model: {
            type: "string",
            required: true,
            description: "Model id from list_models.",
          },
          reasoning_effort: {
            type: "string",
            description: "Reasoning effort id from list_models. Optional.",
          },
        },
        description:
          "Session model. Optional; uses the deployment default. Selecting a model also updates that default, as the Web UI model picker does.",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => textValue(value),
    },
    async execute(args, exec) {
      const agent = callingAgent(exec);
      const placement = resolvePlacement(args, deps);
      if (args.sandbox_profile !== undefined) {
        const profiles = await deps.sandbox.listSandboxProfiles();
        if (
          !profiles.profiles.some(
            (profile) => profile.name === args.sandbox_profile,
          )
        ) {
          throw new Error(
            `unknown sandbox profile "${args.sandbox_profile}"; call list_sandbox_profiles first`,
          );
        }
      }
      if (args.model !== undefined) {
        const catalog = await deps.sessions.modelCatalog();
        const provider = catalog.groups.find(
          (group) => group.id === args.model?.provider,
        );
        const route = provider?.models.find(
          (candidate) => candidate.id === args.model?.model,
        );
        if (route === undefined) {
          throw new Error(
            `model "${args.model.provider}/${args.model.model}" is not available; call list_models first`,
          );
        }
        if (
          args.model.reasoning_effort !== undefined &&
          route.reasoning !== undefined &&
          !route.reasoning.efforts.some(
            (effort) => effort.id === args.model?.reasoning_effort,
          )
        ) {
          throw new Error(
            `model "${args.model.provider}/${args.model.model}" has no reasoning effort "${args.model.reasoning_effort}"; call list_models first`,
          );
        }
      }
      const created = await deps.sessions.create({
        ...placement,
        ...(args.agent_preset === undefined
          ? {}
          : { agentPreset: args.agent_preset }),
      });
      const sessionId = created.sessionId;
      const result: JsonRecord = {
        session_id: String(sessionId),
        ...("workspaceId" in placement
          ? { workspace_id: String(placement.workspaceId) }
          : { cwd: placement.cwd }),
        ...(created.agentPreset === undefined
          ? {}
          : { agent_preset: created.agentPreset }),
      };

      let settingsFailed = false;
      if (args.sandbox_profile !== undefined) {
        try {
          const profile = await deps.sandbox.setSessionProfile(
            String(sessionId),
            args.sandbox_profile,
          );
          result.sandbox_profile = profile.selected;
        } catch (error) {
          result.sandbox_profile_error = describeError(error);
          settingsFailed = true;
        }
      }
      if (args.model !== undefined) {
        try {
          const selected = await deps.sessions.selectModel({
            sessionId,
            provider: args.model.provider,
            model: args.model.model,
            ...(args.model.reasoning_effort === undefined
              ? {}
              : { reasoningEffort: args.model.reasoning_effort }),
          });
          result.model = {
            provider: selected.selected.provider,
            model: selected.selected.model,
            ...(selected.selected.reasoningEffort === undefined
              ? {}
              : { reasoning_effort: selected.selected.reasoningEffort }),
          };
        } catch (error) {
          result.model_error = describeError(error);
          settingsFailed = true;
        }
      }

      if (args.title !== undefined) {
        try {
          result.title = (
            await deps.sessions.rename({ sessionId, title: args.title })
          ).title;
        } catch (error) {
          result.title_error = describeError(error);
        }
      }

      if (
        !settingsFailed &&
        args.prompt !== undefined &&
        args.prompt.trim() !== ""
      ) {
        try {
          await sendMessage(deps.sessions, {
            sessionId,
            text: args.prompt,
            mode: args.mode ?? "queue",
            callerId: String(agent.id),
            signal: withTimeout(exec.signal, 30_000),
          });
        } catch (error) {
          result.prompt_error = describeError(error);
        }
      }
      return result;
    },
  });

  const sendMessageTool = defineTool({
    name: "send_message",
    description:
      "Send a message to another top-level session. mode=queue adds it to the target's inbox for its next turn; mode=steer interrupts its current turn. The message carries the calling session id so the target can reply.",
    parameters: {
      session_id: {
        type: "string",
        required: true,
        description: "Target session id.",
      },
      text: {
        type: "string",
        required: true,
        description: "Message text.",
      },
      mode: {
        type: "string",
        enum: ["queue", "steer"],
        description:
          "queue adds the message to the target's inbox for its next turn; steer interrupts its current turn. Defaults to queue.",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => textValue(value),
    },
    async execute(args, exec) {
      const agent = callingAgent(exec);
      const sessionId = targetSessionId(
        args.session_id,
        agent,
        "send a message to",
      );
      await sendMessage(deps.sessions, {
        sessionId,
        text: args.text,
        mode: args.mode ?? "queue",
        callerId: String(agent.id),
        signal: withTimeout(exec.signal, 30_000),
      });
      return { accepted: true, session_id: args.session_id };
    },
  });

  const waitSession = defineTool({
    name: "wait_session",
    description:
      "Wait up to timeout_seconds for a session to become idle. It waits briefly after a prompt so a just-started turn is not mistaken for idle. When the session is idle, the result includes its last assistant message as untrusted text, so the caller can collect the child's answer without reading its transcript. If it reports running=true with timed_out=true, call wait_session again.",
    parameters: {
      session_id: {
        type: "string",
        required: true,
        description: "Session id to wait for.",
      },
      timeout_seconds: {
        type: "integer",
        description: "Maximum wait in seconds, 1-50. Defaults to 30.",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => textValue(value),
    },
    timeoutMs: 55_000,
    async execute(args, exec) {
      const agent = callingAgent(exec);
      const sessionId = targetSessionId(args.session_id, agent, "wait for");
      const timeout = clamp(args.timeout_seconds ?? 30, 1, 50);
      const deadline = Date.now() + timeout * 1_000;
      let checks = 0;
      let observedRunning = false;
      for (;;) {
        const row = await findSession(
          deps.sessions,
          sessionId,
          withTimeout(exec.signal, 10_000),
        );
        if (row === undefined) {
          throw new Error(`session "${args.session_id}" not found`);
        }
        if (row.origin === "subagent") {
          throw new Error(
            `session "${args.session_id}" is a subagent; its parent session manages it`,
          );
        }
        if (row.running) {
          observedRunning = true;
        } else if (observedRunning || checks > 0) {
          return idleWaitResult(
            deps.sessions,
            args.session_id,
            row,
            exec.signal,
          );
        }
        if (Date.now() >= deadline) {
          return waitResult(args.session_id, row, true);
        }
        checks += 1;
        await sleep(500, exec.signal);
      }
    },
  });

  const interruptSession = defineTool({
    name: "interrupt_session",
    description:
      "Interrupt the session's active turn: the current model response and any tool calls it is running. Queued and steering messages are kept, and the session stays alive and can run again. This does not delete or stop the session.",
    parameters: {
      session_id: {
        type: "string",
        required: true,
        description: "Session id whose active turn should be interrupted.",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => textValue(value),
    },
    async execute(args, exec) {
      const agent = callingAgent(exec);
      const sessionId = targetSessionId(args.session_id, agent, "interrupt");
      const result = deps.sessions.cancel({ sessionId });
      return { accepted: result.accepted, session_id: args.session_id };
    },
  });

  return [
    listWorkspaces,
    listModels,
    listSandboxProfiles,
    createSession,
    sendMessageTool,
    waitSession,
    interruptSession,
  ];
}

export const name = "session-tools";

interface AgentPresetsLike {
  /** The preset a live agent runs, or undefined when it runs none. */
  composedPreset(ctx: Context): string | undefined;
}

export function apply(ctx: Context, config: Config): void {
  ctx.inject(
    ["agents", "sessionController", "workspaceRegistry", "sandboxManager"],
    (scope) => {
      const workspaces = scope.get("workspaceRegistry") as
        | WorkspaceRegistryLike
        | undefined;
      if (workspaces === undefined) {
        return;
      }
      const tools = createSessionTools({
        sessions: scope.sessionController,
        sandbox: scope.sandboxManager,
        workspaces,
        scratchWorkspace: scope.sandboxManager.scratchWorkspace,
      });
      const excluded = new Set(config.excludedPresets);
      const installed = new Map<Agent, { dispose(): unknown }>();
      let disposed = false;

      const presetFor = (agent: Agent): string | undefined => {
        const presets = scope.get("agentPresets") as
          | AgentPresetsLike
          | undefined;
        return presets?.composedPreset(agent.ctx);
      };

      const allowed = (agent: Agent): boolean => {
        if (agent.session.header.origin === "subagent") {
          return false;
        }
        const preset = presetFor(agent);
        return preset === undefined || !excluded.has(preset);
      };

      const install = (agent: Agent): void => {
        if (disposed || installed.has(agent) || !allowed(agent)) {
          return;
        }
        try {
          const fiber = agent.ctx.inject(["tools"], (agentScope) => {
            agentScope.effect(() => {
              const disposers: Array<() => void> = [];
              try {
                for (const tool of tools) {
                  disposers.push(agentScope.tools.register(tool));
                }
              } catch (error) {
                for (const dispose of disposers) {
                  dispose();
                }
                throw error;
              }
              return () => {
                for (const dispose of disposers) {
                  dispose();
                }
              };
            });
          });
          installed.set(agent, fiber);
        } catch (error) {
          scope
            .logger("session-tools")
            .warn(
              `could not install on agent ${String(agent.id)}: ${describeError(error)}`,
            );
        }
      };

      const remove = (agent: Agent): void => {
        const fiber = installed.get(agent);
        if (fiber === undefined) {
          return;
        }
        installed.delete(agent);
        try {
          fiber.dispose();
        } catch (error) {
          scope
            .logger("session-tools")
            .warn(
              `could not remove from agent ${String(agent.id)}: ${describeError(error)}`,
            );
        }
      };

      const reconcile = (): void => {
        if (disposed) {
          return;
        }
        const live = new Set(scope.agents.list());
        for (const agent of live) {
          if (allowed(agent)) {
            install(agent);
          } else {
            remove(agent);
          }
        }
        for (const agent of [...installed.keys()]) {
          if (!live.has(agent)) {
            remove(agent);
          }
        }
      };

      scope.on("agent/created", ({ agent }) => {
        install(agent);
        return undefined;
      });
      scope.on("agent/disposed", ({ agent }) => {
        remove(agent);
      });
      // A blank session can be moved to another preset in the Web UI. That
      // rebinds the composition and emits `tools/change`; re-read the live
      // preset instead of trusting the creation header.
      let scheduled = false;
      scope.on("tools/change", () => {
        if (scheduled) {
          return;
        }
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          reconcile();
        });
      });
      scope.effect(() => () => {
        disposed = true;
        for (const agent of [...installed.keys()]) {
          remove(agent);
        }
      });
      // Existing agents on a reload or HMR swap; `agent/created` covers new
      // ones from here on.
      reconcile();
    },
  );
}

function waitResult(
  sessionId: string,
  row: SessionSummary,
  timedOut: boolean,
): JsonRecord {
  return {
    session_id: sessionId,
    running: row.running,
    timed_out: timedOut,
    updated_at: new Date(row.updatedAt).toISOString(),
  };
}

async function idleWaitResult(
  sessions: SessionControl,
  sessionId: string,
  row: SessionSummary,
  callerSignal: AbortSignal,
): Promise<JsonRecord> {
  const result = waitResult(sessionId, row, false);
  try {
    const message = await lastAssistantMessage(
      sessions,
      sessionId as SessionId,
      callerSignal,
    );
    if (message !== undefined) {
      result.last_message = `[untrusted final message from session ${sessionId}]\n${message}`;
    }
  } catch (error) {
    if (callerSignal.aborted) {
      throw error;
    }
    result.last_message_error = describeError(error);
  }
  return result;
}

async function lastAssistantMessage(
  sessions: SessionControl,
  sessionId: SessionId,
  callerSignal: AbortSignal,
): Promise<string | undefined> {
  const stop = new AbortController();
  const signal = AbortSignal.any([
    callerSignal,
    stop.signal,
    AbortSignal.timeout(5_000),
  ]);
  try {
    for await (const frame of sessions.follow(
      {
        address: { kind: "session", sessionId },
        maxMessages: 20,
      },
      signal,
    )) {
      if (frame.type !== "snapshot") {
        continue;
      }
      for (let index = frame.records.length - 1; index >= 0; index -= 1) {
        const record = frame.records[index];
        if (
          record?.type !== "event" ||
          record.event.type !== "assistant/message"
        ) {
          continue;
        }
        const data = asRecord(record.event.data);
        const message = asRecord(data?.message);
        const text = blocksText(message?.content);
        if (text !== undefined) {
          return truncate(text, 8_000);
        }
      }
      return undefined;
    }
  } finally {
    stop.abort();
  }
  return undefined;
}

async function findSession(
  sessions: SessionControl,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<SessionSummary | undefined> {
  const value = await sessions.list({}, signal);
  return value.items.find((row) => String(row.sessionId) === String(sessionId));
}

async function sendMessage(
  sessions: SessionControl,
  options: {
    sessionId: SessionId;
    text: string;
    mode: "queue" | "steer";
    callerId: string;
    signal: AbortSignal;
  },
): Promise<void> {
  if (options.text.trim() === "") {
    throw new Error("message text must not be empty");
  }
  await sessions.prompt(
    {
      requestId: randomUUID() as SessionRequestId,
      sessionId: options.sessionId,
      mode: options.mode,
      content: [
        {
          type: "text",
          text: `[from session ${options.callerId}]\n\n${options.text}`,
        },
      ],
    },
    options.signal,
  );
}

function resolvePlacement(
  args: {
    workspace_id?: string;
    workspace?: string;
    cwd?: string;
  },
  deps: SessionToolDeps,
): { workspaceId: WorkspaceId } | { cwd: string } {
  const named = args.workspace_id !== undefined || args.workspace !== undefined;
  if (named && args.cwd !== undefined) {
    throw new Error("use workspace_id/workspace or cwd, not both");
  }
  if (args.workspace_id !== undefined && args.workspace !== undefined) {
    throw new Error("use workspace_id or workspace, not both");
  }
  if (args.workspace_id !== undefined) {
    return {
      workspaceId: findWorkspace(deps.workspaces.list(), args.workspace_id).id,
    };
  }
  if (args.workspace !== undefined) {
    const matches = deps.workspaces
      .list()
      .filter(
        (workspace) =>
          String(workspace.id) === args.workspace ||
          workspace.title === args.workspace ||
          workspace.path === args.workspace,
      );
    if (matches.length > 1) {
      throw new Error(
        `workspace "${args.workspace}" is ambiguous; use workspace_id`,
      );
    }
    const match = matches[0];
    if (match === undefined) {
      throw new Error(`workspace "${args.workspace}" not found`);
    }
    return { workspaceId: match.id };
  }
  if (args.cwd !== undefined) {
    return { cwd: args.cwd };
  }
  const scratch =
    deps.workspaces
      .list()
      .find((workspace) => workspace.path === deps.scratchWorkspace) ??
    deps.workspaces.list().find((workspace) => workspace.title === "Scratch");
  return scratch === undefined
    ? { cwd: deps.scratchWorkspace }
    : { workspaceId: scratch.id };
}

function findWorkspace(
  workspaces: readonly WorkspaceLike[],
  id: string,
): WorkspaceLike {
  const workspace = workspaces.find((candidate) => String(candidate.id) === id);
  if (workspace === undefined) {
    throw new Error(`unknown workspace "${id}"; call list_workspaces first`);
  }
  return workspace;
}

function callingAgent(exec: ToolRunContext): Agent {
  const agent = exec.agent;
  if (agent === undefined) {
    throw new Error("session tools require a calling agent");
  }
  return agent;
}

function targetSessionId(
  value: string,
  caller: Agent,
  action: string,
): SessionId {
  if (value === String(caller.id)) {
    throw new Error(`a session cannot ${action} itself`);
  }
  return value as SessionId;
}

function blocksText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const texts: string[] = [];
  for (const item of value) {
    const block = asRecord(item);
    if (block?.type === "text" && typeof block.text === "string") {
      const text = block.text.trim();
      if (text !== "") {
        texts.push(text);
      }
    }
  }
  return texts.length === 0 ? undefined : texts.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function textValue(value: unknown): ContentBlock[] {
  const text =
    typeof value === "string"
      ? value
      : (JSON.stringify(value, null, 2) ?? String(value));
  return [{ type: "text", text }];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
