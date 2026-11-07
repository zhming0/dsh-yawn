/**
 * Durable source store for plugins installed from a session workspace.
 *
 * A session's sandbox is disposable, so the package a model authors there is
 * not a safe home for a plugin's source. When `plugin_manager install_bundle`
 * names a directory inside the sandbox workspace, the staging row snapshots
 * that directory here instead: every installed version is an immutable
 * `versions/<hash>` directory, and the profile links to that directory. A
 * later session can check a version out, edit it, and install a new one; the
 * original sandbox can be gone.
 *
 * The store lives under `$DSH_HOME/creator-plugins`, which is on the data
 * volume. The profile refresh on an image upgrade never touches it, and the
 * profile's `link:` dependency keeps resolving after a restart.
 *
 * @module @zhming0/dsh-yawn/plugin-store
 */

import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Folder under `$DSH_HOME` holding every creator-installed plugin. */
export const CREATOR_PLUGINS_DIRECTORY = "creator-plugins";

/** Folder under one plugin holding its immutable versions. */
export const VERSIONS_DIRECTORY = "versions";

/** Per-plugin index: the latest version and the metadata for every version. */
export const STORE_META_FILE = "meta.json";

/** Marker a checkout writes; the next install reads it to learn its base. */
export const SOURCE_MARKER_FILE = ".dsh-plugin-source.json";

/** The profile facts the store needs. */
export interface ProfileContextLike {
  /** `$DSH_HOME`, the directory that holds `profiles/` and this store. */
  readonly home: string;
  /** The current profile directory, which holds its `package.json`. */
  readonly dir: string;
}

/** Metadata for one immutable package snapshot. */
export interface StoredVersion {
  readonly version?: string;
  readonly basedOn?: string;
  readonly createdAt: string;
  readonly session?: string;
}

/** One plugin's store index. */
export interface StoredPluginMeta {
  readonly name: string;
  latest: string;
  readonly versions: Record<string, StoredVersion>;
}

/** One plugin in the store, as `list` reports it. */
export interface StoredPlugin {
  readonly name: string;
  readonly slug: string;
  readonly directory: string;
  readonly meta: StoredPluginMeta;
}

/** A package directory's relative files and directories. */
export interface PackageSnapshot {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly directories: ReadonlySet<string>;
}

/** The package fields this feature reads. */
export interface PackageManifest {
  readonly name: string;
  readonly version?: string;
}

const HASH = /^[a-f0-9]{64}$/;
const PACKAGE_NAME =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isExistingDestination(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Whether `hash` has the shape {@link contentHash} produces. */
export function isContentHash(hash: string): boolean {
  return HASH.test(hash);
}

/** Validate one package name before it reaches a store path. */
export function validatePackageName(name: string): string {
  if (!PACKAGE_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a package name; a bundle package must be named like "name" or "@scope/name"`,
    );
  }
  return name;
}

/**
 * A filesystem-safe, collision-free directory name for a package.
 *
 * The readable prefix keeps the store browsable; the hash suffix keeps
 * `@scope/name` and an unscoped name that happens to slug the same way apart.
 */
export function slugForName(name: string): string {
  validatePackageName(name);
  const readable =
    name
      .replace(/^@/, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "plugin";
  return `${readable}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
}

/** `$DSH_HOME/creator-plugins`. */
export function creatorPluginsRoot(home: string): string {
  return join(home, CREATOR_PLUGINS_DIRECTORY);
}

/** One plugin's directory under the store root. */
export function pluginDirectory(home: string, name: string): string {
  return join(creatorPluginsRoot(home), slugForName(name));
}

/** One immutable version directory. */
export function versionDirectory(
  home: string,
  slug: string,
  hash: string,
): string {
  if (!isContentHash(hash)) {
    throw new Error(`"${hash}" is not a stored version hash`);
  }
  return join(
    creatorPluginsRoot(home),
    ...safeSegments(slug),
    VERSIONS_DIRECTORY,
    hash,
  );
}

/** Split a relative package path, rejecting anything that can leave its root. */
export function safeSegments(path: string): string[] {
  if (
    path === "" ||
    path.includes("\\") ||
    path.includes("\0") ||
    isAbsolute(path)
  ) {
    throw new Error(`"${path}" is not a relative package path`);
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`"${path}" is not a relative package path`);
    }
  }
  return segments;
}

