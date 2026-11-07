import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Code, ConnectError } from "@connectrpc/connect";
import { Context, Service, symbols } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { afterEach, describe, expect, it } from "vitest";

import type { RunnerClient } from "../../src/core/runner-client.js";
import { FileType } from "../../src/gen/dsh/yawn/v1/runner_pb.js";
import {
  installFromSandbox,
  wrapPluginManager,
  type PluginManagerLike,
} from "../../src/plugins/creator-bundles.js";
import {
  creatorPluginsRoot,
  readMeta,
  slugForName,
} from "../../src/plugins/store.js";
import type { SandboxManager } from "../../src/sandbox/manager/sandbox-manager.js";

const temporaryDirectories: string[] = [];
const ROOT = "/workspace/repo/plugin";

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-yawn-creator-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

interface FakeOptions {
  readonly truncated?: boolean;
  readonly canonical?: string;
  readonly readError?: Error;
}

function fakeClient(
  files: Record<string, string>,
  options: FakeOptions = {},
): RunnerClient {
  const contents = new Map(
    Object.entries(files).map(([path, value]) => [
      path,
      new TextEncoder().encode(value),
    ]),
  );
  const entries = [...contents.keys()].map((path) => ({
    relativePath: path,
    type: FileType.REGULAR,
  }));
  return {
    resolvePath: async ({ path }: { path: string }) => ({
      canonicalPath: options.canonical ?? path,
      displayPath: path,
    }),
    stat: async ({ path }: { path: string }) => ({
      exists: path === ROOT || contents.has(relative(path)),
      type: path === ROOT ? FileType.DIRECTORY : FileType.REGULAR,
      size: BigInt(contents.get(relative(path))?.byteLength ?? 0),
      version: "",
    }),
    tree: async () => ({ entries, truncated: options.truncated ?? false }),
    readFile: async ({ path }: { path: string }) => {
      if (options.readError !== undefined) {
        throw options.readError;
      }
      return { content: contents.get(relative(path)) };
    },
  } as unknown as RunnerClient;
}

function relative(path: string): string {
  return path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path;
}

function fakeSandbox(client: RunnerClient): SandboxManager {
  return {
    workspace: "/workspace",
    clientForCurrentAgent: async () => client,
  } as unknown as SandboxManager;
}

function fakeAgents(): { requireInitiator(): Agent } {
  return {
    requireInitiator: () =>
      ({
        session: { header: { id: "session-1" } },
      }) as unknown as Agent,
  };
}

function fakeInstall(calls: string[]): (path: string) => Promise<unknown> {
  return async (path: string) => {
    calls.push(path);
    return { application: "applied", warnings: [] };
  };
}

const packageJson = JSON.stringify({ name: "demo", version: "1.0.0" });

