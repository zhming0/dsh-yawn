import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GLOBAL_MCP_SCOPE,
  McpServerStore,
  type McpServerEntry,
} from "../src/mcp-store.js";

const WORKSPACE = "https://github.com/example/one";
const OTHER_WORKSPACE = "https://github.com/example/two";

const alpha: McpServerEntry = {
  serverName: "alpha",
  url: "https://alpha.example/mcp",
  enabled: true,
};

function workspaceScope(repositoryUrl: string) {
  return { kind: "workspace" as const, repositoryUrl };
}

describe("MCP server store", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-mcp-store-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips entries sorted by name in an owner-only file", async () => {
    const path = join(directory, "mcp.json");
    const store = new McpServerStore({ path });
    await store.initialize();
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "zeta",
      url: "https://zeta.example/mcp",
      enabled: true,
    });
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      token: "alpha-token",
      enabled: true,
    });

    expect(
      store.list(GLOBAL_MCP_SCOPE).map((entry) => entry.serverName),
    ).toEqual(["alpha", "zeta"]);
    expect(store.get("alpha")).toEqual({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    expect(store.tokenFor("alpha")).toBe("alpha-token");

    const reopened = new McpServerStore({ path });
    await reopened.initialize();
    expect(
      reopened.list(GLOBAL_MCP_SCOPE).map((entry) => entry.serverName),
    ).toEqual(["alpha", "zeta"]);
    expect(reopened.tokenFor("alpha")).toBe("alpha-token");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("keeps one scope's entries apart from the other's", async () => {
    const path = join(directory, "mcp.json");
    const store = new McpServerStore({ path });
    await store.initialize();
    await store.upsert(GLOBAL_MCP_SCOPE, alpha);
    await store.upsert(workspaceScope(WORKSPACE), {
      serverName: "beta",
      url: "https://beta.example/mcp",
      token: "beta-token",
      enabled: true,
    });

    expect(store.entries()).toEqual([
      { entry: alpha, scope: { kind: "global" } },
      {
        entry: {
          serverName: "beta",
          url: "https://beta.example/mcp",
          enabled: true,
        },
        scope: { kind: "workspace", repositoryUrl: WORKSPACE },
      },
    ]);
    expect(store.get("beta")?.serverName).toBe("beta");
    expect(store.tokenFor("beta")).toBe("beta-token");

    await store.remove(workspaceScope(WORKSPACE), "beta");
    expect(store.get("beta")).toBeUndefined();
    expect(store.tokenFor("beta")).toBeUndefined();
    expect(store.list(GLOBAL_MCP_SCOPE)).toEqual([alpha]);

    // The emptied workspace section is dropped from the file.
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      workspaces: Record<string, unknown>;
    };
    expect(saved.workspaces).toEqual({});
  });

  it("rejects a name that another scope already took", async () => {
    const store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();
    await store.upsert(workspaceScope(WORKSPACE), alpha);

    await expect(
      store.upsert(GLOBAL_MCP_SCOPE, { ...alpha, url: "https://other/mcp" }),
    ).rejects.toThrow(`already exists in the workspace ${WORKSPACE}`);
    await expect(
      store.upsert(workspaceScope(OTHER_WORKSPACE), {
        ...alpha,
        url: "https://other/mcp",
      }),
    ).rejects.toThrow(`already exists in the workspace ${WORKSPACE}`);
    // The same scope may re-upsert its own entry.
    await store.upsert(workspaceScope(WORKSPACE), {
      ...alpha,
      enabled: false,
    });
    expect(store.list(workspaceScope(WORKSPACE))[0]?.enabled).toBe(false);

    // The mirror case: a global name cannot be taken by a workspace.
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "gamma",
      url: "https://gamma.example/mcp",
      enabled: true,
    });
    await expect(
      store.upsert(workspaceScope(WORKSPACE), {
        serverName: "gamma",
        url: "https://other/mcp",
        enabled: true,
      }),
    ).rejects.toThrow("already exists in the global scope");
  });

  it("rejects a version 1 file: nothing deployed reads the old format", async () => {
    const path = join(directory, "mcp.json");
    await writeFileEntry(path);
    const store = new McpServerStore({ path });
    await expect(store.initialize()).rejects.toThrow("unsupported format");
  });

  it("returns no token from list, entries, or get", async () => {
    const store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();
    await store.upsert(workspaceScope(WORKSPACE), {
      ...alpha,
      token: "beta-token",
    });

    expect(
      store.entries().every(({ entry }) => entry.token === undefined),
    ).toBe(true);
    expect(store.list(workspaceScope(WORKSPACE))[0]?.token).toBeUndefined();
    expect(store.get("alpha")?.token).toBeUndefined();
  });

  it("keeps the saved token when an update omits it", async () => {
    const path = join(directory, "mcp.json");
    const store = new McpServerStore({ path });
    await store.initialize();
    const scope = workspaceScope(WORKSPACE);
    await store.upsert(scope, { ...alpha, token: "first-token" });

    await store.upsert(scope, { ...alpha, enabled: false });
    expect(store.tokenFor("alpha")).toBe("first-token");
    expect(store.get("alpha")?.enabled).toBe(false);

    await store.upsert(scope, { ...alpha, token: "second-token" });
    expect(store.tokenFor("alpha")).toBe("second-token");

    const reopened = new McpServerStore({ path });
    await reopened.initialize();
    expect(reopened.tokenFor("alpha")).toBe("second-token");
  });

  it("rejects invalid names and URLs in every scope", async () => {
    const store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();

    await expect(
      store.upsert(GLOBAL_MCP_SCOPE, {
        serverName: "bad name",
        url: "https://alpha.example/mcp",
        enabled: true,
      }),
    ).rejects.toThrow("invalid MCP server name");
    await expect(
      store.upsert(workspaceScope(WORKSPACE), {
        serverName: "alpha",
        url: "not a url",
        enabled: true,
      }),
    ).rejects.toThrow("invalid MCP server URL");
    await expect(
      store.upsert(workspaceScope(WORKSPACE), {
        serverName: "alpha",
        url: "ftp://alpha.example/mcp",
        enabled: true,
      }),
    ).rejects.toThrow("must use http or https");
    expect(store.entries()).toEqual([]);
  });

  it("rejects names whose tool prefix would overlap another server's", async () => {
    const store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();

    // A server is identified by `mcp__<name>__`, so these two shapes would
    // each swallow a neighbour's tools: `gh__x` starts with `mcp__gh__`, and
    // `gh_` makes `mcp__gh___`.
    await expect(
      store.upsert(GLOBAL_MCP_SCOPE, {
        serverName: "gh__x",
        url: "https://alpha.example/mcp",
        enabled: true,
      }),
    ).rejects.toThrow('"__" is reserved');
    await expect(
      store.upsert(workspaceScope(WORKSPACE), {
        serverName: "gh_",
        url: "https://alpha.example/mcp",
        enabled: true,
      }),
    ).rejects.toThrow('trailing "_" collides');
    expect(store.entries()).toEqual([]);
  });

  it("clears a saved token when an update sends null", async () => {
    const path = join(directory, "mcp.json");
    const store = new McpServerStore({ path });
    await store.initialize();
    const scope = workspaceScope(WORKSPACE);
    await store.upsert(scope, { ...alpha, token: "alpha-token" });
    expect(store.tokenFor("alpha")).toBe("alpha-token");

    await store.upsert(scope, { ...alpha, token: null });
    expect(store.tokenFor("alpha")).toBeUndefined();

    const reopened = new McpServerStore({ path });
    await reopened.initialize();
    expect(reopened.tokenFor("alpha")).toBeUndefined();
  });

  it("removes one entry and leaves the others", async () => {
    const path = join(directory, "mcp.json");
    const store = new McpServerStore({ path });
    await store.initialize();
    await store.upsert(GLOBAL_MCP_SCOPE, {
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      token: "alpha-token",
      enabled: true,
    });
    await store.upsert(workspaceScope(WORKSPACE), {
      serverName: "beta",
      url: "https://beta.example/mcp",
      enabled: true,
    });

    await store.remove(GLOBAL_MCP_SCOPE, "alpha");
    expect(store.entries().map(({ entry }) => entry.serverName)).toEqual([
      "beta",
    ]);
    expect(store.tokenFor("alpha")).toBeUndefined();

    const reopened = new McpServerStore({ path });
    await reopened.initialize();
    expect(reopened.entries().map(({ entry }) => entry.serverName)).toEqual([
      "beta",
    ]);
  });
});

async function writeFileEntry(path: string): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({
      version: 1,
      servers: [
        {
          serverName: "legacy",
          url: "https://legacy.example/mcp",
          enabled: true,
        },
      ],
    })}\n`,
    "utf8",
  );
}