function parseMeta(value: unknown, directory: string): StoredPluginMeta {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${join(directory, STORE_META_FILE)} is not a JSON object`);
  }
  const record = value as {
    name?: unknown;
    latest?: unknown;
    versions?: unknown;
  };
  if (typeof record.name !== "string") {
    throw new Error(`${join(directory, STORE_META_FILE)} names no package`);
  }
  validatePackageName(record.name);
  const versions: Record<string, StoredVersion> = {};
  if (record.versions !== undefined) {
    if (typeof record.versions !== "object" || record.versions === null) {
      throw new Error(
        `${join(directory, STORE_META_FILE)} has an invalid versions map`,
      );
    }
    for (const [hash, raw] of Object.entries(record.versions)) {
      if (!isContentHash(hash) || typeof raw !== "object" || raw === null) {
        continue;
      }
      const entry = raw as {
        version?: unknown;
        basedOn?: unknown;
        createdAt?: unknown;
        session?: unknown;
      };
      if (typeof entry.createdAt !== "string") {
        continue;
      }
      versions[hash] = {
        createdAt: entry.createdAt,
        ...(typeof entry.version === "string"
          ? { version: entry.version }
          : {}),
        ...(typeof entry.basedOn === "string" && isContentHash(entry.basedOn)
          ? { basedOn: entry.basedOn }
          : {}),
        ...(typeof entry.session === "string"
          ? { session: entry.session }
          : {}),
      };
    }
  }
  return {
    name: record.name,
    latest:
      typeof record.latest === "string" && isContentHash(record.latest)
        ? record.latest
        : "",
    versions,
  };
}

/** Read one plugin's index, or undefined when it does not exist yet. */
export async function readMeta(
  directory: string,
): Promise<StoredPluginMeta | undefined> {
  const path = join(directory, STORE_META_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${String(error)}`, {
      cause: error,
    });
  }
  return parseMeta(value, directory);
}

/** Replace one plugin's index atomically. */
export async function writeMeta(
  directory: string,
  meta: StoredPluginMeta,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, STORE_META_FILE);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const value = {
    name: meta.name,
    latest: meta.latest,
    versions: meta.versions,
  };
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

/** Every stored plugin, sorted by package name. */
export async function listStoredPlugins(home: string): Promise<StoredPlugin[]> {
  const root = creatorPluginsRoot(home);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
  const plugins: StoredPlugin[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = join(root, entry.name);
    let meta: StoredPluginMeta | undefined;
    try {
      meta = await readMeta(directory);
    } catch {
      // An incomplete store entry cannot be checked out or installed; a later
      // install repairs it. Listing must not fail the whole store.
      continue;
    }
    if (meta === undefined || slugForName(meta.name) !== entry.name) {
      continue;
    }
    plugins.push({ name: meta.name, slug: entry.name, directory, meta });
  }
  return plugins.sort((left, right) => compare(left.name, right.name));
}

/** The profile's installed creator versions, keyed by package name. */
export async function installedVersions(
  profileDir: string,
  root: string,
): Promise<Map<string, string>> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(join(profileDir, "package.json"), "utf8"),
    );
  } catch {
    return new Map();
  }
  if (typeof value !== "object" || value === null) {
    return new Map();
  }
  const dependencies = (value as { dependencies?: unknown }).dependencies;
  if (typeof dependencies !== "object" || dependencies === null) {
    return new Map();
  }
  const installed = new Map<string, string>();
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== "string") {
      continue;
    }
    const path = spec.startsWith("link:")
      ? spec.slice("link:".length)
      : spec.startsWith("file:")
        ? spec.slice("file:".length)
        : undefined;
    if (path === undefined || path === "" || path.includes("\0")) {
      continue;
    }
    const absolute = resolve(profileDir, path);
    const relativePath = relative(root, absolute);
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      continue;
    }
    const segments = relativePath.split(sep);
    const hash = segments[2];
    if (
      segments.length !== 3 ||
      segments[1] !== VERSIONS_DIRECTORY ||
      hash === undefined ||
      !isContentHash(hash)
    ) {
      continue;
    }
    installed.set(name, hash);
  }
  return installed;
}

