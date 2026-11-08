import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it } from "vitest";

import type { RunnerClient } from "../../src/core/runner-client.js";
import { FileType } from "../../src/gen/dsh/yawn/v1/runner_pb.js";
import {
  apply,
  createPluginSourceTools,
  type PluginSourceDeps,
} from "../../src/creator/source.js";
import {
  pluginDirectory,
  writeMeta,
  writeVersionSnapshot,
  type PackageSnapshot,
} from "../../src/creator/store.js";
import type { SandboxManager } from "../../src/sandbox/manager/sandbox-manager.js";

const temporaryDirectories: string[] = [];
const HASH = "a".repeat(64);

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-yawn-source-"));
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

interface FakeClient {
  readonly writes: { path: string; content: Uint8Array }[];
  readonly deleted: string[];
  readonly client: RunnerClient;
}

function fakeClient(
  options: {
    destinationExists?: boolean;
    destinationDirectory?: boolean;
    destinationEntries?: number;
    failWriteAt?: number;
    canonicalPath?: string;
  } = {},
): FakeClient {
  const writes: { path: string; content: Uint8Array }[] = [];
  const deleted: string[] = [];
  const client = {
    resolvePath: async ({ path }: { path: string }) => ({
      canonicalPath: options.canonicalPath ?? path,
      displayPath: path,
    }),
    stat: async () => ({
      exists: options.destinationExists ?? false,
      type: options.destinationDirectory
        ? FileType.DIRECTORY
        : FileType.UNSPECIFIED,
      size: 0n,
      version: "",
    }),
    list: async () => ({
      entries: Array.from({ length: options.destinationEntries ?? 0 }, () => ({
        name: "entry",
        canonicalPath: "",
        type: FileType.REGULAR,
        size: 0n,
        version: "",
      })),
    }),
    writeFile: async (request: { path: string; content: Uint8Array }) => {
      if (options.failWriteAt === writes.length + 1) {
        throw new Error("write failed");
      }
      writes.push({ path: request.path, content: request.content });
      return {
        created: true,
        hadBefore: false,
        before: new Uint8Array(),
        version: "",
      };
    },
    deleteFile: async (request: { path: string }) => {
      deleted.push(request.path);
      return {};
    },
  } as unknown as RunnerClient;
  return { writes, deleted, client };
}

function fakeSandbox(client: RunnerClient): SandboxManager {
  return {
    workspace: "/workspace",
    clientForCurrentAgent: async () => client,
  } as unknown as SandboxManager;
}

function exec(): ToolRunContext {
  return {
    agent: { id: "session-1", session: { header: {} } } as unknown as Agent,
    signal: new AbortController().signal,
  } as unknown as ToolRunContext;
}

async function run(
  deps: PluginSourceDeps,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = createPluginSourceTools(deps).find(
    (definition) => definition.name === "plugin_source",
  );
  if (tool === undefined) {
    throw new Error("plugin_source is not registered");
  }
  return tool.execute(args, exec());
}

async function storedPlugin(home: string): Promise<string> {
  const directory = pluginDirectory(home, "demo");
  const version = join(directory, "versions", HASH);
  await writeVersionSnapshot(
    version,
    snapshot({
      "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }),
      "index.js": "export const value = 1;",
    }),
  );
  await writeMeta(directory, {
    name: "demo",
    latest: HASH,
    versions: {
      [HASH]: { createdAt: "2026-01-01T00:00:00.000Z", version: "1.0.0" },
    },
  });
  return version;
}

async function profileWithLink(home: string, version: string): Promise<string> {
  const profile = join(home, "profiles", "web");
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, "package.json"),
    JSON.stringify({
      name: "web",
      dependencies: { demo: `link:${version}` },
    }),
  );
  return profile;
}

