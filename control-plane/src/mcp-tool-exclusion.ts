/**
 * Hides MCP tools and prompt text from the agents that should not see them:
 * presets meant to stay tiny, and sessions that turned servers off.
 *
 * The control plane mounts every configured MCP server once, at the host
 * root, so its tools join the global tool registry and every agent inherits
 * them. That is deliberate: one connection, one OAuth renewal, one namespace
 * per server. It also means the `minimal` preset — whose whole composition is
 * a persona and one persistent shell — would otherwise carry the full schema
 * of every connected server, exactly the cost it exists to avoid.
 *
 * Upstream has no special case for this either: `dsh-mcp-client` registers
 * its tools in the scope where the row is mounted, so a profile that mounts it
 * inside `preset-minimal` simply has no MCP tools there. This deployment
 * cannot use that shape because servers are added and removed at runtime from
 * the Web UI and share one connection across sessions.
 *
 * This row keeps the shared mount and denies MCP tools on the agents whose
 * live composition is one of the configured presets instead. The live preset
 * comes from the agent-preset registry, not the session header: the header
 * records only the preset a session STARTED with, while the Web UI picks a
 * preset for a blank session through `agentPresets.select`, which rebinds the
 * agent's composition — for example from `standard` to `minimal` — and
 * appends the durable `agent-preset/selected` event without rewriting that
 * creation fact. The registry emits `tools/change` when `select` moves a
 * blank session to another preset, so every live agent's preset is re-read
 * there and the exact-name deny list is recomputed on every registry change;
 * the deny list must also follow server add/remove, reconnect, and tool-list
 * updates for the same reason. A fresh session's first mount emits no such
 * event, so `agent/created` covers it.
 * The default preset list holds `minimal`, whose persona declares `complete`:
 * the assembly drops every prompt section, so no MCP prompt text reaches it
 * either, and hiding the tool schemas is the whole policy there.
 *
 * The row also hides the servers one session turned off in the New Session
 * row's MCP menu, read from the sandbox manager. Those agents run a full persona,
 * so hiding schemas is not enough: each server's `mcp:<server>` instructions
 * section is dropped from the assembled prompt, and the shared
 * `mcp-resource-servers` section either loses the hidden names or, once the
 * resource tools are hidden too, goes entirely. The sandbox manager emits
 * `sandbox-manager/session-mcp-change` when a choice changes.
 *
 * @module @zhming0/dsh-yawn/mcp-tool-exclusion
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  AssembledSection,
  PromptPresentation,
} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

import { isToolOfServer } from "./mcp-store.js";

/** Presets excluded unless the row config names another list. */
export const DEFAULT_EXCLUDED_PRESETS = ["minimal"] as const;

export interface Config {
  /**
   * Agent preset ids that must not see MCP tools. The default is the stock
   * shell-only preset; an empty list disables the row.
   */
  excludedPresets: string[];
}

export const Config = z.object({
  excludedPresets: z.array(z.string()).default([...DEFAULT_EXCLUDED_PRESETS]),
}) as z<Partial<Config>, Config>;

/**
 * dsh-mcp-resources' three shared tools. A configured server registers them
 * in the caller's scope beside the `mcp__*` server tools; this deployment
 * mounts servers at the host root, so all of them live in the global registry.
 */
const MCP_RESOURCE_TOOL_NAMES = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

/** Whether one tool name belongs to an MCP server or the shared resource tools. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__") || MCP_RESOURCE_TOOL_NAMES.has(name);
}

/** The MCP names in one list of registered tool names, sorted. */
export function mcpToolNames(names: readonly string[]): string[] {
  return names.filter(isMcpToolName).sort();
}

/**
 * What one session hides: the servers it turned off, and whether those are
 * every enabled server. The second is decided from the configured servers,
 * not from the tools registered right now, so a server that is still
 * connecting, or one that offers only resources, cannot flip the shared
 * resource tools on or off mid-session.
 */
