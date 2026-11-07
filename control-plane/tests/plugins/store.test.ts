import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  contentHash,
  creatorPluginsRoot,
  installedVersions,
  listStoredPlugins,
  pluginDirectory,
  readMeta,
  readVersionSnapshot,
  resolveStoredVersion,
  slugForName,
  sourceMarker,
  validatePackageName,
  versionDirectory,
  withStoreLock,
  writeMeta,
  writeVersionSnapshot,
  type PackageSnapshot,
} from "../../src/plugins/store.js";

const temporaryDirectories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-yawn-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function snapshot(files: Record<string, string>): PackageSnapshot {
  return {
    files: new Map(
      Object.entries(files).map(([path, value]) => [
        path,
        new TextEncoder().encode(value),
      ]),
    ),
    directories: new Set(),
  };
}

describe("package names", () => {
  it("accepts scoped and unscoped names and rejects paths", () => {
    expect(validatePackageName("demo")).toBe("demo");
    expect(validatePackageName("@acme/demo")).toBe("@acme/demo");
    for (const invalid of ["", "../demo", "acme/demo", "@acme", "@acme/"]) {
      expect(() => validatePackageName(invalid)).toThrow();
    }
  });

  it("makes distinct, path-safe directories for distinct names", () => {
    expect(slugForName("@acme/demo")).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(slugForName("@acme/demo")).not.toBe(slugForName("demo"));
    expect(slugForName("@acme/demo")).toBe(slugForName("@acme/demo"));
  });
});

describe("snapshots", () => {
  it("hashes content and directory names", () => {
    const base = snapshot({
      "package.json": '{"name":"demo"}',
      "index.js": "x",
    });
    expect(contentHash(base)).toBe(contentHash(base));
    expect(contentHash(base)).not.toBe(
      contentHash(
        snapshot({ "package.json": '{"name":"demo"}', "index.js": "y" }),
      ),
    );
    expect(contentHash(base)).not.toBe(
      contentHash({
        files: base.files,
        directories: new Set(["empty"]),
      }),
    );
  });

  it("round-trips a version directory, including an empty directory", async () => {
    const home = await temporary();
    const directory = versionDirectory(
      home,
      slugForName("@acme/demo"),
      "a".repeat(64),
    );
    const value: PackageSnapshot = {
      files: new Map([["package.json", new TextEncoder().encode("{}")]]),
      directories: new Set(["empty"]),
    };
    await writeVersionSnapshot(directory, value);
    const read = await readVersionSnapshot(directory);
    expect([...read.files.keys()]).toEqual(["package.json"]);
    expect([...read.directories]).toEqual(["empty"]);
  });

  it("reuses an existing version directory instead of failing", async () => {
    const home = await temporary();
    const directory = versionDirectory(home, "demo-12345678", "b".repeat(64));
    const value = snapshot({ "package.json": "{}" });
    await writeVersionSnapshot(directory, value);
    await writeVersionSnapshot(directory, value);
    expect((await readVersionSnapshot(directory)).files.size).toBe(1);
  });
});

describe("store index", () => {
  it("reads and lists one plugin", async () => {
    const home = await temporary();
    const directory = pluginDirectory(home, "@acme/demo");
    const hash = "c".repeat(64);
    await writeMeta(directory, {
      name: "@acme/demo",
      latest: hash,
      versions: {
        [hash]: { createdAt: "2026-01-01T00:00:00.000Z", version: "1.0.0" },
      },
    });

    expect(await readMeta(directory)).toEqual({
      name: "@acme/demo",
      latest: hash,
      versions: {
        [hash]: { createdAt: "2026-01-01T00:00:00.000Z", version: "1.0.0" },
      },
    });
    const plugins = await listStoredPlugins(home);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe("@acme/demo");
    expect(plugins[0]?.slug).toBe(slugForName("@acme/demo"));
  });

  it("skips an entry whose directory does not match its name", async () => {
    const home = await temporary();
    const root = creatorPluginsRoot(home);
    await mkdir(join(root, "wrong"), { recursive: true });
    await writeFile(
      join(root, "wrong", "meta.json"),
      JSON.stringify({
        name: "@acme/demo",
        latest: "",
        versions: {},
      }),
    );
    expect(await listStoredPlugins(home)).toEqual([]);
  });
});

describe("installed versions", () => {
  it("maps a profile link back to its stored version", async () => {
    const home = await temporary();
    const profile = join(home, "profiles", "web");
    await mkdir(profile, { recursive: true });
    const hash = "d".repeat(64);
    const link = join(
      creatorPluginsRoot(home),
      "demo-12345678",
      "versions",
      hash,
    );
    await writeFile(
      join(profile, "package.json"),
      JSON.stringify({
        name: "web",
        dependencies: {
          demo: `link:${link}`,
          "@deepseek-ai/dsh-base": "file:/opt/dsh/base.tgz",
        },
      }),
    );
    const installed = await installedVersions(
      profile,
      creatorPluginsRoot(home),
    );
    expect(installed.get("demo")).toBe(hash);
    expect(installed.has("@deepseek-ai/dsh-base")).toBe(false);
  });
});

describe("version resolution", () => {
  const one = "1".repeat(64);
  const two = "2".repeat(64);
  const meta = {
    name: "demo",
    latest: two,
    versions: {
      [one]: { createdAt: "2026-01-01T00:00:00.000Z", version: "1.0.0" },
      [two]: { createdAt: "2026-01-02T00:00:00.000Z", version: "2.0.0" },
    },
  };

  it("defaults to latest and accepts a hash, prefix, or package version", () => {
    expect(resolveStoredVersion(meta)).toBe(two);
    expect(resolveStoredVersion(meta, one)).toBe(one);
    expect(resolveStoredVersion(meta, one.slice(0, 8))).toBe(one);
    expect(resolveStoredVersion(meta, "1.0.0")).toBe(one);
  });

  it("falls back to the newest version when latest is empty", () => {
    expect(resolveStoredVersion({ ...meta, latest: "" })).toBe(two);
  });

  it("reports an unknown version", () => {
    expect(() => resolveStoredVersion(meta, "3.0.0")).toThrow(
      /no stored version/,
    );
  });
});

describe("source marker", () => {
  it("reads a valid base and ignores malformed markers", () => {
    const hash = "e".repeat(64);
    expect(
      sourceMarker(
        snapshot({
          ".dsh-plugin-source.json": JSON.stringify({
            name: "demo",
            version: hash,
          }),
        }),
      ),
    ).toEqual({ name: "demo", basedOn: hash });
    expect(
      sourceMarker(snapshot({ ".dsh-plugin-source.json": "not json" })),
    ).toEqual({});
  });
});

describe("store lock", () => {
  it("runs tasks one after another", async () => {
    const order: string[] = [];
    const first = withStoreLock(async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("first:end");
    });
    const second = withStoreLock(async () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});

describe("version directories", () => {
  it("rejects a hash that is not a content hash", async () => {
    const home = await temporary();
    expect(() => versionDirectory(home, "demo", "../../etc")).toThrow();
  });

  it("writes a version under the store root", async () => {
    const home = await temporary();
    const directory = versionDirectory(home, "demo", "f".repeat(64));
    await writeVersionSnapshot(directory, snapshot({ "package.json": "{}" }));
    expect(await readFile(join(directory, "package.json"), "utf8")).toBe("{}");
  });
});
