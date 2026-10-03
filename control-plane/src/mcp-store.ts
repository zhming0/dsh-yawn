import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

/** How the control plane authenticates to one server. */
export type McpAuth = "none" | "bearer" | "oauth";

export const mcpAuthModes: readonly McpAuth[] = ["none", "bearer", "oauth"];

/**
 * One remote Streamable HTTP MCP server, as the browser edits it. The token
 * never leaves the host. `token` applies to `bearer` only: `null` clears a
 * saved token on upsert; omitting it, or sending an empty string, keeps
 * whatever is saved.
 */
export interface McpServerEntry {
  serverName: string;
  url: string;
  auth: McpAuth;
  token?: string | null;
  enabled: boolean;
}

/**
 * What an OAuth sign-in leaves behind. The client registration is kept so a
 * later sign-in reuses it; it is bound to the redirect URI it was registered
 * with. Nothing here is ever sent to the browser.
 */
export interface McpOAuthCredential {
  redirectUri: string;
  client: StoredOAuthClientInformation;
  tokens: StoredOAuthTokens;
  /** When the access token expires, in epoch milliseconds, if the server said. */
  expiresAt?: number;
}

/** The persisted record: the entry plus the secrets its auth mode uses. */
interface StoredServer {
  serverName: string;
  url: string;
  auth: McpAuth;
  token?: string;
  oauth?: McpOAuthCredential;
  enabled: boolean;
}

interface McpFile {
  version: 1;
  servers: StoredServer[];
}

export interface McpStoreOptions {
  path: string;
  /** Clock for access-token expiry; tests replace it. */
  now?: () => number;
}

const serverNamePattern = /^[A-Za-z0-9_-]{1,32}$/;

/** Reject the fields the mcp-client and the HTTP transport depend on. */
export function validateMcpServerEntry(entry: McpServerEntry): void {
  if (!serverNamePattern.test(entry.serverName)) {
    throw new Error(
      `invalid MCP server name "${entry.serverName}": use 1-32 letters, digits, "_", or "-"`,
    );
  }
  // Tool names are `mcp__<serverName>__<tool>`, and a server is identified by
  // that prefix. A name holding `__` (server `gh__x`) or ending in `_`
  // (server `gh_`) makes one server's prefix match another's tools, which
  // would report a dead server as connected on the strength of a neighbour's
  // tools.
  if (entry.serverName.includes("__")) {
    throw new Error(
      `invalid MCP server name "${entry.serverName}": "__" is reserved for the tool-name prefix`,
    );
  }
  if (entry.serverName.endsWith("_")) {
    throw new Error(
      `invalid MCP server name "${entry.serverName}": a trailing "_" collides with the tool-name prefix`,
    );
  }
  const url = parseUrl(entry.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`MCP server URL must use http or https: ${entry.url}`);
  }
  if (!mcpAuthModes.includes(entry.auth)) {
    throw new Error(`invalid MCP authentication method: ${String(entry.auth)}`);
  }
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`invalid MCP server URL: ${value}`);
  }
}