export interface SessionHiddenServers {
  servers: readonly string[];
  everyServer: boolean;
}

/** What one session hides, as the row works with it. */
export interface HiddenSessionServers {
  servers: ReadonlySet<string>;
  everyServer: boolean;
}

/** Which MCP servers one agent must not see; "all" for an excluded preset. */
export type HiddenServers = "all" | HiddenSessionServers;

/**
 * The tool names one agent must not see, sorted: every MCP name for an
 * excluded preset, otherwise the hidden servers' tools, plus the shared
 * resource tools once every server is hidden.
 */
export function hiddenMcpToolNames(
  names: readonly string[],
  hidden: HiddenServers,
): string[] {
  const mcp = mcpToolNames(names);
  if (hidden === "all") {
    return mcp;
  }
  return mcp.filter((name) =>
    MCP_RESOURCE_TOOL_NAMES.has(name)
      ? hidden.everyServer
      : [...hidden.servers].some((server) => isToolOfServer(name, server)),
  );
}

const RESOURCE_SECTION = "mcp-resource-servers";
/**
 * dsh-mcp-resources 0.2.1-rc.2 ends its section with "...as the server
 * argument: <JSON list of names>." (`lib/index.js`). The fixture in
 * mcp-tool-exclusion.test.ts is copied from that release, so a dsh upgrade
 * that changes the sentence fails there.
 */
const RESOURCE_SERVER_LIST = /(\[[^\]]*\])\.$/;

/**
 * Remove the hidden servers from one assembly's prompt sections: their
 * `mcp:<server>` instructions, and their names in the resource section. The
 * resource section goes entirely when every server is hidden or none is left
 * in it. A resource section this cannot read is kept and reported through
 * `warn`, because guessing at another package's text could drop the wrong
 * part.
 */
export function withoutHiddenMcpSections(
  sections: readonly AssembledSection[],
  hidden: HiddenSessionServers,
  warn: (message: string) => void,
): AssembledSection[] {
  const result: AssembledSection[] = [];
  for (const section of sections) {
    if (
      section.name.startsWith("mcp:") &&
      hidden.servers.has(section.name.slice("mcp:".length))
    ) {
      continue;
    }
    if (section.name !== RESOURCE_SECTION) {
      result.push(section);
      continue;
    }
    if (hidden.everyServer) {
      continue;
    }
    const remaining = remainingResourceServers(section.text, hidden.servers);
    if (remaining === undefined) {
      warn(
        `mcp-tool-exclusion: cannot read the ${RESOURCE_SECTION} prompt section; hidden MCP server names stay in it`,
      );
      result.push(section);
    } else if (remaining.length > 0) {
      result.push({
        ...section,
        text: section.text.replace(
          RESOURCE_SERVER_LIST,
          `${JSON.stringify(remaining)}.`,
        ),
      });
    }
  }
  return result;
}

function remainingResourceServers(
  text: string,
  hidden: ReadonlySet<string>,
): string[] | undefined {
  const match = RESOURCE_SERVER_LIST.exec(text);
  if (match?.[1] === undefined) {
    return undefined;
  }
  let names: unknown;
  try {
    names = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(names) ||
    names.some((name: unknown) => typeof name !== "string")
  ) {
    return undefined;
  }
  return (names as string[]).filter((name) => !hidden.has(name));
}

/** The per-session choice read face of the sandbox manager. */
interface SessionMcpLike {
  hiddenMcpServers(agent: Agent): SessionHiddenServers;
}

/**
 * The live-preset read face of the agent-preset registry. Only the Web
 * surface mounts the registry; a profile without it composes no presets, so
 * every agent runs the host composition and nothing is excluded.
 */
interface AgentPresetsLike {
  /** Read the preset a live agent runs, or undefined when it runs none. */
  composedPreset(ctx: Context): string | undefined;
}

/** The part of a Cordis fiber this module owns. */
interface FiberLike {
  dispose(): unknown;
}