describe("installFromSandbox", () => {
  it("snapshots a workspace package and installs the stored version", async () => {
    const home = await temporary();
    const calls: string[] = [];
    const result = await installFromSandbox({
      spec: ROOT,
      profile: { home, dir: join(home, "profiles", "web") },
      sandbox: fakeSandbox(
        fakeClient({
          "package.json": packageJson,
          "index.js": "export const value = 1;",
          "cordis.patch.yml": "- insert: []\n",
        }),
      ),
      agents: fakeAgents(),
      install: fakeInstall(calls),
    });

    expect(result).toMatchObject({ application: "applied" });
    expect(calls).toHaveLength(1);
    const stored = calls[0] as string;
    expect(stored).toContain(join("creator-plugins", slugForName("demo")));
    expect(await readFile(join(stored, "index.js"), "utf8")).toBe(
      "export const value = 1;",
    );
    const meta = await readMeta(
      join(creatorPluginsRoot(home), slugForName("demo")),
    );
    expect(meta?.name).toBe("demo");
    expect(meta?.latest).toBe(stored.split("/").at(-1));
    expect(Object.keys(meta?.versions ?? {})).toHaveLength(1);
  });

  it("passes host paths and registry specs through untouched", async () => {
    const home = await temporary();
    const calls: string[] = [];
    const options = {
      profile: { home, dir: join(home, "profiles", "web") },
      sandbox: fakeSandbox(fakeClient({ "package.json": packageJson })),
      agents: fakeAgents(),
      install: fakeInstall(calls),
    };
    expect(
      await installFromSandbox({ ...options, spec: "/data/plugin" }),
    ).toBeUndefined();
    expect(
      await installFromSandbox({ ...options, spec: "demo-plugin" }),
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("refuses a canonical path that leaves the workspace", async () => {
    const home = await temporary();
    await expect(
      installFromSandbox({
        spec: ROOT,
        profile: { home, dir: join(home, "profiles", "web") },
        sandbox: fakeSandbox(
          fakeClient(
            { "package.json": packageJson },
            { canonical: "/etc/passwd" },
          ),
        ),
        agents: fakeAgents(),
        install: fakeInstall([]),
      }),
    ).rejects.toThrow(/inside this session's workspace/);
  });

  it("refuses a truncated tree", async () => {
    const home = await temporary();
    await expect(
      installFromSandbox({
        spec: ROOT,
        profile: { home, dir: join(home, "profiles", "web") },
        sandbox: fakeSandbox(
          fakeClient({ "package.json": packageJson }, { truncated: true }),
        ),
        agents: fakeAgents(),
        install: fakeInstall([]),
      }),
    ).rejects.toThrow(/more than 5000 entries/);
  });

  it("refuses a file over the per-file limit", async () => {
    const home = await temporary();
    await expect(
      installFromSandbox({
        spec: ROOT,
        profile: { home, dir: join(home, "profiles", "web") },
        sandbox: fakeSandbox(
          fakeClient(
            { "package.json": packageJson },
            {
              readError: new ConnectError(
                "file exceeds max_bytes",
                Code.ResourceExhausted,
              ),
            },
          ),
        ),
        agents: fakeAgents(),
        install: fakeInstall([]),
      }),
    ).rejects.toThrow(/larger than/);
  });

  it("warns when a checkout base is older than the stored latest", async () => {
    const home = await temporary();
    const profile = { home, dir: join(home, "profiles", "web") };
    const sandbox = fakeSandbox(
      fakeClient({ "package.json": packageJson, "index.js": "v1" }),
    );
    const calls: string[] = [];
    await installFromSandbox({
      spec: ROOT,
      profile,
      sandbox,
      agents: fakeAgents(),
      install: fakeInstall(calls),
    });
    const store = join(creatorPluginsRoot(home), slugForName("demo"));
    const first = await readMeta(store);
    expect(first).toBeDefined();
    const firstHash = first?.latest ?? "";

    const second = {
      spec: ROOT,
      profile,
      sandbox: fakeSandbox(
        fakeClient({ "package.json": packageJson, "index.js": "v2" }),
      ),
      agents: fakeAgents(),
      install: async (path: string) => {
        calls.push(path);
        return { application: "applied", warnings: [] as string[] };
      },
    };
    const secondResult = (await installFromSandbox(second)) as {
      warnings: string[];
    };
    expect(secondResult.warnings).toEqual([]);
    const latest = (await readMeta(store))?.latest;

    const thirdResult = (await installFromSandbox({
      spec: ROOT,
      profile,
      sandbox: fakeSandbox(
        fakeClient({
          "package.json": packageJson,
          "index.js": "v3",
          ".dsh-plugin-source.json": JSON.stringify({
            name: "demo",
            version: firstHash,
          }),
        }),
      ),
      agents: fakeAgents(),
      install: async (path: string) => {
        calls.push(path);
        return { application: "applied", warnings: [] as string[] };
      },
    })) as { warnings: string[] };
    expect(latest).not.toBe(firstHash);
    expect(thirdResult.warnings[0]).toMatch(/newer stored version/);
  });
});

describe("wrapPluginManager", () => {
  it("is visible through the cordis service proxy", async () => {
    const home = await temporary();
    const calls: string[] = [];
    class FakeManager extends Service {
      constructor(scope: Context) {
        super(scope, "fakePluginManager");
      }
      async installBundle(spec: string): Promise<unknown> {
        calls.push(spec);
        return { application: "applied", warnings: [] };
      }
    }
    const ctx = new Context();
    await ctx.plugin(FakeManager);
    const proxy = (ctx as unknown as { fakePluginManager: PluginManagerLike })
      .fakePluginManager;
    const raw = (Reflect.get(proxy, symbols.original) ??
      proxy) as unknown as PluginManagerLike;
    const undo = wrapPluginManager(
      raw,
      fakeSandbox(fakeClient({ "package.json": packageJson })),
      { home, dir: join(home, "profiles", "web") },
      fakeAgents(),
    );

    await proxy.installBundle(ROOT);
    expect(calls[0]).toContain("creator-plugins");

    undo();
    await proxy.installBundle("/data/plugin");
    expect(calls[1]).toBe("/data/plugin");
  });

  it("stages sandbox paths and restores the stock method on dispose", async () => {
    const home = await temporary();
    class FakeManager {
      readonly calls: string[] = [];
      async installBundle(spec: string): Promise<unknown> {
        this.calls.push(spec);
        return { application: "applied", warnings: [] };
      }
    }
    const manager = new FakeManager();
    const undo = wrapPluginManager(
      manager,
      fakeSandbox(fakeClient({ "package.json": packageJson })),
      { home, dir: join(home, "profiles", "web") },
      fakeAgents(),
    );

    await manager.installBundle(ROOT);
    expect(manager.calls[0]).toContain("creator-plugins");

    undo();
    await manager.installBundle("/data/plugin");
    expect(manager.calls[1]).toBe("/data/plugin");
  });
});
