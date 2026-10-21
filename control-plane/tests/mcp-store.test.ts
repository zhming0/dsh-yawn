import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpServerStore } from "../src/mcp-store.js";

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
    await store.upsert({
      serverName: "zeta",
      url: "https://zeta.example/mcp",
      auth: "none",
      enabled: true,
      offByDefault: false,
    });
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      auth: "bearer",
      token: "alpha-token",
      enabled: true,
      offByDefault: false,
    });

    expect(store.list().map((entry) => entry.serverName)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(store.get("alpha")).toEqual({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      auth: "bearer",
      enabled: true,
      offByDefault: false,
    });
    expect(store.tokenFor("alpha")).toBe("alpha-token");

    const reopened = new McpServerStore({ path });
    await reopened.initialize();
    expect(reopened.list().map((entry) => entry.serverName)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(reopened.tokenFor("alpha")).toBe("alpha-token");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("keeps a server that starts new sessions turned off", async () => {
    const path = join(directory, "mcp.json");
    const store = new McpServerStore({ path });
    await store.initialize();
    await store.upsert({
      serverName: "stripe",
      url: "https://stripe.example/mcp",
      auth: "none",
      enabled: true,
      offByDefault: true,
    });
    await store.upsert({
      serverName: "github",
      url: "https://github.example/mcp",
      auth: "none",
      enabled: true,
      offByDefault: false,
    });

    // Only the turned-off server carries the field in the file.
    const file = JSON.parse(await readFile(path, "utf8")) as {
      servers: Array<Record<string, unknown>>;
    };
    expect(file.servers).toEqual([
      {
        serverName: "github",
        url: "https://github.example/mcp",
        auth: "none",
        enabled: true,
      },
      {
        serverName: "stripe",
        url: "https://stripe.example/mcp",
        auth: "none",
        enabled: true,
        offByDefault: true,
      },
    ]);

    const reopened = new McpServerStore({ path });
    await reopened.initialize();
    expect(reopened.get("stripe")?.offByDefault).toBe(true);
    expect(reopened.get("github")?.offByDefault).toBe(false);
  });

  it("reads a file written before the setting as every server on", async () => {
    const path = join(directory, "mcp.json");
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        servers: [{ serverName: "github", url: "https://github.example/mcp" }],
      })}\n`,
    );
    const store = new McpServerStore({ path });
    await store.initialize();
    expect(store.get("github")).toMatchObject({
      auth: "none",
      enabled: true,
      offByDefault: false,
    });
  });

  it("returns no token from list or get", async () => {
    const store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      auth: "bearer",
      token: "alpha-token",
      enabled: true,
      offByDefault: false,
    });

    const [listed] = store.list();
    expect(listed).toEqual({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      auth: "bearer",
      enabled: true,
      offByDefault: false,
    });
    expect(store.get("alpha")).toEqual({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      auth: "bearer",
      enabled: true,
      offByDefault: false,
    });
  });

  it("keeps the saved token when an update omits it", async () => {
    const path = join(directory, "mcp.json");
    const store = new McpServerStore({ path });
    await store.initialize();
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      auth: "bearer",
      token: "first-token",
      enabled: true,
      offByDefault: false,
    });

    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      auth: "bearer",
      enabled: false,
      offByDefault: false,
    });
    expect(store.tokenFor("alpha")).toBe("first-token");
    expect(store.get("alpha")?.enabled).toBe(false);

    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      auth: "bearer",
      token: "second-token",
      enabled: true,
      offByDefault: false,
    });
    expect(store.tokenFor("alpha")).toBe("second-token");

    const reopened = new McpServerStore({ path });
    await reopened.initialize();
    expect(reopened.tokenFor("alpha")).toBe("second-token");
  });

  it("rejects invalid names and URLs", async () => {
    const store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();

    await expect(
      store.upsert({
        serverName: "bad name",
        url: "https://alpha.example/mcp",
        auth: "none",
        enabled: true,
        offByDefault: false,
      }),
    ).rejects.toThrow("invalid MCP server name");
    await expect(
      store.upsert({
        serverName: "alpha",
        url: "not a url",
        auth: "none",
        enabled: true,
        offByDefault: false,
      }),
    ).rejects.toThrow("invalid MCP server URL");
    await expect(
      store.upsert({
        serverName: "alpha",
        url: "ftp://alpha.example/mcp",
        auth: "none",
        enabled: true,
        offByDefault: false,
      }),
    ).rejects.toThrow("must use http or https");
    expect(store.list()).toEqual([]);
  });

  it("rejects names whose tool prefix would overlap another server's", async () => {
    const store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();

    // A server is identified by `mcp__<name>__`, so these two shapes would
    // each swallow a neighbour's tools: `gh__x` starts with `mcp__gh__`, and
    // `gh_` makes `mcp__gh___`.
    await expect(
      store.upsert({
        serverName: "gh__x",
        url: "https://alpha.example/mcp",
        auth: "none",
        enabled: true,
        offByDefault: false,
      }),
    ).rejects.toThrow('"__" is reserved');
    await expect(
      store.upsert({
        serverName: "gh_",
        url: "https://alpha.example/mcp",
        auth: "none",
        enabled: true,
        offByDefault: false,
      }),
    ).rejects.toThrow('trailing "_" collides');
    expect(store.list()).toEqual([]);
  });

  it("removes one entry and leaves the others", async () => {
    const path = join(directory, "mcp.json");
    const store = new McpServerStore({ path });
    await store.initialize();
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      auth: "bearer",
      token: "alpha-token",
      enabled: true,
      offByDefault: false,
    });
    await store.upsert({
      serverName: "beta",
      url: "https://beta.example/mcp",
      auth: "none",
      enabled: true,
      offByDefault: false,
    });

    await store.remove("alpha");
    expect(store.list().map((entry) => entry.serverName)).toEqual(["beta"]);
    expect(store.tokenFor("alpha")).toBeUndefined();

    const reopened = new McpServerStore({ path });
    await reopened.initialize();
    expect(reopened.list().map((entry) => entry.serverName)).toEqual(["beta"]);
  });

  it("reads a file written before auth modes as bearer or none", async () => {
    const path = join(directory, "mcp.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        servers: [
          {
            serverName: "alpha",
            url: "https://alpha.example/mcp",
            token: "alpha-token",
            enabled: true,
            offByDefault: false,
          },
          { serverName: "beta", url: "https://beta.example/mcp" },
        ],
      }),
    );
    const store = new McpServerStore({ path });
    await store.initialize();

    expect(store.list()).toEqual([
      {
        serverName: "alpha",
        url: "https://alpha.example/mcp",
        auth: "bearer",
        enabled: true,
        offByDefault: false,
      },
      {
        serverName: "beta",
        url: "https://beta.example/mcp",
        auth: "none",
        enabled: true,
        offByDefault: false,
      },
    ]);
    expect(store.tokenFor("alpha")).toBe("alpha-token");
  });

  it("drops a bearer token when the server switches auth mode", async () => {
    const store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      auth: "bearer",
      token: "alpha-token",
      enabled: true,
      offByDefault: false,
    });

    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      auth: "none",
      enabled: true,
      offByDefault: false,
    });
    expect(store.tokenFor("alpha")).toBeUndefined();

    // Switching back does not resurrect it.
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      auth: "bearer",
      enabled: true,
      offByDefault: false,
    });
    expect(store.hasBearerToken("alpha")).toBe(false);
  });

  describe("OAuth sign-ins", () => {
    const oauthEntry = {
      serverName: "notion",
      url: "https://notion.example/mcp",
      auth: "oauth",
      enabled: true,
      offByDefault: false,
    } as const;
    const credential = {
      redirectUri: "https://dsh.example/dsh-yawn/mcp/oauth/callback",
      client: { client_id: "client-1" },
      tokens: { access_token: "access-1", token_type: "Bearer" },
      expiresAt: 10_000,
    };

    it("serves the access token until it expires, and never lists it", async () => {
      let now = 0;
      const path = join(directory, "mcp.json");
      const store = new McpServerStore({ path, now: () => now });
      await store.initialize();
      await store.upsert(oauthEntry);
      expect(store.tokenFor("notion")).toBeUndefined();
      expect(store.oauthStatus("notion")).toEqual({ kind: "none" });

      await store.saveOAuth("notion", oauthEntry.url, credential);
      expect(store.tokenFor("notion")).toBe("access-1");
      expect(store.oauthStatus("notion")).toEqual({
        kind: "valid",
        until: 10_000,
      });
      expect(store.get("notion")).toEqual(oauthEntry);
      expect(store.hasBearerToken("notion")).toBe(false);

      const reopened = new McpServerStore({ path, now: () => now });
      await reopened.initialize();
      expect(reopened.tokenFor("notion")).toBe("access-1");

      now = 10_000;
      expect(store.tokenFor("notion")).toBeUndefined();
      expect(store.oauthStatus("notion")).toEqual({ kind: "expired" });
    });

    it("keeps a sign-in across edits and drops it when the URL changes", async () => {
      const store = new McpServerStore({
        path: join(directory, "mcp.json"),
        now: () => 0,
      });
      await store.initialize();
      await store.upsert(oauthEntry);
      await store.saveOAuth("notion", oauthEntry.url, credential);

      await store.upsert({ ...oauthEntry, enabled: false });
      expect(store.oauthFor("notion")).toEqual(credential);

      await store.upsert({ ...oauthEntry, url: "https://other.example/mcp" });
      expect(store.oauthFor("notion")).toBeUndefined();
    });

    it("replaces only the sign-in a refresh token belongs to", async () => {
      const store = new McpServerStore({
        path: join(directory, "mcp.json"),
        now: () => 0,
      });
      await store.initialize();
      await store.upsert(oauthEntry);
      const renewable = {
        ...credential,
        tokens: { ...credential.tokens, refresh_token: "refresh-1" },
      };
      await store.saveOAuth("notion", oauthEntry.url, renewable);
      expect(store.oauthStatus("notion")).toEqual({
        kind: "valid",
        until: 10_000,
        renews: true,
      });

      const renewed = {
        ...renewable,
        tokens: {
          access_token: "access-2",
          token_type: "Bearer",
          refresh_token: "refresh-2",
        },
        expiresAt: 20_000,
      };
      await expect(
        store.replaceOAuth("notion", "refresh-0", renewed),
      ).resolves.toBe(false);
      expect(store.tokenFor("notion")).toBe("access-1");
      await expect(
        store.replaceOAuth("notion", "refresh-1", renewed),
      ).resolves.toBe(true);
      expect(store.oauthFor("notion")).toEqual(renewed);

      // Without an expiry nothing is renewed, so the card must not say so.
      const { expiresAt: _expiresAt, ...unbounded } = renewed;
      await store.replaceOAuth("notion", "refresh-2", unbounded);
      expect(store.oauthStatus("notion")).toEqual({ kind: "valid" });

      await expect(
        store.replaceOAuth("notion", "refresh-2", undefined),
      ).resolves.toBe(true);
      expect(store.oauthFor("notion")).toBeUndefined();
      expect(store.get("notion")).toEqual(oauthEntry);
    });

    it("refuses a sign-in for a server that changed meanwhile", async () => {
      const store = new McpServerStore({ path: join(directory, "mcp.json") });
      await store.initialize();
      await store.upsert(oauthEntry);

      await expect(
        store.saveOAuth("notion", "https://other.example/mcp", credential),
      ).rejects.toThrow("changed while it was being authorized");
      await store.upsert({ ...oauthEntry, auth: "none" });
      await expect(
        store.saveOAuth("notion", oauthEntry.url, credential),
      ).rejects.toThrow("changed while it was being authorized");
    });
  });
});
