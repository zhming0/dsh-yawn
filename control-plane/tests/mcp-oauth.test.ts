import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  callbackUrl,
  MCP_OAUTH_CALLBACK_PATH,
  McpOAuth,
} from "../src/mcp-oauth.js";
import { McpPool } from "../src/mcp-pool.js";
import { McpServerStore } from "../src/mcp-store.js";

const ORIGIN = "http://dsh.localhost:8080";

/**
 * One local server playing both parts the MCP authorization spec describes:
 * an OAuth-protected Streamable HTTP MCP endpoint at `/mcp`, and the
 * authorization server it names, with dynamic client registration and PKCE.
 * `/authorize` approves at once and redirects with a code, standing in for
 * the user's consent page. Every token response issues a new access token
 * and rotates the refresh token; only the newest access token is accepted.
 */
type Refusal = "invalid_grant" | "invalid_client" | "server_error";

async function startProtectedServer(): Promise<{
  url: string;
  registrations: () => number;
  tokenRequests: () => number;
  /** The bearer token of the last request `/mcp` accepted. */
  lastAccepted: () => string;
  /** Answer the next refresh grants with this OAuth error, or succeed. */
  refuseRefresh: (error: Refusal | undefined) => void;
  close: () => Promise<void>;
}> {
  let base = "";
  let registrations = 0;
  let tokenRequests = 0;
  let issued = 0;
  let accessToken = "";
  let refreshToken = "";
  let lastAccepted = "";
  let refusal: Refusal | undefined;
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", base);
    const body = await readBody(req);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") {
      registrations += 1;
      return json(res, 201, {
        ...(JSON.parse(body) as object),
        client_id: `client-${registrations}`,
        token_endpoint_auth_method: "none",
      });
    }
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const code = `code-${codes.size + 1}`;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirectUri,
      });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      back.searchParams.set("iss", base);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === "/token") {
      tokenRequests += 1;
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token") {
        if (refusal !== undefined) {
          const status = { server_error: 500, invalid_client: 401 }[
            refusal as string
          ];
          return json(res, status ?? 400, { error: refusal });
        }
        if (form.get("refresh_token") !== refreshToken) {
          return json(res, 400, { error: "invalid_grant" });
        }
        return json(res, 200, issueTokens());
      }
      const grant = codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      if (
        grant === undefined ||
        grant.challenge !== challenge ||
        grant.redirectUri !== form.get("redirect_uri")
      ) {
        return json(res, 400, { error: "invalid_grant" });
      }
      codes.delete(form.get("code") ?? "");
      return json(res, 200, issueTokens());
    }
    if (url.pathname === "/mcp") {
      if (
        accessToken === "" ||
        req.headers.authorization !== `Bearer ${accessToken}`
      ) {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
        return res.end();
      }
      lastAccepted = accessToken;
      return serveMcp(req, res, body);
    }
    res.writeHead(404);
    res.end();
  }

  function issueTokens() {
    issued += 1;
    accessToken = `access-${issued}`;
    refreshToken = `refresh-${issued}`;
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
    };
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${port(server)}`;
  return {
    url: `${base}/mcp`,
    registrations: () => registrations,
    tokenRequests: () => tokenRequests,
    lastAccepted: () => lastAccepted,
    refuseRefresh: (error) => {
      refusal = error;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function serveMcp(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) {
  const transport = new WebStandardStreamableHTTPServerTransport();
  const mcp = new McpServer({ name: "yawn-oauth-test", version: "1.0.0" });
  mcp.registerTool(
    "drink",
    { description: "report the validation drink", inputSchema: {} },
    async () => ({ content: [{ type: "text" as const, text: "lapsang" }] }),
  );
  await mcp.connect(transport);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  const web = await transport.handleRequest(
    new Request(`http://127.0.0.1${req.url ?? "/"}`, {
      method: req.method ?? "POST",
      headers,
      ...(body === "" ? {} : { body }),
    }),
  );
  res.writeHead(web.status, Object.fromEntries(web.headers));
  res.end(Buffer.from(await web.arrayBuffer()));
  await transport.close();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function port(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server did not bind a port");
  }
  return address.port;
}

