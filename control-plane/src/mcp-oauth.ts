import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

import type { McpServerStore } from "./mcp-store.js";

/**
 * Where the authorization server sends the browser back. It is a plain
 * webserver route outside `/api`: the return trip is a cross-site navigation,
 * which dsh's `/api` fence refuses and which carries no `SameSite=Strict`
 * session cookie. The single-use `state` the control plane issued to an
 * authenticated Settings page is what ties the request to a sign-in.
 */
export const MCP_OAUTH_CALLBACK_PATH = "/dsh-yawn/mcp/oauth/callback";

/** A sign-in that is not finished by then is forgotten. */
const pendingLifetimeMs = 10 * 60_000;

/** One sign-in between the redirect to the authorization server and its return. */
interface PendingSignIn {
  serverName: string;
  url: string;
  redirectUri: string;
  createdAt: number;
  client?: StoredOAuthClientInformation;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
  tokens?: StoredOAuthTokens;
}

export interface McpOAuthOptions {
  store: McpServerStore;
  /** Runs after a sign-in is saved, so the server is mounted with its token. */
  authorized: (serverName: string) => Promise<void>;
}

/**
 * The OAuth authorization code flow (with PKCE) for remote MCP servers, run
 * by the control plane: discovery, dynamic client registration, and the code
 * exchange go through the MCP SDK's `auth()`. Only the authorization URL ever
 * reaches the browser. Tokens are not refreshed: once the access token
 * expires, the server waits for the operator to sign in again.
 */
export class McpOAuth {
  private readonly store: McpServerStore;
  private readonly authorized: (serverName: string) => Promise<void>;
  /** Keyed by the `state` parameter. */
  private readonly pending = new Map<string, PendingSignIn>();

  constructor(options: McpOAuthOptions) {
    this.store = options.store;
    this.authorized = options.authorized;
  }

  /**
   * Begin a sign-in for one saved server and answer the URL the browser
   * should open. `origin` is the Settings page's own origin, the one the
   * browser can reach the control plane on.
   */
  async start(serverName: string, origin: string): Promise<string> {
    await this.store.refresh();
    const entry = this.store.get(serverName);
    if (entry === undefined) {
      throw new Error(`unknown MCP server: ${serverName}`);
    }
    if (entry.auth !== "oauth") {
      throw new Error(`MCP server ${serverName} does not use OAuth`);
    }
    this.forgetExpired();
    const redirectUri = callbackUrl(origin);
    const saved = this.store.oauthFor(serverName);
    const signIn: PendingSignIn = {
      serverName,
      url: entry.url,
      redirectUri,
      createdAt: Date.now(),
    };
    // A registration is bound to its redirect URI; reach the control plane on
    // another address and the client registers again.
    if (saved?.redirectUri === redirectUri) {
      signIn.client = saved.client;
    }
    const state = randomBytes(32).toString("base64url");
    let authorizationUrl: URL | undefined;
    const result = await auth(
      this.provider(signIn, state, (url) => {
        authorizationUrl = url;
      }),
      { serverUrl: entry.url },
    );
    if (result !== "REDIRECT" || authorizationUrl === undefined) {
      throw new Error(
        `MCP server ${serverName} did not ask for a browser sign-in`,
      );
    }
    this.pending.set(state, signIn);
    return authorizationUrl.href;
  }

  /**
   * Finish the sign-in the callback query names; answers the server's name.
   * Every failure throws an error whose message is fit for the browser.
   */
  async finish(query: URLSearchParams): Promise<string> {
    const state = query.get("state");
    const signIn = state === null ? undefined : this.pending.get(state);
    if (
      state === null ||
      signIn === undefined ||
      Date.now() - signIn.createdAt > pendingLifetimeMs
    ) {
      throw new Error(
        "This sign-in is unknown or has expired. Start it again from Settings → MCP.",
      );
    }
    this.pending.delete(state);
    const refused = query.get("error");
    if (refused !== null) {
      throw new Error(
        `The authorization server refused the sign-in: ${query.get("error_description") ?? refused}`,
      );
    }
    const code = query.get("code");
    if (code === null) {
      throw new Error("The authorization server returned no code.");
    }
    const iss = query.get("iss");
    const result = await auth(
      this.provider(signIn, state, () => {
        throw new Error("the authorization server asked for a second sign-in");
      }),
      {
        serverUrl: signIn.url,
        authorizationCode: code,
        ...(iss === null ? {} : { iss }),
      },
    );
    if (
      result !== "AUTHORIZED" ||
      signIn.tokens === undefined ||
      signIn.client === undefined
    ) {
      throw new Error("The authorization server returned no access token.");
    }
    // Nothing refreshes, so a refresh token would be a long-lived credential
    // with no reader; it is not kept.
    const { refresh_token: _refreshToken, ...tokens } = signIn.tokens;
    const lifetime = tokens.expires_in;
    await this.store.saveOAuth(signIn.serverName, signIn.url, {
      redirectUri: signIn.redirectUri,
      client: signIn.client,
      tokens,
      ...(typeof lifetime === "number"
        ? { expiresAt: Date.now() + lifetime * 1000 }
        : {}),
    });
    await this.authorized(signIn.serverName);
    return signIn.serverName;
  }

  /** The webserver handler for {@link MCP_OAUTH_CALLBACK_PATH}. */
  async handleCallback(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }
    const query = new URL(request.url ?? "/", "http://callback.invalid")
      .searchParams;
    try {
      const serverName = await this.finish(query);
      sendPage(
        response,
        200,
        `${serverName} is connected`,
        "You can close this tab and return to Settings → MCP.",
        true,
      );
    } catch (reason) {
      sendPage(response, 400, "Sign-in failed", describe(reason), false);
    }
  }

  private provider(
    signIn: PendingSignIn,
    state: string,
    redirect: (url: URL) => void,
  ): OAuthClientProvider {
    return {
      redirectUrl: signIn.redirectUri,
      clientMetadata: {
        client_name: "DeepSeek Harness",
        redirect_uris: [signIn.redirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
      state: () => state,
      clientInformation: () => signIn.client,
      saveClientInformation: (client) => {
        signIn.client = client;
      },
      // A sign-in starts with no tokens, so the SDK never tries a refresh.
      tokens: () => signIn.tokens,
      saveTokens: (tokens) => {
        signIn.tokens = tokens;
      },
      redirectToAuthorization: redirect,
      saveCodeVerifier: (verifier) => {
        signIn.codeVerifier = verifier;
      },
      codeVerifier: () => {
        if (signIn.codeVerifier === undefined) {
          throw new Error("no PKCE code verifier was saved for this sign-in");
        }
        return signIn.codeVerifier;
      },
      saveDiscoveryState: (discovery) => {
        signIn.discovery = discovery;
      },
      discoveryState: () => signIn.discovery,
    };
  }

  private forgetExpired(): void {
    for (const [state, signIn] of this.pending) {
      if (Date.now() - signIn.createdAt > pendingLifetimeMs) {
        this.pending.delete(state);
      }
    }
  }
}

/** The callback URL on the origin the browser used for Settings. */
export function callbackUrl(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`invalid control-plane origin: ${origin}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`invalid control-plane origin: ${origin}`);
  }
  return new URL(MCP_OAUTH_CALLBACK_PATH, url.origin).href;
}

function sendPage(
  response: ServerResponse,
  status: number,
  title: string,
  message: string,
  close: boolean,
): void {
  // The page is opened by Settings with `window.open`, so it may close itself.
  const script = close ? "<script>window.close()</script>" : "";
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  });
  response.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem}</style>` +
      `</head><body><h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${script}</body></html>`,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
