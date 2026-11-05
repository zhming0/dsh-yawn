import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";
import { parse } from "yaml";

const run = promisify(execFile);

/**
 * The bundle patch disables stock rows and asserts the module names of the
 * rows it overrides. A patch entry for a row id that no longer exists is
 * skipped with a warning, and the stock row — or the host-only text it
 * suppresses — would come back without any test failing. This downloads the
 * pinned dsh-base and dsh-web-app and checks every patch entry against them.
 * Requires registry access; that is the point — the tripwire fires in the
 * change that bumps the pin.
 */

interface Row {
  id?: string;
  name?: string;
  insert?: Row[];
}

async function pinnedDshVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { devDependencies: Record<string, string> };
  const version = manifest.devDependencies["@deepseek-ai/dsh-agent"];
  if (version === undefined) {
    throw new Error("control plane does not pin @deepseek-ai/dsh-agent");
  }
  return version;
}

/** Rows contributed by one pinned package's bundle patch, keyed by id. */
async function packageRows(
  specifier: string,
  version: string,
): Promise<Map<string, string | undefined>> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-patch-rows-"));
  try {
    const { stdout } = await run(
      "npm",
      ["pack", `${specifier}@${version}`, "--pack-destination", dir],
      { cwd: dir },
    );
    const tarball = stdout.trim();
    await run("tar", ["-xzf", join(dir, tarball), "-C", dir]);
    // `!!js` expressions are dsh's own tag; only ids and names matter here.
    const rows = parse(
      await readFile(join(dir, "package", "cordis.patch.yml"), "utf8"),
      { logLevel: "error" },
    ) as Row[];
    const byId = new Map<string, string | undefined>();
    const walk = (entries: Row[] | undefined): void => {
      for (const row of entries ?? []) {
        if (row.id !== undefined) {
          byId.set(row.id, row.name);
        }
        walk(row.insert);
      }
    };
    walk(rows);
    return byId;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it("every row this bundle patches still exists under its asserted module", async () => {
  const version = await pinnedDshVersion();
  const stock = new Map<string, string | undefined>();
  for (const specifier of [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
  ]) {
    for (const [id, name] of await packageRows(specifier, version)) {
      stock.set(id, name);
    }
  }

  expect(
    stock.get("harness-dev-context"),
    `dsh ${version} no longer mounts harness-dev-context; find where it now ` +
      "composes the checkout and Web GUI prompt text, and update the row this " +
      "bundle disables in cordis.patch.yml",
  ).toBe("@deepseek-ai/dsh-harness-dev-context");

  const patch = parse(
    await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8"),
    { logLevel: "error" },
  ) as Row[];
  for (const entry of patch) {
    // `insert` rows belong to this bundle; the top-level entries target stock
    // rows and must match one or the stock behavior silently returns.
    if (entry.id === undefined || entry.insert !== undefined) {
      continue;
    }
    expect(
      stock.has(entry.id),
      `dsh ${version} no longer has a row with id "${entry.id}"; update ` +
        "cordis.patch.yml or remove the stale entry",
    ).toBe(true);
    if (entry.name !== undefined) {
      expect(
        stock.get(entry.id),
        `dsh ${version} row "${entry.id}" no longer loads ${entry.name}`,
      ).toBe(entry.name);
    }
  }
}, 180_000);