/** One restricted agent's live mask. */
interface AgentPolicy {
  fiber: FiberLike;
  /** Set before a disposed agent's injected scope callback can still run. */
  disposed?: boolean | undefined;
  /** Set once the agent's injected tools scope is live. */
  update?: ((names: readonly string[]) => void) | undefined;
  /** The exact disposer that lifts the current restriction. */
  restriction?: (() => void) | undefined;
  /** The names currently denied; undefined until the first update. */
  names?: readonly string[] | undefined;
}

function sameNames(
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((name, index) => name === right[index])
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Hides MCP tools from the matching agents and tracks them until disposal. */
export class McpToolExclusion {
  private readonly agents = new Map<Agent, AgentPolicy>();
  private readonly excluded: Set<string>;
  private disposed = false;
  private reconciling = false;
  private recheck = false;

  constructor(
    private readonly options: {
      excludedPresets: readonly string[];
      /** The live preset of one agent, undefined when it runs none. */
      presetFor: (agent: Agent) => string | undefined;
      /** What one agent's session turned off. */
      sessionHiddenFor: (agent: Agent) => SessionHiddenServers;
      /** Every live agent, so registry changes re-read each live preset. */
      agents: () => readonly Agent[];
      /** Every name in the global tool registry, MCP or not. */
      toolNames: () => readonly string[];
      warn: (message: string) => void;
    },
  ) {
    this.excluded = new Set(options.excludedPresets);
  }

  /**
   * The servers one agent must not see: all of them for an excluded preset,
   * otherwise its session's choice; undefined when it sees every server.
   */
  hiddenServers(agent: Agent): HiddenServers | undefined {
    if (this.excluded.size > 0) {
      const preset = this.options.presetFor(agent);
      if (preset !== undefined && this.excluded.has(preset)) {
        return "all";
      }
    }
    const { servers, everyServer } = this.options.sessionHiddenFor(agent);
    return servers.length === 0
      ? undefined
      : { servers: new Set(servers), everyServer };
  }

  private hiddenNames(agent: Agent, names: readonly string[]): string[] {
    const hidden = this.hiddenServers(agent);
    return hidden === undefined ? [] : hiddenMcpToolNames(names, hidden);
  }

  /** Apply or lift the restriction for one agent's preset and choice. */
  sync(
    agent: Agent,
    toolNames: () => readonly string[] = () => this.options.toolNames(),
  ): void {
    if (this.disposed) {
      return;
    }
    if (this.hiddenServers(agent) !== undefined) {
      this.install(agent, toolNames);
    } else {
      this.remove(agent);
    }
  }

  /** Start hiding MCP tools from one agent when it should not see some. */
  install(
    agent: Agent,
    toolNames: () => readonly string[] = () => this.options.toolNames(),
  ): void {
    if (
      this.disposed ||
      this.agents.has(agent) ||
      this.hiddenServers(agent) === undefined
    ) {
      return;
    }
    const policy: AgentPolicy = {
      fiber: { dispose: () => undefined },
    };
    this.agents.set(agent, policy);
    try {
      policy.fiber = agent.ctx.inject(["tools"], (scope) => {
        if (policy.disposed === true) {
          return;
        }
        policy.update = (names) => {
          if (sameNames(policy.names, names)) {
            return;
          }
          // Install the new mask before lifting the old one, so a failed
          // restrict leaves the previous mask in place and retries on the
          // next registry change.
          let next: (() => void) | undefined;
          if (names.length > 0) {
            try {
              next = scope.tools.restrict({ deny: [...names] });
            } catch (error) {
              this.options.warn(
                `mcp-tool-exclusion: could not hide MCP tools from agent ${agent.id}: ${describe(error)}`,
              );
              return;
            }
          }
          const previous = policy.restriction;
          policy.restriction = next;
          policy.names = names;
          previous?.();
        };
        policy.update(this.hiddenNames(agent, toolNames()));
      });
    } catch (error) {
      this.agents.delete(agent);
      this.options.warn(
        `mcp-tool-exclusion: could not watch agent ${agent.id}: ${describe(error)}`,
      );
      return;
    }
  }

  /** Drop one agent's policy, lifting its mask. */
  remove(agent: Agent): void {
    const policy = this.agents.get(agent);
    if (policy === undefined) {
      return;
    }
    this.agents.delete(agent);
    policy.disposed = true;
    try {
      void Promise.resolve(policy.fiber.dispose()).catch((error: unknown) => {
        this.options.warn(
          `mcp-tool-exclusion: could not release agent ${agent.id}: ${describe(error)}`,
        );
      });
    } catch (error) {
      this.options.warn(
        `mcp-tool-exclusion: could not release agent ${agent.id}: ${describe(error)}`,
      );
    }
  }

  /** Reapply the policy after any tool- or preset-registry change. */
  reconcile(): void {
    if (this.disposed) {
      return;
    }
    if (this.reconciling) {
      this.recheck = true;
      return;
    }
    this.reconciling = true;
    try {
      // Project the registry once for the whole pass. `schemas()` deep-clones
      // every tool definition, so computing it per agent made each new session
      // and each MCP toggle cost (live agents x tool schemas).
      let projected: readonly string[] | undefined;
      const toolNames = () => (projected ??= this.options.toolNames());
      do {
        this.recheck = false;
        for (const agent of this.options.agents()) {
          this.sync(agent, toolNames);
        }
        for (const [agent, policy] of this.agents) {
          policy.update?.(this.hiddenNames(agent, toolNames()));
        }
      } while (this.recheck);
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Drop every policy, e.g. when the row unloads. Lifting a mask emits
   * `tools/change`, and Cordis unwinds the row's own effect before its
   * listeners, so the flag must be set before the first fiber goes down.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const agent of [...this.agents.keys()]) {
      this.remove(agent);
    }
  }
}

export const name = "mcp-tool-exclusion";

export function apply(ctx: Context, config: Config): void {
  const warn = (message: string) =>
    ctx.logger("mcp-tool-exclusion").warn(message);
  ctx.inject(["agents", "tools"], (scope) => {
    const exclusion = new McpToolExclusion({
      excludedPresets: config.excludedPresets,
      presetFor: (agent) => {
        const presets = scope.get("agentPresets") as
          | AgentPresetsLike
          | undefined;
        return presets?.composedPreset(agent.ctx);
      },
      sessionHiddenFor: (agent) => {
        const manager = scope.get("sandboxManager") as
          | SessionMcpLike
          | undefined;
        return (
          manager?.hiddenMcpServers(agent) ?? {
            servers: [],
            everyServer: false,
          }
        );
      },
      agents: () => scope.agents.list(),
      toolNames: () => scope.tools.schemas().map((schema) => schema.name),
      warn,
    });
    // Covers agents that already exist when the row mounts; a later
    // `tools/change` covers a preset rebound on a blank session.
    exclusion.reconcile();
    scope.on("agent/created", ({ agent }) => {
      exclusion.sync(agent);
      return undefined;
    });
    scope.on("agent/disposed", ({ agent }) => exclusion.remove(agent));
    scope.on("tools/change", () => exclusion.reconcile());
    scope.on("sandbox-manager/session-mcp-change", () => exclusion.reconcile());
    // Tool masks hide schemas; the hidden servers' prompt text goes here. An
    // excluded preset is skipped: its complete persona replaces every section.
    scope.on(
      "system-prompt/assemble",
      async (_assembly, context, next): Promise<PromptPresentation> => {
        const assembly = await next();
        const hidden =
          context.agent === undefined
            ? undefined
            : exclusion.hiddenServers(context.agent);
        if (hidden === undefined || hidden === "all") {
          return assembly;
        }
        return {
          ...assembly,
          sections: withoutHiddenMcpSections(assembly.sections, hidden, warn),
        };
      },
    );
    scope.effect(() => () => exclusion.dispose());
  });
}
