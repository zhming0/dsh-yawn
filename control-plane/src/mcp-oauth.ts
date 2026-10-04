import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  auth,
  type OAuthClientMetadata,
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

/**
 * An access token is renewed this long before it expires, or halfway through
 * its lifetime when that is shorter. Renewing remounts the server, so it is
 * left late.
 */
const renewalMarginMs = 10 * 60_000;

/** After a failed renewal, wait this long, doubling per failure up to the cap. */
const renewalRetryMs = 60_000;
const renewalRetryCapMs = 30 * 60_000;

/** One request to the authorization server during a renewal may take this long. */
const renewalRequestTimeoutMs = 30_000;

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
  warn: (message: string) => void;
  /** Clock for token expiry and renewal retries; tests replace it. */
  now?: () => number;
}

/** A renewal that failed, and when to try it again. */
interface RenewalFailure {
  attempts: number;
  retryAt: number;
}

/**
 * The OAuth authorization code flow (with PKCE) for remote MCP servers, run
 * by the control plane: discovery, dynamic client registration, and the code
 * exchange go through the MCP SDK's `auth()`. Only the authorization URL ever
 * reaches the browser. When the server issues a refresh token,
 * {@link renewDue} uses it to replace the access token shortly before it
 * expires; without one, the server waits for the operator to sign in again.
 */
export class McpOAuth {
  private readonly store: McpServerStore;
  private readonly authorized: (serverName: string) => Promise<void>;
  private readonly warn: (message: string) => void;
  private readonly now: () => number;
  /** Keyed by the `state` parameter. */
  private readonly pending = new Map<string, PendingSignIn>();
  /** Keyed by server name; dropped once the server is not due. */
  private readonly failures = new Map<string, RenewalFailure>();
  private renewing: Promise<void> | undefined;

