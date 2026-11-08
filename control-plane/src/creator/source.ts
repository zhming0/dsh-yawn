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

import { ConnectError, Code } from "@connectrpc/connect";
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
import type { RunnerClient } from "../core/runner-client.js";
import type { SandboxManager } from "../sandbox/manager/sandbox-manager.js";
import { registerPerAgentTools } from "../tools/per-agent.js";
import { isInsideSandboxWorkspace } from "../sandbox/sandbox-path.js";
import {
  creatorPluginsRoot,
  listStoredPlugins,
  readVersionSnapshot,
  resolveStoredVersion,
  SOURCE_MARKER_FILE,
  versionDirectory,
} from "./store.js";
import { installedVersions, type ProfileContextLike } from "./profile.js";

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

/** Whether every entry under one directory is itself an empty directory. */
async function isEmptyTree(
  client: RunnerClient,
  path: string,
  call: { signal: AbortSignal },
): Promise<boolean> {
  const listing = await client.list(path, call);
  for (const entry of listing.entries) {
    if (entry.type !== FileType.DIRECTORY) {
      return false;
    }
    if (!(await isEmptyTree(client, posix.join(path, entry.name), call))) {
      return false;
    }
  }
  return true;
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
      "do not. If install_bundle answers already-installed, remove_bundle first " +
      "and retry.",
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
      let targetPath = target;
      try {
        const resolved = await client.resolvePath(
          { path: target, cwd: workspace },
          call,
        );
        targetPath = resolved.canonicalPath;
        if (
          targetPath === workspace ||
          !isInsideSandboxWorkspace(targetPath, workspace)
        ) {
          throw new Error(
            `checkout path "${target}" resolves outside this session's workspace`,
          );
        }
      } catch (error) {
        if (ConnectError.from(error).code !== Code.NotFound) {
          throw error;
        }
        // No existing ancestor to canonicalize; the lexical target is safe
        // because every missing component is created anew.
      }
      const existing = await client.stat(
        { path: targetPath, followSymlinks: false },
        call,
      );
      if (existing.exists) {
        if (existing.type !== FileType.DIRECTORY) {
          throw new Error(
            `checkout path "${targetPath}" already exists; choose another path`,
          );
        }
        if (!(await isEmptyTree(client, targetPath, call))) {
          throw new Error(
            `checkout path "${targetPath}" is not empty; choose another path`,
          );
        }
      }

      const files = [...snapshot.files].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      const written: string[] = [];
      try {
        for (const [relative, bytes] of files) {
          const path = posix.join(targetPath, ...relative.split("/"));
          await client.writeFile(
            {
              path,
              content: bytes,
              guard: { case: "createIfAbsent", value: true },
              mode: 0o644,
            },
            call,
          );
          written.push(path);
        }
        const marker = new TextEncoder().encode(
          `${JSON.stringify({ name: stored.name, version })}\n`,
        );
        const markerPath = posix.join(targetPath, SOURCE_MARKER_FILE);
        await client.writeFile(
          {
            path: markerPath,
            content: marker,
            guard: { case: "createIfAbsent", value: true },
            mode: 0o644,
          },
          call,
        );
        written.push(markerPath);
      } catch (error) {
        // Leave an empty destination behind: the next checkout accepts an
        // existing empty directory, so a transient runner failure is retryable.
        const cleanup = { signal: AbortSignal.timeout(5_000) };
        for (const path of written.reverse()) {
          try {
            await client.deleteFile({ path, expectedVersion: "" }, cleanup);
          } catch {
            // A file that cannot be removed stays; the user can choose a new path.
          }
        }
        throw error;
      }

      return {
        name: stored.name,
        version,
        path: targetPath,
        files: files.length,
      };
    },
  });
  return [source];
}

/** Register the tool on the live agents whose preset is in the allowlist. */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(
    ["agents", "sandboxManager", "profileContext", "agentPresets"],
    (scope) => {
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
        return preset !== undefined && allowedPresets.has(preset);
      };

      registerPerAgentTools(scope, { label: name, tools, allow: allowed });
    },
  );
}

export const name = "plugin-source";
