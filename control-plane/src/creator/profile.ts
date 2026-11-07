/**
 * Profile facts the Creator source store needs.
 *
 * The store's versions live under `$DSH_HOME`, while the profile's manifest
 * records which version each package is linked to. This module reads that
 * link, including the `~` form pnpm can save for a path under the home
 * directory, so `plugin_source` can tell the installed version from the
 * newest stored one.
 *
 * @module @zhming0/dsh-yawn/creator-profile
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { isContentHash, VERSIONS_DIRECTORY } from "./store.js";

/** The profile facts the store needs. */
export interface ProfileContextLike {
  /** `$DSH_HOME`, the directory that holds `profiles/` and this store. */
  readonly home: string;
  /** The current profile directory, which holds its `package.json`. */
  readonly dir: string;
}

/** The profile's installed creator versions, keyed by package name. */
export async function installedVersions(
  profileDir: string,
  root: string,
  osHome: string = homedir(),
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
    const expanded =
      path === "~"
        ? osHome
        : path.startsWith("~/")
          ? join(osHome, path.slice(2))
          : path;
    const absolute = resolve(profileDir, expanded);
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
    const leaf = segments[2];
    const hash = leaf?.endsWith(".tgz") ? leaf.slice(0, -4) : leaf;
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