function toolsPlugin(ctx: Context) {
  const registered = new Map<string, unknown>();
  ctx.provide("tools", {
    register(definition: { name: string }) {
      registered.set(definition.name, definition);
      return () => void registered.delete(definition.name);
    },
    schemas: (): ToolSchema[] =>
      [...registered.keys()].map((name) => ({ name }) as ToolSchema),
  });
}

/** Follow the authorization URL to the redirect the browser would land on. */
async function approve(authorizationUrl: string): Promise<URL> {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error(`no redirect from ${authorizationUrl}`);
  }
  return new URL(location);
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("MCP OAuth sign-in", () => {
  let directory: string;
  let store: McpServerStore;
  let pool: McpPool;
  let oauth: McpOAuth;
  let protectedServer: Awaited<ReturnType<typeof startProtectedServer>>;
  let warnings: string[];
  /** Added to the clock, to bring an access token close to expiry. */
  let skewMs: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-mcp-oauth-"));
    skewMs = 0;
    store = new McpServerStore({
      path: join(directory, "mcp.json"),
      now: () => Date.now() + skewMs,
    });
    await store.initialize();
    const ctx = new Context();
    await ctx.plugin(toolsPlugin);
    pool = new McpPool({ ctx, store, warn: () => {} });
    warnings = [];
    oauth = new McpOAuth({
      store,
      authorized: () => pool.sync(),
      warn: (message) => warnings.push(message),
      now: () => Date.now() + skewMs,
    });
    protectedServer = await startProtectedServer();
    await store.upsert({
      serverName: "notion",
      url: protectedServer.url,
      auth: "oauth",
      enabled: true,
    });
  });

  afterEach(async () => {
    await pool.dispose();
    await protectedServer.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("waits for a sign-in, then mounts with the access token", async () => {
    await pool.sync();
    expect(pool.views()).toMatchObject([
      {
        serverName: "notion",
        status: "needs-auth",
        authorization: { kind: "none" },
      },
    ]);

    const authorizationUrl = new URL(await oauth.start("notion", ORIGIN));
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}${MCP_OAUTH_CALLBACK_PATH}`,
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const callback = await approve(authorizationUrl.href);

    await expect(oauth.finish(callback.searchParams)).resolves.toBe("notion");
    expect(store.tokenFor("notion")).toBe("access-1");
    const connected = await waitFor(() => {
      const view = pool.views()[0];
      return view?.status === "connected" ? view : undefined;
    });
    expect(connected).toMatchObject({
      toolCount: 1,
      authorization: { kind: "valid", renews: true },
    });

    // The state is single-use.
    await expect(oauth.finish(callback.searchParams)).rejects.toThrow(
      "unknown or has expired",
    );
  }, 30_000);

  it("reuses the client registration when signing in again", async () => {
    const first = await approve(await oauth.start("notion", ORIGIN));
    await oauth.finish(first.searchParams);
    const second = await approve(await oauth.start("notion", ORIGIN));
    await oauth.finish(second.searchParams);
    expect(protectedServer.registrations()).toBe(1);

    // Another address is another redirect URI, so it registers again.
    await approve(await oauth.start("notion", "http://other.localhost:8080"));
    expect(protectedServer.registrations()).toBe(2);
  }, 30_000);

  it("renews an access token close to expiry and remounts with it", async () => {
    const callback = await approve(await oauth.start("notion", ORIGIN));
    await oauth.finish(callback.searchParams);
    await waitFor(() =>
      pool.views()[0]?.status === "connected" ? true : undefined,
    );

    // Not due until ten minutes before expiry: nothing is sent.
    skewMs = 3600_000 - 10 * 60_000 - 1_000;
    await oauth.renewDue();
    expect(protectedServer.tokenRequests()).toBe(1);

    skewMs += 2_000;
    await oauth.renewDue();
    expect(protectedServer.tokenRequests()).toBe(2);
    expect(store.tokenFor("notion")).toBe("access-2");
    expect(store.oauthFor("notion")?.tokens.refresh_token).toBe("refresh-2");
    expect(warnings).toEqual([]);

    // The new token is not due again.
    await oauth.renewDue();
    expect(protectedServer.tokenRequests()).toBe(2);

    await pool.sync();
    await waitFor(() =>
      protectedServer.lastAccepted() === "access-2" &&
      pool.views()[0]?.status === "connected"
        ? true
        : undefined,
    );
    expect(protectedServer.registrations()).toBe(1);
  }, 30_000);

  it("stops renewing once the refresh token is refused", async () => {
    const callback = await approve(await oauth.start("notion", ORIGIN));
    await oauth.finish(callback.searchParams);
    protectedServer.refuseRefresh("invalid_grant");
    skewMs = 3600_000 - 5 * 60_000;

    await oauth.renewDue();
    expect(warnings).toEqual([
      expect.stringContaining("refused the refresh token"),
    ]);
    // The access token still works until it expires; then a sign-in is due.
    expect(store.tokenFor("notion")).toBe("access-1");
    expect(store.oauthFor("notion")?.tokens.refresh_token).toBeUndefined();
    expect(store.oauthStatus("notion")).toEqual({
      kind: "valid",
      until: expect.any(Number) as number,
    });
    await oauth.renewDue();
    expect(protectedServer.tokenRequests()).toBe(2);
    expect(protectedServer.registrations()).toBe(1);
  }, 30_000);

  it("drops the sign-in when the client is refused, without registering", async () => {
    const callback = await approve(await oauth.start("notion", ORIGIN));
    await oauth.finish(callback.searchParams);
    protectedServer.refuseRefresh("invalid_client");
    skewMs = 3600_000 - 5 * 60_000;

    await oauth.renewDue();
    expect(warnings).toEqual([expect.stringContaining("refused the client")]);
    expect(store.oauthFor("notion")).toBeUndefined();
    expect(protectedServer.registrations()).toBe(1);

    // So the next sign-in registers a new client.
    await approve(await oauth.start("notion", ORIGIN));
    expect(protectedServer.registrations()).toBe(2);
  }, 30_000);

  it("retries a failed renewal later, not on every tick", async () => {
    const callback = await approve(await oauth.start("notion", ORIGIN));
    await oauth.finish(callback.searchParams);
    protectedServer.refuseRefresh("server_error");
    skewMs = 3600_000 - 5 * 60_000;

    await oauth.renewDue();
    await oauth.renewDue();
    expect(protectedServer.tokenRequests()).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(store.oauthFor("notion")?.tokens.refresh_token).toBe("refresh-1");

    // A minute later the next tick tries again.
    protectedServer.refuseRefresh(undefined);
    skewMs += 60_000;
    await oauth.renewDue();
    expect(store.tokenFor("notion")).toBe("access-2");
  }, 30_000);

  it("reports a refused sign-in and saves nothing", async () => {
    const authorizationUrl = new URL(await oauth.start("notion", ORIGIN));
    const refused = new URLSearchParams({
      state: authorizationUrl.searchParams.get("state") ?? "",
      error: "access_denied",
      error_description: "The user said no",
    });
    await expect(oauth.finish(refused)).rejects.toThrow("The user said no");
    expect(store.oauthFor("notion")).toBeUndefined();
  });

  it("refuses a server that does not use OAuth", async () => {
    await store.upsert({
      serverName: "plain",
      url: protectedServer.url,
      auth: "none",
      enabled: true,
    });
    await expect(oauth.start("plain", ORIGIN)).rejects.toThrow(
      "does not use OAuth",
    );
  });

  it("answers the callback with an escaped page", async () => {
    const server = createServer((req, res) => {
      void oauth.handleCallback(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${port(server)}${MCP_OAUTH_CALLBACK_PATH}?state=<b>`,
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const page = await response.text();
      expect(page).toContain("Sign-in failed");
      expect(page).not.toContain("<b>");
      expect(page).not.toContain("window.close");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("builds the callback on the page origin only", () => {
    expect(callbackUrl("https://dsh.example/settings?x=1")).toBe(
      `https://dsh.example${MCP_OAUTH_CALLBACK_PATH}`,
    );
    expect(() => callbackUrl("javascript:alert(1)")).toThrow(
      "invalid control-plane origin",
    );
  });
});
