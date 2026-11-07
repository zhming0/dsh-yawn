/**
 * The Creator-only tool that brings a stored plugin's source back into a
 * session.
 *
 * Every plugin installed from a sandbox workspace is snapshotted into
 * `$DSH_HOME/creator-plugins` by the `creator-bundles` row. That makes the
 * source outlive the sandbox that authored it, but a later session still
 * needs a way to get it into its own workspace: `plugin_source checkout`
 * copies one immutable version there, and the normal file tools edit it
 * before `plugin_manager install_bundle` stores the next version.
 *
 * The tool is registered per agent and only in the presets this row names
 * (`cordis`, the Creator preset, by default). Standard keeps its stock tool
 * surface; a user who wants to edit a plugin can switch to Creator, and the
 * store is control-plane-wide, so switching loses nothing. Subagents keep
 * editing the checkout their parent already has instead of opening a second
 * source path.
 *
 * @module @zhming0/dsh-yawn/plugin-source
 */

import { posix } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import {
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

import { FileType } from "../gen/dsh/yawn/v1/runner_pb.js";
import type { SandboxManager } from "../sandbox/manager/sandbox-manager.js";
import { isInsideSandboxWorkspace } from "../sandbox/sandbox-path.js";
import {
  creatorPluginsRoot,
  installedVersions,
  listStoredPlugins,
  readVersionSnapshot,
  resolveStoredVersion,
  SOURCE_MARKER_FILE,
  versionDirectory,
  type ProfileContextLike,
} from "./store.js";

/** What the tool needs from the control plane. */
export interface PluginSourceDeps {
  readonly home: string;
  readonly profileDir: string;
  readonly sandbox: SandboxManager;
}

interface AgentPresetsLike {
  /** The preset a live agent runs, or undefined when it runs none. */
  composedPreset(ctx: Context): string | undefined;
}

/** Presets that see the source tool unless the row config names another list. */
export const DEFAULT_PRESETS = ["cordis"] as const;

export interface Config {
  /**
   * Agent preset ids that see `plugin_source`. The default is the stock
   * Creator preset; an empty list gives no agent the tool.
   */
  presets: string[];
}

export const Config = z.object({
  presets: z.array(z.string()).default([...DEFAULT_PRESETS]),
}) as z<Partial<Config>, Config>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** One sorted version list, newest first. */
function versionsOf(
  plugin: Awaited<ReturnType<typeof listStoredPlugins>>[number],
): unknown[] {
  return Object.entries(plugin.meta.versions)
    .sort(([, left], [, right]) =>
      right.createdAt.localeCompare(left.createdAt),
    )
    .map(([hash, entry]) => ({
      hash,
      ...(entry.version === undefined ? {} : { version: entry.version }),
      ...(entry.basedOn === undefined ? {} : { basedOn: entry.basedOn }),
      createdAt: entry.createdAt,
    }));
}

/** Build the tool definitions once; the same definition registers per agent. */
export function createPluginSourceTools(
  deps: PluginSourceDeps,
): ToolDefinition[] {
  const source = defineTool({
    name: "plugin_source",
    description:
      "List or check out the source of a plugin created with Creator mode. " +
      "The control plane stores a version whenever a plugin is installed from " +
      "a session workspace, so a later session can edit it even after the " +
      "original sandbox is gone. Use list to find the plugin and its installed " +
      "version, then checkout to copy a version into this session's workspace " +
      "(default plugins/<name>), edit it with the normal file tools, and call " +
      "plugin_manager install_bundle with that directory. Only plugins " +
      "installed from a workspace path have stored source; npm and Git plugins " +
      "do not.",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["list", "checkout"],
        description: "Operation to perform.",
      },
      name: {
        type: "string",
        description: "Stored plugin package name, from list.",
      },
      version: {
        type: "string",
        description:
          "Stored version hash, hash prefix, or package version; defaults to the installed version, else latest.",
      },
      path: {
        type: "string",
        description:
          "Destination directory, relative to the session workspace root; defaults to plugins/<name>.",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: json(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      if (exec.agent === undefined) {
        throw new Error("plugin_source needs a session agent");
      }
      if (args.action === "list") {
        const stored = await listStoredPlugins(deps.home);
        const installed = await installedVersions(
          deps.profileDir,
          creatorPluginsRoot(deps.home),
        );
        return {
          plugins: stored.map((plugin) => {
            const installedHash = installed.get(plugin.name);
            return {
              name: plugin.name,
              latest: plugin.meta.latest === "" ? null : plugin.meta.latest,
              installed: installedHash ?? null,
              versions: versionsOf(plugin) as JsonValue[],
            };
          }),
        };
      }

      if (args.action !== "checkout") {
        throw new Error(
          `unknown plugin_source action "${String(args.action)}"`,
        );
      }
      if (args.name === undefined || args.name === "") {
        throw new Error("checkout requires a stored plugin name");
      }
      const stored = (await listStoredPlugins(deps.home)).find(
        (plugin) => plugin.name === args.name,
      );
      if (stored === undefined) {
        throw new Error(
          `no stored source for "${args.name}"; only plugins installed from a session workspace are stored`,
        );
      }
      const installed = await installedVersions(
        deps.profileDir,
        creatorPluginsRoot(deps.home),
      );
      const requested = args.version ?? installed.get(stored.name);
      const version = resolveStoredVersion(stored.meta, requested);
      const snapshot = await readVersionSnapshot(
        versionDirectory(deps.home, stored.slug, version),
      );

      const client = await deps.sandbox.clientForCurrentAgent();
      const workspace = deps.sandbox.workspace;
      const destination =
        args.path === undefined
          ? posix.join("plugins", stored.name)
          : args.path;
      if (destination === "") {
        throw new Error("checkout path must not be empty");
      }
      const target = posix.isAbsolute(destination)
        ? posix.normalize(destination)
        : posix.normalize(posix.join(workspace, destination));
      if (
        target === workspace ||
        !isInsideSandboxWorkspace(target, workspace)
      ) {
        throw new Error(
          `checkout path "${destination}" must stay inside this session's workspace`,
        );
      }
      const call = { signal: exec.signal };
      const existing = await client.stat(
        { path: target, followSymlinks: false },
        call,
      );
      if (existing.exists) {
        if (existing.type !== FileType.DIRECTORY) {
          throw new Error(
            `checkout path "${target}" already exists; choose another path`,
          );
        }
        const contents = await client.list(target, call);
        if (contents.entries.length > 0) {
          throw new Error(
            `checkout path "${target}" is not empty; choose another path`,
          );
        }
      }

      const files = [...snapshot.files].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      for (const [relative, bytes] of files) {
        await client.writeFile(
          {
            path: posix.join(target, ...relative.split("/")),
            content: bytes,
            guard: { case: "createIfAbsent", value: true },
            mode: 0o644,
          },
          call,
        );
      }
      const marker = new TextEncoder().encode(
        `${JSON.stringify({ name: stored.name, version })}\n`,
      );
      await client.writeFile(
        {
          path: posix.join(target, SOURCE_MARKER_FILE),
          content: marker,
          guard: { case: "createIfAbsent", value: true },
          mode: 0o644,
        },
        call,
      );

      return {
        name: stored.name,
        version,
        path: target,
        files: files.length,
      };
    },
  });
  return [source];
}

/** Register the tool on the live agents whose preset is in the allowlist. */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(["agents", "sandboxManager", "profileContext"], (scope) => {
    const profile = scope.get("profileContext") as
      | ProfileContextLike
      | undefined;
    const sandbox = scope.get("sandboxManager");
    if (profile === undefined || sandbox === undefined) {
      return;
    }
    const tools = createPluginSourceTools({
      home: profile.home,
      profileDir: profile.dir,
      sandbox,
    });
    const allowedPresets = new Set(config.presets);
    const installed = new Map<Agent, { dispose(): unknown }>();
    let disposed = false;

    const presetFor = (agent: Agent): string | undefined => {
      const presets = scope.get("agentPresets") as AgentPresetsLike | undefined;
      return presets?.composedPreset(agent.ctx);
    };

    const allowed = (agent: Agent): boolean => {
      if (agent.session.header.origin === "subagent") {
        return false;
      }
      const preset = presetFor(agent);
      return preset !== undefined && allowedPresets.has(preset);
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
          .logger("plugin-source")
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
          .logger("plugin-source")
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
    // A blank session can be moved to another preset in the Web UI. Re-read
    // the live preset instead of trusting the creation header; the registry
    // emits `tools/change` when `select` rebinds the composition.
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
    reconcile();
  });
}

export const name = "plugin-source";