/** Owner-only durable MCP server configuration, mirroring the credential broker. */
export class McpServerStore {
  private state: McpFile = { version: 1, servers: [] };
  private writeChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: McpStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    await this.refresh();
  }

  /** Pick up edits made outside the running host before the next reconcile. */
  async refresh(): Promise<void> {
    await this.writeChain;
    try {
      this.state = parseMcpFile(
        JSON.parse(await readFile(this.options.path, "utf8")),
      );
    } catch (error) {
      if (isNotFound(error)) {
        this.state = { version: 1, servers: [] };
      } else {
        throw error;
      }
    }
  }

  /** Every entry without its secrets, sorted by name for stable output. */
  list(): McpServerEntry[] {
    return sorted(this.state.servers).map(publicEntry);
  }

  /** One entry without its secrets; undefined when nothing is stored. */
  get(serverName: string): McpServerEntry | undefined {
    const stored = find(this.state.servers, serverName);
    return stored === undefined ? undefined : publicEntry(stored);
  }

  /**
   * The one accessor that returns a secret, for building a request header:
   * the saved bearer token, or an OAuth access token that has not expired.
   */
  tokenFor(serverName: string): string | undefined {
    const stored = find(this.state.servers, serverName);
    switch (stored?.auth) {
      case "bearer":
        return stored.token;
      case "oauth":
        return stored.oauth !== undefined && !this.expired(stored.oauth)
          ? stored.oauth.tokens.access_token
          : undefined;
      default:
        return undefined;
    }
  }

  /** Whether a bearer token is saved; the browser sees only this. */
  hasBearerToken(serverName: string): boolean {
    const stored = find(this.state.servers, serverName);
    return stored?.auth === "bearer" && stored.token !== undefined;
  }

  /** The saved OAuth sign-in, expired or not. */
  oauthFor(serverName: string): McpOAuthCredential | undefined {
    const stored = find(this.state.servers, serverName);
    return stored?.auth === "oauth" ? stored.oauth : undefined;
  }

  /**
   * The OAuth sign-in state the browser may see: none, expired, or valid,
   * with the expiry time when the server gave a lifetime.
   */
  oauthStatus(
    serverName: string,
  ):
    | { kind: "none" }
    | { kind: "expired" }
    | { kind: "valid"; until?: number } {
    const oauth = this.oauthFor(serverName);
    if (oauth === undefined) {
      return { kind: "none" };
    }
    if (this.expired(oauth)) {
      return { kind: "expired" };
    }
    return oauth.expiresAt === undefined
      ? { kind: "valid" }
      : { kind: "valid", until: oauth.expiresAt };
  }

  /**
   * Store one entry. An omitted or empty token keeps the saved token, so the
   * browser can edit a server without ever receiving the value back; `null`
   * clears it, which is the only way to remove one without deleting the server.
   * Secrets that belong to another auth mode are dropped, and so is an OAuth
   * sign-in once the URL changes, because it authorizes the old server.
   */
  async upsert(entry: McpServerEntry): Promise<void> {
    validateMcpServerEntry(entry);
    const previous = find(this.state.servers, entry.serverName);
    const stored: StoredServer = {
      serverName: entry.serverName,
      url: entry.url,
      auth: entry.auth,
      enabled: entry.enabled,
    };
    if (entry.auth === "bearer") {
      const token =
        entry.token === null
          ? undefined
          : entry.token === undefined || entry.token === ""
            ? previous?.auth === "bearer"
              ? previous.token
              : undefined
            : entry.token;
      if (token !== undefined) {
        stored.token = token;
      }
    }
    if (
      entry.auth === "oauth" &&
      previous?.auth === "oauth" &&
      previous.url === entry.url &&
      previous.oauth !== undefined
    ) {
      stored.oauth = previous.oauth;
    }
    this.replace(stored);
    await this.persist();
  }

  /** Save a completed OAuth sign-in for a server that still expects one. */
  async saveOAuth(
    serverName: string,
    url: string,
    oauth: McpOAuthCredential,
  ): Promise<void> {
    await this.refresh();
    const stored = find(this.state.servers, serverName);
    if (stored === undefined || stored.auth !== "oauth" || stored.url !== url) {
      throw new Error(
        `MCP server ${serverName} changed while it was being authorized; connect it again`,
      );
    }
    this.replace({ ...stored, oauth });
    await this.persist();
  }

  async remove(serverName: string): Promise<void> {
    const servers = this.state.servers.filter(
      (candidate) => candidate.serverName !== serverName,
    );
    if (servers.length === this.state.servers.length) {
      return;
    }
    this.state = { version: 1, servers };
    await this.persist();
  }

  private expired(oauth: McpOAuthCredential): boolean {
    return oauth.expiresAt !== undefined && oauth.expiresAt <= this.now();
  }

  private replace(stored: StoredServer): void {
    this.state = {
      version: 1,
      servers: [
        ...this.state.servers.filter(
          (candidate) => candidate.serverName !== stored.serverName,
        ),
        stored,
      ],
    };
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(
      { version: 1, servers: sorted(this.state.servers) },
      null,
      2,
    )}\n`;
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.options.path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.options.path);
    });
    return this.writeChain;
  }
}

function publicEntry(stored: StoredServer): McpServerEntry {
  return {
    serverName: stored.serverName,
    url: stored.url,
    auth: stored.auth,
    enabled: stored.enabled,
  };
}

function find(
  servers: StoredServer[],
  serverName: string,
): StoredServer | undefined {
  return servers.find((entry) => entry.serverName === serverName);
}

function sorted(servers: StoredServer[]): StoredServer[] {
  // Plain code-unit order keeps the file and the API stable across locales.
  return [...servers].sort((left, right) =>
    left.serverName < right.serverName
      ? -1
      : left.serverName > right.serverName
        ? 1
        : 0,
  );
}

function parseMcpFile(value: unknown): McpFile {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("servers" in value) ||
    !Array.isArray(value.servers)
  ) {
    throw new Error("MCP server file has an unsupported format");
  }
  return { version: 1, servers: (value.servers as unknown[]).map(parseEntry) };
}

/** Keep only the known fields so retired ones drop out on the next write. */
function parseEntry(value: unknown): StoredServer {
  if (typeof value !== "object" || value === null) {
    throw unsupported();
  }
  const record = value as Record<string, unknown>;
  const { serverName, url, token, enabled, auth, oauth } = record;
  if (
    typeof serverName !== "string" ||
    typeof url !== "string" ||
    (token !== undefined && token !== null && typeof token !== "string") ||
    (enabled !== undefined && typeof enabled !== "boolean") ||
    (auth !== undefined && !mcpAuthModes.includes(auth as McpAuth))
  ) {
    throw unsupported();
  }
  // A hand-edited `null` reads as no token, the same as omitting it.
  const savedToken = typeof token === "string" ? token : undefined;
  // Files written before auth modes existed: a saved token meant bearer.
  const mode: McpAuth =
    (auth as McpAuth | undefined) ??
    (savedToken === undefined ? "none" : "bearer");
  const entry: StoredServer = {
    serverName,
    url,
    auth: mode,
    enabled: enabled ?? true,
  };
  if (mode === "bearer" && savedToken !== undefined) {
    entry.token = savedToken;
  }
  if (mode === "oauth" && oauth !== undefined && oauth !== null) {
    entry.oauth = parseOAuth(oauth);
  }
  return entry;
}

function parseOAuth(value: unknown): McpOAuthCredential {
  if (typeof value !== "object" || value === null) {
    throw unsupported();
  }
  const { redirectUri, client, tokens, expiresAt } = value as Record<
    string,
    unknown
  >;
  if (
    typeof redirectUri !== "string" ||
    typeof client !== "object" ||
    client === null ||
    typeof (client as Record<string, unknown>).client_id !== "string" ||
    typeof tokens !== "object" ||
    tokens === null ||
    typeof (tokens as Record<string, unknown>).access_token !== "string" ||
    (expiresAt !== undefined && typeof expiresAt !== "number")
  ) {
    throw unsupported();
  }
  const credential: McpOAuthCredential = {
    redirectUri,
    client: client as StoredOAuthClientInformation,
    tokens: tokens as StoredOAuthTokens,
  };
  return expiresAt === undefined ? credential : { ...credential, expiresAt };
}

function unsupported(): Error {
  return new Error("MCP server file has an unsupported format");
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
