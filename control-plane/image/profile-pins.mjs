#!/usr/bin/env node
/**
 * Pin the profile's DeepSeek packages to the versions the image runs.
 *
 * The profile installs with pnpm's hoisted linker, so an out-of-tree plugin's
 * transitive dependency lands at the profile root. If that dependency is a
 * package the dsh runtime also uses, the core row can load the plugin's copy
 * instead of the runtime's. An older copy fails the runtime's compatibility
 * check, the row is disabled, and every service waiting on it stays pending.
 *
 * `overrides` in `pnpm-workspace.yaml` is how pnpm 11 constrains resolution:
 * it forces every matching edge to the runtime's version, so a plugin can
 * only break itself. The block is generated from the installed CLI tree, so
 * it follows an image upgrade without a hand-maintained list. Other keys in
 * the workspace file, such as pnpm's build-script approvals, are preserved.
 *
 * Usage: profile-pins.mjs <dsh-cli-dir> <workspace-file>
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [cliDir, workspacePath] = process.argv.slice(2);
if (cliDir === undefined || workspacePath === undefined) {
  process.stderr.write(
    "usage: profile-pins.mjs <dsh-cli-dir> <workspace-file>\n",
  );
  process.exit(2);
}

const packages = join(cliDir, "node_modules", "@deepseek-ai");
const pins = [];
if (existsSync(packages)) {
  for (const entry of readdirSync(packages).sort()) {
    const manifestPath = join(packages, entry, "package.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      typeof manifest.name === "string" &&
      typeof manifest.version === "string"
    ) {
      pins.push([manifest.name, manifest.version]);
    }
  }
}
if (pins.length === 0) {
  process.stderr.write(
    `profile-pins: no @deepseek-ai packages under ${packages}; leaving ${workspacePath} unchanged\n`,
  );
  process.exit(1);
}
pins.sort(([left], [right]) => left.localeCompare(right));
const block = [
  "overrides:",
  ...pins.map(([name, version]) => `  '${name}': ${version}`),
];

const text = readFileSync(workspacePath, "utf8");
const lines = text.split("\n");
const start = lines.findIndex((line) => /^overrides\s*:/.test(line));
let next;
if (start === -1) {
  const withoutTrailing = text.replace(/\s*$/, "");
  next = `${withoutTrailing}${withoutTrailing === "" ? "" : "\n\n"}${block.join("\n")}\n`;
} else {
  let end = start + 1;
  // Everything indented under `overrides:` is the old map. A blank line or
  // top-level key ends it, and both are kept.
  while (
    end < lines.length &&
    lines[end].trim() !== "" &&
    /^\s/.test(lines[end])
  ) {
    end += 1;
  }
  next = [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
  if (!next.endsWith("\n")) {
    next += "\n";
  }
}

if (next !== text) {
  writeFileSync(workspacePath, next);
}