/** Hash one package snapshot; directory names contribute an empty-dir marker. */
export function contentHash(snapshot: PackageSnapshot): string {
  const hash = createHash("sha256");
  for (const directory of [...snapshot.directories].sort(compare)) {
    hash.update(`d\0${directory}\0`);
  }
  const files = [...snapshot.files].sort(([left], [right]) =>
    compare(left, right),
  );
  for (const [path, bytes] of files) {
    hash.update(`f\0${path}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** Read the package identity from a snapshot's root `package.json`. */
export function manifestOf(snapshot: PackageSnapshot): PackageManifest {
  const bytes = snapshot.files.get("package.json");
  if (bytes === undefined) {
    throw new Error("the plugin package has no package.json at its root");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(
      `the plugin package.json is not valid JSON: ${String(error)}`,
      { cause: error },
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("the plugin package.json is not a JSON object");
  }
  const record = value as { name?: unknown; version?: unknown };
  if (typeof record.name !== "string") {
    throw new Error("the plugin package.json names no package");
  }
  const name = validatePackageName(record.name);
  return {
    name,
    ...(typeof record.version === "string" && record.version !== ""
      ? { version: record.version }
      : {}),
  };
}

/** The checkout marker's base, when the snapshot carries a valid one. */
export function sourceMarker(snapshot: PackageSnapshot): {
  readonly name?: string;
  readonly basedOn?: string;
} {
  const bytes = snapshot.files.get(SOURCE_MARKER_FILE);
  if (bytes === undefined) {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record = value as { name?: unknown; version?: unknown };
  return {
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.version === "string" && isContentHash(record.version)
      ? { basedOn: record.version }
      : {}),
  };
}

/** A copy with the checkout marker removed; the marker is session metadata. */
export function withoutSourceMarker(
  snapshot: PackageSnapshot,
): PackageSnapshot {
  const files = new Map(snapshot.files);
  files.delete(SOURCE_MARKER_FILE);
  return { files, directories: snapshot.directories };
}

/** Write one immutable version directory, reusing an existing identical one. */
export async function writeVersionSnapshot(
  directory: string,
  snapshot: PackageSnapshot,
): Promise<void> {
  const temporary = `${directory}.tmp-${process.pid}-${randomUUID()}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const path of [...snapshot.directories].sort(compare)) {
      await mkdir(join(temporary, ...safeSegments(path)), {
        recursive: true,
        mode: 0o700,
      });
    }
    const files = [...snapshot.files].sort(([left], [right]) =>
      compare(left, right),
    );
    for (const [path, bytes] of files) {
      const target = join(temporary, ...safeSegments(path));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o644 });
    }
    await rename(temporary, directory);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (isExistingDestination(error)) {
      // Another writer finished the same content first.
      return;
    }
    throw error;
  }
}

/** Read one stored version directory back into a snapshot. */
export async function readVersionSnapshot(
  directory: string,
): Promise<PackageSnapshot> {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();

  const walk = async (prefix: string): Promise<void> => {
    const absolute =
      prefix === "" ? directory : join(directory, ...safeSegments(prefix));
    const entries = (await readdir(absolute, { withFileTypes: true })).sort(
      (left, right) => compare(left.name, right.name),
    );
    for (const entry of entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        directories.add(path);
        await walk(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `the stored plugin contains a non-regular file at "${path}"`,
        );
      }
      files.set(path, await readFile(join(directory, ...safeSegments(path))));
    }
  };

  await walk("");
  return { files, directories };
}

/** Resolve a hash, a hash prefix, or a package version to one stored hash. */
export function resolveStoredVersion(
  meta: StoredPluginMeta,
  requested?: string,
): string {
  const hashes = Object.keys(meta.versions);
  if (requested !== undefined && requested.trim() !== "") {
    const target = requested.trim();
    if (meta.versions[target] !== undefined) {
      return target;
    }
    const prefix = hashes.filter((hash) => hash.startsWith(target));
    if (prefix.length === 1) {
      return prefix[0] as string;
    }
    const byVersion = hashes.filter(
      (hash) => meta.versions[hash]?.version === target,
    );
    if (byVersion.length === 1) {
      return byVersion[0] as string;
    }
    throw new Error(
      `"${meta.name}" has no stored version "${target}"; call list to see the versions`,
    );
  }
  if (meta.versions[meta.latest] !== undefined) {
    return meta.latest;
  }
  if (hashes.length === 0) {
    throw new Error(`"${meta.name}" has no stored versions`);
  }
  return hashes
    .sort((left, right) =>
      compare(
        meta.versions[left]?.createdAt ?? "",
        meta.versions[right]?.createdAt ?? "",
      ),
    )
    .at(-1) as string;
}

/** Whether one path exists as a directory. */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

let storeTail: Promise<unknown> = Promise.resolve();

/**
 * Serialize store writes in this process. The profile's own write lock
 * serializes installs; this lock keeps the store index and version directory
 * consistent across a staging snapshot, its install, and the latest update.
 */
export function withStoreLock<T>(task: () => Promise<T>): Promise<T> {
  const run = storeTail.then(task, task);
  storeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