describe("plugin_source list", () => {
  it("reports the stored versions and the profile's installed version", async () => {
    const home = await temporary();
    const version = await storedPlugin(home);
    const profileDir = await profileWithLink(home, version);
    const client = fakeClient();

    expect(
      await run(
        { home, profileDir, sandbox: fakeSandbox(client.client) },
        { action: "list" },
      ),
    ).toEqual({
      plugins: [
        {
          name: "demo",
          latest: HASH,
          installed: HASH,
          versions: [
            {
              hash: HASH,
              version: "1.0.0",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      ],
    });
  });

  it("returns an empty list before the first creator install", async () => {
    const home = await temporary();
    const client = fakeClient();
    expect(
      await run(
        {
          home,
          profileDir: join(home, "profiles", "web"),
          sandbox: fakeSandbox(client.client),
        },
        { action: "list" },
      ),
    ).toEqual({ plugins: [] });
  });
});

describe("plugin_source checkout", () => {
  it("copies a version and writes its source marker", async () => {
    const home = await temporary();
    const version = await storedPlugin(home);
    const profileDir = await profileWithLink(home, version);
    const fake = fakeClient();

    const result = await run(
      { home, profileDir, sandbox: fakeSandbox(fake.client) },
      { action: "checkout", name: "demo", path: "plugins/demo" },
    );

    expect(result).toEqual({
      name: "demo",
      version: HASH,
      path: "/workspace/plugins/demo",
      files: 2,
    });
    const paths = fake.writes.map((write) => write.path);
    expect(paths).toContain("/workspace/plugins/demo/package.json");
    expect(paths).toContain("/workspace/plugins/demo/index.js");
    expect(paths).toContain("/workspace/plugins/demo/.dsh-plugin-source.json");
    const marker = fake.writes.find((write) =>
      write.path.endsWith(".dsh-plugin-source.json"),
    );
    expect(JSON.parse(new TextDecoder().decode(marker?.content))).toEqual({
      name: "demo",
      version: HASH,
    });
  });

  it("accepts an existing empty destination directory", async () => {
    const home = await temporary();
    const version = await storedPlugin(home);
    const profileDir = await profileWithLink(home, version);
    const fake = fakeClient({
      destinationExists: true,
      destinationDirectory: true,
      destinationEntries: 0,
    });
    await expect(
      run(
        { home, profileDir, sandbox: fakeSandbox(fake.client) },
        { action: "checkout", name: "demo" },
      ),
    ).resolves.toMatchObject({ name: "demo" });
  });

  it("refuses a non-empty destination directory", async () => {
    const home = await temporary();
    const version = await storedPlugin(home);
    const profileDir = await profileWithLink(home, version);
    const fake = fakeClient({
      destinationExists: true,
      destinationDirectory: true,
      destinationEntries: 1,
    });
    await expect(
      run(
        { home, profileDir, sandbox: fakeSandbox(fake.client) },
        { action: "checkout", name: "demo" },
      ),
    ).rejects.toThrow(/not empty/);
  });

  it("removes files written before a failed checkout", async () => {
    const home = await temporary();
    const version = await storedPlugin(home);
    const profileDir = await profileWithLink(home, version);
    const fake = fakeClient({ failWriteAt: 2 });
    await expect(
      run(
        { home, profileDir, sandbox: fakeSandbox(fake.client) },
        { action: "checkout", name: "demo" },
      ),
    ).rejects.toThrow(/write failed/);
    expect(fake.deleted).toEqual(["/workspace/plugins/demo/index.js"]);
  });

  it("refuses a destination whose parent resolves outside the workspace", async () => {
    const home = await temporary();
    const version = await storedPlugin(home);
    const profileDir = await profileWithLink(home, version);
    const fake = fakeClient({ canonicalPath: "/outside/demo" });
    await expect(
      run(
        { home, profileDir, sandbox: fakeSandbox(fake.client) },
        { action: "checkout", name: "demo" },
      ),
    ).rejects.toThrow(/resolves outside/);
  });

  it("refuses an existing destination", async () => {
    const home = await temporary();
    const version = await storedPlugin(home);
    const profileDir = await profileWithLink(home, version);
    const fake = fakeClient({ destinationExists: true });
    await expect(
      run(
        { home, profileDir, sandbox: fakeSandbox(fake.client) },
        { action: "checkout", name: "demo" },
      ),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses a destination outside the workspace", async () => {
    const home = await temporary();
    const version = await storedPlugin(home);
    const profileDir = await profileWithLink(home, version);
    const fake = fakeClient();
    await expect(
      run(
        { home, profileDir, sandbox: fakeSandbox(fake.client) },
        { action: "checkout", name: "demo", path: "../escape" },
      ),
    ).rejects.toThrow(/inside this session's workspace/);
  });

  it("reports an unknown stored plugin", async () => {
    const home = await temporary();
    const fake = fakeClient();
    await expect(
      run(
        {
          home,
          profileDir: join(home, "profiles", "web"),
          sandbox: fakeSandbox(fake.client),
        },
        { action: "checkout", name: "missing" },
      ),
    ).rejects.toThrow(/no stored source/);
  });
});

interface Harness {
  ctx: Context;
  agent: Agent;
  registered: string[];
  agents: Agent[];
  selectPreset: (preset: string | undefined) => void;
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function makeHarness(
  options: { preset?: string; origin?: "subagent" } = {},
): Harness {
  const ctx = new Context();
  let preset: string | undefined = options.preset ?? "cordis";
  const registered: string[] = [];
  const agent = {
    id: "session-1",
    session: { header: { origin: options.origin } },
    ctx: {
      inject: (_services: string[], callback: (scope: unknown) => void) => {
        const effects: Array<() => void> = [];
        const scopedTools = {
          register: (definition: ToolDefinition) => {
            registered.push(definition.name);
            return () => {
              const index = registered.indexOf(definition.name);
              if (index >= 0) {
                registered.splice(index, 1);
              }
            };
          },
        };
        callback({
          tools: scopedTools,
          effect: (factory: () => () => void) => {
            effects.push(factory());
          },
        });
        return {
          dispose: () => {
            for (const dispose of effects.splice(0)) {
              dispose();
            }
          },
        };
      },
    },
  } as unknown as Agent;
  const agents: Agent[] = [];
  ctx.provide("agents", { list: () => agents });
  ctx.provide("sandboxManager", {
    workspace: "/workspace",
    clientForCurrentAgent: async () => ({}),
  });
  ctx.provide("profileContext", {
    home: "/data/.dsh",
    dir: "/data/.dsh/profiles/web",
  });
  ctx.provide("agentPresets", { composedPreset: () => preset });
  return {
    ctx,
    agent,
    registered,
    agents,
    selectPreset: (next) => {
      preset = next;
    },
  };
}

describe("plugin_source registration", () => {
  it("registers only in the Creator preset and follows preset changes", async () => {
    const harness = makeHarness();
    apply(harness.ctx, { presets: ["cordis"] });
    await flush();
    harness.agents.push(harness.agent);
    harness.ctx.emit("agent/created", {
      agent: harness.agent,
      source: "startup",
    });
    await flush();
    expect(harness.registered).toEqual(["plugin_source"]);

    harness.selectPreset("standard");
    harness.ctx.emit("tools/change");
    await flush();
    expect(harness.registered).toEqual([]);

    harness.selectPreset("cordis");
    harness.ctx.emit("tools/change");
    await flush();
    expect(harness.registered).toEqual(["plugin_source"]);
  });

  it("never registers on a subagent", async () => {
    const harness = makeHarness({ origin: "subagent" });
    apply(harness.ctx, { presets: ["cordis"] });
    await flush();
    harness.agents.push(harness.agent);
    harness.ctx.emit("agent/created", {
      agent: harness.agent,
      source: "startup",
    });
    await flush();
    expect(harness.registered).toEqual([]);
  });
});
