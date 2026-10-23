import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
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
  MCP_OAUTH_CLIENT_METADATA_PATH,
  McpOAuth,
} from "../src/mcp-oauth.js";
import { McpPool } from "../src/mcp-pool.js";
import { McpServerStore } from "../src/mcp-store.js";

const ORIGIN = "http://dsh.localhost:8080";

/**
 * One local server playing both parts the MCP authorization spec describes:
 * an OAuth-protected Streamable HTTP MCP endpoint at `/mcp`, and the
 * authorization server it names, with client registration and PKCE. It can
 * advertise Client ID Metadata Documents and drop dynamic registration, to
 * stand in for a server that has moved to CIMD. `/authorize` approves at once
 * and redirects with a code, standing in for the user's consent page. Every
 * token response issues a new access token and rotates the refresh token;
 * only the newest access token is accepted.
 */
type Refusal = "invalid_grant" | "invalid_client" | "server_error";

async function startProtectedServer(
  options: { cimd?: boolean; registration?: boolean } = {},
): Promise<{
  url: string;
  registrations: () => number;
  /** The `client_id` of each authorization request, in order. */
  clientIds: () => string[];
  /** Change the advertisement seen by the next sign-in. */
  setCimd: (supported: boolean) => void;
  /** The `client_id` of each token request, in order. */
  tokenClientIds: () => string[];
  tokenRequests: () => number;
  /** The bearer token of the last request `/mcp` accepted. */
  lastAccepted: () => string;
  /** Answer the next refresh grants with this OAuth error, or succeed. */
  refuseRefresh: (error: Refusal | undefined) => void;
  close: () => Promise<void>;
}> {
  const { cimd = false, registration = true } = options;
  let cimdSupported = cimd;
  let base = "";
  let registrations = 0;
  let tokenRequests = 0;
  let issued = 0;
  let accessToken = "";
  let refreshToken = "";
  let lastAccepted = "";
  let refusal: Refusal | undefined;
  const clientIds: string[] = [];
  const tokenClientIds: string[] = [];
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
        ...(registration ? { registration_endpoint: `${base}/register` } : {}),
        ...(cimdSupported
          ? { client_id_metadata_document_supported: true }
          : {}),
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
      clientIds.push(url.searchParams.get("client_id") ?? "");
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
      tokenClientIds.push(form.get("client_id") ?? "");
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
    clientIds: () => clientIds,
    setCimd: (supported) => {
      cimdSupported = supported;
    },
    tokenClientIds: () => tokenClientIds,
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

/** A request whose Host header is set explicitly, as a proxy would send it. */
function requestWithHost(
  port: number,
  path: string,
  host: string,
  method = "GET",
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      // No shared keep-alive agent, so the test server closes as soon as the
      // response is read instead of waiting for the agent's free socket.
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { host },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** Fetch the CIMD document this control plane serves for one Host. */
async function fetchMetadataDocument(
  oauth: McpOAuth,
  host: string,
  method = "GET",
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const server = createServer((request, response) =>
    oauth.handleClientMetadata(request, response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await requestWithHost(
      port(server),
      MCP_OAUTH_CLIENT_METADATA_PATH,
      host,
      method,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
  /** Servers a test started itself, closed after the pool lets go of them. */
  let extraServers: Awaited<ReturnType<typeof startProtectedServer>>[];
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
    extraServers = [];
    await store.upsert({
      serverName: "notion",
      url: protectedServer.url,
      auth: "oauth",
      enabled: true,
      offByDefault: false,
    });
  });

  afterEach(async () => {
    await pool.dispose();
    await protectedServer.close();
    for (const server of extraServers) {
      await server.close();
    }
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

  it("uses Client ID Metadata Documents when the server advertises them", async () => {
    // No registration endpoint: only CIMD can complete this sign-in.
    const cimdServer = await startProtectedServer({
      cimd: true,
      registration: false,
    });
    extraServers.push(cimdServer);
    await store.upsert({
      serverName: "linear",
      url: cimdServer.url,
      auth: "oauth",
      enabled: true,
      offByDefault: false,
    });
    const origin = "https://dsh.example";
    const clientId = `${origin}${MCP_OAUTH_CLIENT_METADATA_PATH}`;
    const authorizationUrl = new URL(await oauth.start("linear", origin));
    expect(authorizationUrl.searchParams.get("client_id")).toBe(clientId);
    expect(cimdServer.registrations()).toBe(0);

    // The document the authorization server fetches names the same client and
    // redirect URI the authorization request does.
    const document = JSON.parse(
      (await fetchMetadataDocument(oauth, "dsh.example")).body,
    ) as Record<string, unknown>;
    expect(document["client_id"]).toBe(
      authorizationUrl.searchParams.get("client_id"),
    );
    expect(document["redirect_uris"]).toEqual([
      authorizationUrl.searchParams.get("redirect_uri"),
    ]);

    const callback = await approve(authorizationUrl.href);
    expect(cimdServer.clientIds()).toEqual([clientId]);
    await expect(oauth.finish(callback.searchParams)).resolves.toBe("linear");
    expect(cimdServer.tokenClientIds()).toEqual([clientId]);
    expect(store.oauthFor("linear")?.client).toEqual({
      client_id: clientId,
      issuer: expect.any(String) as string,
    });

    // The saved identifier is what lets the next sign-in work now that the
    // server no longer advertises CIMD and still has no registration.
    cimdServer.setCimd(false);
    const again = new URL(await oauth.start("linear", origin));
    expect(again.searchParams.get("client_id")).toBe(clientId);
    const secondCallback = await approve(again.href);
    await expect(oauth.finish(secondCallback.searchParams)).resolves.toBe(
      "linear",
    );
    expect(cimdServer.clientIds()).toEqual([clientId, clientId]);
    expect(cimdServer.tokenClientIds()).toEqual([clientId, clientId]);
    expect(cimdServer.registrations()).toBe(0);
  }, 30_000);

  it("reuses a dynamic registration when CIMD arrives later", async () => {
    const server = await startProtectedServer();
    extraServers.push(server);
    await store.upsert({
      serverName: "linear",
      url: server.url,
      auth: "oauth",
      enabled: true,
      offByDefault: false,
    });
    const origin = "https://dsh.example";
    const first = new URL(await oauth.start("linear", origin));
    expect(first.searchParams.get("client_id")).toBe("client-1");
    const callback = await approve(first.href);
    await oauth.finish(callback.searchParams);

    // The saved registration wins over the newly advertised CIMD.
    server.setCimd(true);
    const again = new URL(await oauth.start("linear", origin));
    expect(again.searchParams.get("client_id")).toBe("client-1");
    const secondCallback = await approve(again.href);
    await oauth.finish(secondCallback.searchParams);
    expect(server.clientIds()).toEqual(["client-1", "client-1"]);
    expect(server.tokenClientIds()).toEqual(["client-1", "client-1"]);
    expect(server.registrations()).toBe(1);
  }, 30_000);

  it("renews a CIMD sign-in without registering", async () => {
    const cimdServer = await startProtectedServer({
      cimd: true,
      registration: false,
    });
    extraServers.push(cimdServer);
    await store.upsert({
      serverName: "linear",
      url: cimdServer.url,
      auth: "oauth",
      enabled: true,
      offByDefault: false,
    });
    const callback = await approve(
      await oauth.start("linear", "https://dsh.example"),
    );
    await oauth.finish(callback.searchParams);
    const client = store.oauthFor("linear")?.client;

    skewMs = 3600_000 - 5 * 60_000;
    await oauth.renewDue();
    expect(warnings).toEqual([]);
    expect(store.tokenFor("linear")).toBe("access-2");
    expect(store.oauthFor("linear")?.tokens.refresh_token).toBe("refresh-2");
    expect(store.oauthFor("linear")?.client).toEqual(client);
    expect(cimdServer.tokenRequests()).toBe(2);
    expect(cimdServer.registrations()).toBe(0);
  }, 30_000);

  it("keeps dynamic registration on a plain-HTTP origin", async () => {
    const cimdServer = await startProtectedServer({ cimd: true });
    extraServers.push(cimdServer);
    await store.upsert({
      serverName: "linear",
      url: cimdServer.url,
      auth: "oauth",
      enabled: true,
      offByDefault: false,
    });
    const authorizationUrl = new URL(await oauth.start("linear", ORIGIN));
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client-1");
    expect(cimdServer.registrations()).toBe(1);
    await approve(authorizationUrl.href);
    expect(cimdServer.clientIds()).toEqual(["client-1"]);
  }, 30_000);

  it("falls back to dynamic registration when CIMD is not advertised", async () => {
    const origin = "https://dsh.example";
    const authorizationUrl = new URL(await oauth.start("notion", origin));
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client-1");
    expect(protectedServer.registrations()).toBe(1);
  }, 30_000);

  it("serves the client metadata document for the fetching host", async () => {
    const response = await fetchMetadataDocument(oauth, "dsh.example:8443");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.body)).toEqual({
      client_id: `https://dsh.example:8443${MCP_OAUTH_CLIENT_METADATA_PATH}`,
      client_name: "DeepSeek Harness",
      redirect_uris: [`https://dsh.example:8443${MCP_OAUTH_CALLBACK_PATH}`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });

    // A default HTTPS port normalizes away, so the document URL is the one
    // the browser's origin produced.
    const defaultPort = JSON.parse(
      (await fetchMetadataDocument(oauth, "dsh.example:443")).body,
    ) as Record<string, unknown>;
    expect(defaultPort["client_id"]).toBe(
      `https://dsh.example${MCP_OAUTH_CLIENT_METADATA_PATH}`,
    );
    expect(defaultPort["redirect_uris"]).toEqual([
      `https://dsh.example${MCP_OAUTH_CALLBACK_PATH}`,
    ]);

    const refused = await fetchMetadataDocument(oauth, "dsh.example", "POST");
    expect(refused.status).toBe(405);

    const invalid = await fetchMetadataDocument(oauth, "[bad");
    expect(invalid.status).toBe(400);
  });

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
      offByDefault: false,
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