  constructor(options: McpOAuthOptions) {
    this.store = options.store;
    this.authorized = options.authorized;
    this.warn = options.warn;
    this.now = options.now ?? Date.now;
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
      createdAt: this.now(),
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
      this.now() - signIn.createdAt > pendingLifetimeMs
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
    await this.store.saveOAuth(signIn.serverName, signIn.url, {
      redirectUri: signIn.redirectUri,
      client: signIn.client,
      tokens: signIn.tokens,
      ...this.expiry(signIn.tokens),
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

  /**
   * Renew every saved sign-in whose access token is about to expire. Never
   * rejects; a failure is logged and retried later with a growing delay. The
   * caller remounts afterwards, since a renewed token is a new header.
   */
  renewDue(): Promise<void> {
    this.renewing ??= this.renewAll().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  private async renewAll(): Promise<void> {
    try {
      await this.store.refresh();
    } catch (reason) {
      this.warn(
        `MCP OAuth renewal could not read the servers: ${describe(reason)}`,
      );
      return;
    }
    for (const entry of this.store.list()) {
      if (!this.renewalDue(entry.serverName)) {
        this.failures.delete(entry.serverName);
        continue;
      }
      const failure = this.failures.get(entry.serverName);
      if (failure !== undefined && failure.retryAt > this.now()) {
        continue;
      }
      try {
        await this.renew(entry.serverName);
        this.failures.delete(entry.serverName);
      } catch (reason) {
        const attempts = (failure?.attempts ?? 0) + 1;
        this.failures.set(entry.serverName, {
          attempts,
          retryAt:
            this.now() +
            Math.min(renewalRetryMs * 2 ** (attempts - 1), renewalRetryCapMs),
        });
        this.warn(
          `MCP server ${entry.serverName} could not renew its OAuth access token: ${describe(reason)}`,
        );
      }
    }
  }

  /**
   * Whether the saved sign-in has a refresh token and an access token close
   * enough to expiry, or past it, to renew now.
   */
  private renewalDue(serverName: string): boolean {
    const oauth = this.store.oauthFor(serverName);
    if (
      oauth?.tokens.refresh_token === undefined ||
      oauth.expiresAt === undefined
    ) {
      return false;
    }
    const lifetimeMs = (oauth.tokens.expires_in ?? 0) * 1000;
    const margin = Math.min(renewalMarginMs, lifetimeMs / 2);
    return this.now() >= oauth.expiresAt - margin;
  }

  /**
   * One refresh grant through `auth()`, which also checks that the
   * authorization server is still the one the sign-in used. A refused
   * refresh token ends the renewals: the access token is kept until it
   * expires, and then the server waits for a sign-in. A refused client
   * removes the sign-in, so the next one registers a new client.
   */
  private async renew(serverName: string): Promise<void> {
    const entry = this.store.get(serverName);
    const saved = this.store.oauthFor(serverName);
    const refreshToken = saved?.tokens.refresh_token;
    if (
      entry === undefined ||
      saved === undefined ||
      refreshToken === undefined
    ) {
      return;
    }
    let client: StoredOAuthClientInformation | undefined = saved.client;
    let tokens: StoredOAuthTokens | undefined = saved.tokens;
    let refused = false;
    const provider: OAuthClientProvider = {
      redirectUrl: saved.redirectUri,
      clientMetadata: clientMetadata(saved.redirectUri),
      clientInformation: () => client,
      // No saveClientInformation: without it the SDK cannot register a new
      // client, which is a sign-in's job, not a renewal's.
      tokens: () => tokens,
      saveTokens: (renewed) => {
        tokens = renewed;
      },
      // The SDK calls this when the authorization server refuses the refresh
      // token or the client, then retries once and falls back to a browser
      // sign-in: a REDIRECT for refused tokens, a throw for a refused client
      // (it cannot register another).
      invalidateCredentials: (scope) => {
        if (scope === "all" || scope === "client") {
          client = undefined;
        }
        if (scope === "all" || scope === "client" || scope === "tokens") {
          refused = true;
          tokens = undefined;
        }
      },
      redirectToAuthorization: () => {},
      saveCodeVerifier: () => {},
      codeVerifier: () => {
        throw new Error("a renewal has no PKCE code verifier");
      },
    };
    let result: Awaited<ReturnType<typeof auth>> | undefined;
    try {
      result = await auth(provider, {
        serverUrl: entry.url,
        // A stalled authorization server must not hold up the other
        // servers' renewals, nor the reconcile that follows them.
        fetchFn: (url, init) => {
          const timeout = AbortSignal.timeout(renewalRequestTimeoutMs);
          return fetch(url, {
            ...init,
            signal:
              init?.signal === undefined || init.signal === null
                ? timeout
                : AbortSignal.any([init.signal, timeout]),
          });
        },
      });
    } catch (reason) {
      if (!refused) {
        throw reason;
      }
    }
    if (refused) {
      const { refresh_token: _refused, ...kept } = saved.tokens;
      await this.store.replaceOAuth(
        serverName,
        refreshToken,
        client === undefined ? undefined : { ...saved, tokens: kept },
      );
      throw new Error(
        client === undefined
          ? "the authorization server refused the client; sign in again"
          : "the authorization server refused the refresh token; sign in again",
      );
    }
    // Anything but AUTHORIZED means the refresh grant failed and the SDK fell
    // back to starting a browser sign-in, which nobody will open.
    if (result !== "AUTHORIZED" || tokens === undefined) {
      throw new Error(
        "the authorization server did not renew the access token",
      );
    }
    // Skipped when the operator signed in again meanwhile; that sign-in wins.
    const { expiresAt: _previous, ...credential } = saved;
    await this.store.replaceOAuth(serverName, refreshToken, {
      ...credential,
      tokens,
      ...this.expiry(tokens),
    });
  }

  /** When an access token expires, if the server gave its lifetime. */
  private expiry(tokens: StoredOAuthTokens): { expiresAt?: number } {
    return typeof tokens.expires_in === "number"
      ? { expiresAt: this.now() + tokens.expires_in * 1000 }
      : {};
  }

  private provider(
    signIn: PendingSignIn,
    state: string,
    redirect: (url: URL) => void,
  ): OAuthClientProvider {
    return {
      redirectUrl: signIn.redirectUri,
      clientMetadata: clientMetadata(signIn.redirectUri),
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
      if (this.now() - signIn.createdAt > pendingLifetimeMs) {
        this.pending.delete(state);
      }
    }
  }
}

/** What dynamic client registration asks for. */
function clientMetadata(redirectUri: string): OAuthClientMetadata {
  return {
    client_name: "DeepSeek Harness",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
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
