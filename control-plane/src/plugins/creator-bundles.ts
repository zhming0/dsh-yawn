/**
 * Installs a plugin package authored in a session's sandbox workspace.
 *
 * `plugin_manager install_bundle` normally takes a host path or a registry
 * spec. Creator mode authors a bundle in the session workspace, which lives in
 * the sandbox, so the stock installer's `existsSync` sees nothing. This row
 * wraps the live `pluginManager` service: when the target is an absolute path
 * inside the session's sandbox workspace, it snapshots the directory into the
 * durable store (`./store.ts`) and calls the stock installer with the stored
 * version path instead. Every other spec passes through unchanged, so host
 * paths, npm names, Git URLs, and the Web Plugins page keep working.
 *
 * The wrapper is an own property on the service instance, the same shape
 * `sandbox-workspace-files` uses for `workspaceFiles`: the stock prototype
 * method and its remote marker stay intact, and disposing the row restores it.
 *
 * @module @zhming0/dsh-yawn/creator-bundles
 */

import { ConnectError, Code } from "@connectrpc/connect";
import { posix } from "node:path";

import { symbols, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";

import type { RunnerClient } from "../core/runner-client.js";
import { FileType } from "../gen/dsh/yawn/v1/runner_pb.js";
import type { SandboxManager } from "../sandbox/manager/sandbox-manager.js";
import { isInsideSandboxWorkspace } from "../sandbox/sandbox-path.js";
import {
  contentHash,
  directoryExists,
  manifestOf,
  pluginDirectory,
  readMeta,
  safeSegments,
  slugForName,
  sourceMarker,
  versionDirectory,
  withoutSourceMarker,
  withStoreLock,
  writeMeta,
  writeVersionSnapshot,
  type PackageSnapshot,
  type ProfileContextLike,
  type StoredPluginMeta,
  type StoredVersion,
} from "./store.js";

const EXCLUDED_DIRECTORIES = ["node_modules", ".git", ".dsh-attachments"];
const MAX_ENTRIES = 5_000;
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** The part of the plugin manager service this row calls. */
export interface PluginManagerLike {
  installBundle(
    spec: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

/** The agent service's initiator lookup. */
interface InitiatorAgents {
  requireInitiator(): Agent;
}

/** What the stock installer returned; only the outcome and warnings matter. */
interface InstallResultLike {
  application?: unknown;
  warnings?: string[];
}

/** Options for {@link installFromSandbox}. */
export interface InstallFromSandboxOptions {
  readonly spec: string;
  readonly sandbox: SandboxManager;
  readonly profile: ProfileContextLike;
  readonly agents: InitiatorAgents;
  readonly install: (path: string) => Promise<unknown>;
  readonly signal?: AbortSignal;
}

interface StagedTarget {
  readonly path: string;
  readonly warning?: string;
  readonly pluginDirectory: string;
  readonly hash: string;
}

function callOptions(
  signal: AbortSignal | undefined,
): { signal?: AbortSignal } | undefined {
  return signal === undefined ? undefined : { signal };
}

function isSandboxPath(spec: string, workspace: string): boolean {
  return (
    posix.isAbsolute(spec) &&
    spec !== workspace &&
    isInsideSandboxWorkspace(spec, workspace)
  );
}

/** Read one package directory from the sandbox, with size and entry caps. */
async function snapshot(
  client: RunnerClient,
  root: string,
  signal: AbortSignal | undefined,
): Promise<PackageSnapshot> {
  const options = callOptions(signal);
  const tree = await client.tree(
    {
      path: root,
      excludedDirectories: [...EXCLUDED_DIRECTORIES],
      maxEntries: BigInt(MAX_ENTRIES),
    },
    options,
  );
  if (tree.truncated) {
    throw new Error(
      `the plugin package has more than ${MAX_ENTRIES} entries; keep the package small`,
    );
  }

  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  let totalBytes = 0;

  for (const entry of tree.entries) {
    const relative = safeSegments(entry.relativePath).join("/");
    if (entry.type === FileType.DIRECTORY) {
      directories.add(relative);
      continue;
    }
    if (entry.type !== FileType.REGULAR) {
      continue;
    }
    let content: Uint8Array;
    try {
      const response = await client.readFile(
        {
          path: posix.join(root, relative),
          maxBytes: BigInt(MAX_FILE_BYTES),
        },
        options,
      );
      content = response.content;
    } catch (error) {
      if (ConnectError.from(error).code === Code.ResourceExhausted) {
        throw new Error(
          `the plugin file "${relative}" is larger than ${MAX_FILE_BYTES} bytes`,
          { cause: error },
        );
      }
      throw error;
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(
        `the plugin package is larger than ${MAX_TOTAL_BYTES} bytes; keep the package small`,
      );
    }
    files.set(relative, content);
    if (files.size > MAX_FILES) {
      throw new Error(
        `the plugin package has more than ${MAX_FILES} files; keep the package small`,
      );
    }
  }

  return { files, directories };
}

/**
 * Snapshot one sandbox package into the store and return the immutable
 * version path the stock installer should receive.
 */
async function stage(
  options: InstallFromSandboxOptions,
): Promise<StagedTarget | undefined> {
  const { sandbox, profile, spec, agents, signal } = options;
  const trimmed = spec.trim();
  if (!isSandboxPath(trimmed, sandbox.workspace)) {
    return undefined;
  }

  const agent = agents.requireInitiator();
  const client = await sandbox.clientForCurrentAgent();
  const call = callOptions(signal);
  const resolved = await client.resolvePath(
    { path: trimmed, cwd: sandbox.workspace },
    call,
  );
  const root = resolved.canonicalPath;
  if (
    root === sandbox.workspace ||
    !isInsideSandboxWorkspace(root, sandbox.workspace)
  ) {
    throw new Error(
      "the plugin directory must stay inside this session's workspace",
    );
  }
  const info = await client.stat({ path: root, followSymlinks: false }, call);
  if (!info.exists) {
    throw new Error(`the plugin directory "${trimmed}" does not exist`);
  }
  if (info.type !== FileType.DIRECTORY) {
    throw new Error(
      `"${trimmed}" is not a directory; install_bundle needs the package directory`,
    );
  }

  const snapshotValue = await snapshot(client, root, signal);
  const marker = sourceMarker(snapshotValue);
  const clean = withoutSourceMarker(snapshotValue);
  const manifest = manifestOf(clean);
  const slug = slugForName(manifest.name);
  const pluginDir = pluginDirectory(profile.home, manifest.name);
  const existing = await readMeta(pluginDir);
  if (existing !== undefined && existing.name !== manifest.name) {
    throw new Error(
      `the store entry for "${manifest.name}" names "${existing.name}"; refusing to reuse it`,
    );
  }

  const hash = contentHash(clean);
  const versionPath = versionDirectory(profile.home, slug, hash);
  if (!(await directoryExists(versionPath))) {
    await writeVersionSnapshot(versionPath, clean);
  }

  const basedOn = marker.name === manifest.name ? marker.basedOn : undefined;
  const entry: StoredVersion = {
    createdAt: new Date().toISOString(),
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    ...(basedOn === undefined ? {} : { basedOn }),
    ...(agent.session.header.id === undefined
      ? {}
      : { session: String(agent.session.header.id) }),
  };
  const meta: StoredPluginMeta = existing ?? {
    name: manifest.name,
    latest: "",
    versions: {},
  };
  meta.versions[hash] = entry;
  await writeMeta(pluginDir, meta);

  const warning =
    basedOn !== undefined &&
    existing !== undefined &&
    existing.latest !== "" &&
    existing.latest !== basedOn
      ? `This version was edited from ${basedOn.slice(0, 12)}, but "${manifest.name}" has a newer stored version (${existing.latest.slice(0, 12)}); another session may have changed it.`
      : undefined;

  return {
    path: versionPath,
    pluginDirectory: pluginDir,
    hash,
    ...(warning === undefined ? {} : { warning }),
  };
}

function appendWarning(result: unknown, warning: string): void {
  if (typeof result !== "object" || result === null) {
    return;
  }
  const record = result as InstallResultLike;
  if (Array.isArray(record.warnings)) {
    record.warnings.push(warning);
    return;
  }
  record.warnings = [warning];
}

function installSucceeded(result: unknown): boolean {
  if (typeof result !== "object" || result === null) {
    return false;
  }
  const application = (result as InstallResultLike).application;
  return application !== "failed" && application !== "cancelled";
}

/**
 * Install a package from the sandbox workspace, or return undefined when the
 * spec is not a sandbox path and the caller should keep its stock behavior.
 */
export async function installFromSandbox(
  options: InstallFromSandboxOptions,
): Promise<unknown> {
  if (!isSandboxPath(options.spec.trim(), options.sandbox.workspace)) {
    return undefined;
  }
  return withStoreLock(async () => {
    const target = await stage(options);
    if (target === undefined) {
      return undefined;
    }
    const result = await options.install(target.path);
    if (installSucceeded(result)) {
      const meta = await readMeta(target.pluginDirectory);
      if (meta !== undefined) {
        meta.latest = target.hash;
        await writeMeta(target.pluginDirectory, meta);
      }
    }
    if (target.warning !== undefined) {
      appendWarning(result, target.warning);
    }
    return result;
  });
}

/**
 * Replace the live manager's `installBundle` with the staging wrapper.
 * Returns the undo that restores the original own property or prototype
 * method.
 */
export function wrapPluginManager(
  manager: PluginManagerLike,
  sandbox: SandboxManager,
  profile: ProfileContextLike,
  agents: InitiatorAgents,
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(manager, "installBundle");
  const stock = manager.installBundle.bind(manager);
  const wrapped = async function (
    this: PluginManagerLike,
    spec: string,
    options?: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await installFromSandbox({
      spec,
      sandbox,
      profile,
      agents,
      install: (path) => stock(path, options),
    });
    return result ?? stock(spec, options);
  };
  Object.defineProperty(manager, "installBundle", {
    configurable: true,
    writable: true,
    value: wrapped,
  });
  return () => {
    if (descriptor !== undefined) {
      Object.defineProperty(manager, "installBundle", descriptor);
      return;
    }
    Reflect.deleteProperty(manager, "installBundle");
  };
}

export const name = "creator-bundle-staging";

export function apply(ctx: Context): void {
  ctx.inject(
    ["pluginManager", "sandboxManager", "agents", "profileContext"],
    (scope) => {
      const manager = scope.get("pluginManager") as
        | PluginManagerLike
        | undefined;
      const profile = scope.get("profileContext") as
        | ProfileContextLike
        | undefined;
      if (manager === undefined || profile === undefined) {
        return;
      }
      const instance = (Reflect.get(manager, symbols.original) ??
        manager) as unknown as PluginManagerLike;
      const sandbox = scope.get("sandboxManager");
      if (sandbox === undefined) {
        return;
      }
      scope.effect(() =>
        wrapPluginManager(instance, sandbox, profile, scope.agents),
      );
    },
  );
}
