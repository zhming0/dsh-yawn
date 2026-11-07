import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { parseDeploymentSettings, type RuntimeConfig } from "./config.js";

/**
 * Where a deployment mounts its sandbox settings: one ordinary file, never a
 * dsh patch layer. The chart renders `controlPlane.sandboxManager` into the
 * document's top-level `sandboxManager` section. A home patch would outrank
 * the profile patch the Web page writes to, so the deployment's values arrive
 * as this base instead.
 */
export const DEPLOYMENT_SETTINGS_PATH = "/etc/dsh-yawn/sandbox-settings.yaml";

/**
 * Read the deployment settings file.
 *
 * @param path - Document path; defaults to the chart's mount.
 * @returns The parsed runtime slice; an absent file means the deployment
 *   configures none.
 */
export function readDeploymentSettings(
  path = DEPLOYMENT_SETTINGS_PATH,
): RuntimeConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  return parseDeploymentSettings(raw, path);
}

/** The Harness home, the directory holding the legacy settings document. */
export function dshHome(): string {
  const configured = process.env.DSH_HOME;
  return configured !== undefined && configured.trim() !== ""
    ? configured
    : join(homedir(), ".dsh");
}

/**
 * The profiles a renamed legacy settings document still holds that the host
 * does not have. dsh imports `settings.yaml` once, writing each section into
 * the active profile patch and renaming the file. A boot that mounted the
 * sandbox settings as a home patch had that write refused for
 * `sandbox-manager`, so the profiles stayed only in the renamed file; this
 * check is what makes the loss audible instead of silent.
 *
 * @param importedPath - The `settings.yaml.imported` path to inspect.
 * @param configured - Profile names the host currently has.
 * @returns Names held only by the renamed document, in document order.
 */
export function missingImportedProfiles(
  importedPath: string,
  configured: Iterable<string>,
): string[] {
  let raw: string;
  try {
    raw = readFileSync(importedPath, "utf8");
  } catch {
    return [];
  }
  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch {
    return [];
  }
  if (typeof document !== "object" || document === null) {
    return [];
  }
  const section = Reflect.get(document, "sandbox-manager") as unknown;
  if (typeof section !== "object" || section === null) {
    return [];
  }
  const profiles = Reflect.get(section, "profiles") as unknown;
  if (typeof profiles !== "object" || profiles === null) {
    return [];
  }
  const known = new Set(configured);
  return Object.keys(profiles).filter((name) => !known.has(name));
}
