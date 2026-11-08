/**
 * Register one set of tools on the live agents that should see them.
 *
 * Several rows add tools per agent instead of at the profile root: the
 * session-management tools and the Creator-only plugin source tool. They share
 * the same lifecycle: install on every eligible live agent, follow a blank
 * session's preset change, and remove on disposal. Keeping that loop here makes
 * the policy the only difference between the rows.
 *
 * @module @zhming0/dsh-yawn/per-agent-tools
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

/** The part of an agent-scoped injection the registry keeps. */
interface AgentFiber {
  dispose(): unknown;
}

export interface PerAgentToolsOptions {
  /** Logger label for registration warnings. */
  readonly label: string;
  readonly tools: readonly ToolDefinition[];
  /** Whether this agent's live composition may see the tools. */
  readonly allow: (agent: Agent) => boolean;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Install the tools on eligible agents and keep them in sync with presets. */
export function registerPerAgentTools(
  ctx: Context,
  options: PerAgentToolsOptions,
): void {
  const installed = new Map<Agent, AgentFiber>();
  let disposed = false;

  const install = (agent: Agent): void => {
    if (disposed || installed.has(agent) || !options.allow(agent)) {
      return;
    }
    try {
      const fiber = agent.ctx.inject(["tools"], (agentScope) => {
        // The injection can settle after a preset change or row disposal.
        if (disposed || !options.allow(agent)) {
          return;
        }
        agentScope.effect(() => {
          const disposers: Array<() => void> = [];
          try {
            for (const tool of options.tools) {
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
      ctx
        .logger(options.label)
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
      void Promise.resolve(fiber.dispose()).catch((error: unknown) => {
        ctx
          .logger(options.label)
          .warn(
            `could not remove from agent ${String(agent.id)}: ${describeError(error)}`,
          );
      });
    } catch (error) {
      ctx
        .logger(options.label)
        .warn(
          `could not remove from agent ${String(agent.id)}: ${describeError(error)}`,
        );
    }
  };

  const reconcile = (): void => {
    if (disposed) {
      return;
    }
    const live = new Set(ctx.agents.list());
    for (const agent of live) {
      if (options.allow(agent)) {
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

  ctx.on("agent/created", ({ agent }) => {
    install(agent);
    return undefined;
  });
  ctx.on("agent/disposed", ({ agent }) => {
    remove(agent);
  });
  // A blank session can be moved to another preset in the Web UI. That
  // rebinds the composition and emits `tools/change`; re-read the live preset
  // instead of trusting the creation header.
  let scheduled = false;
  ctx.on("tools/change", () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      reconcile();
    });
  });
  ctx.effect(() => () => {
    disposed = true;
    for (const agent of [...installed.keys()]) {
      remove(agent);
    }
  });
  // Existing agents on a reload or HMR swap; `agent/created` covers new ones
  // from here on.
  reconcile();
}
