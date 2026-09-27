import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { workspaceKey } from "./broker.js";

/**
 * One remote Streamable HTTP MCP server. The token never leaves the host.
 * `token: null` clears a saved token on upsert; omitting it, or sending an
 * empty string, keeps whatever is saved.
 */
export interface McpServerEntry {
  serverName: string;
  url: string;
  token?: string | null;
  enabled: boolean;
}

/**
 * Where one entry is configured. The global scope reaches every session; a
 * workspace scope reaches that workspace's sessions. A workspace adds servers
 * of its own — it cannot disable or override a global one.
 */
export type McpScope =
  | { kind: "global" }
  | { kind: "workspace"; repositoryUrl: string };

export const GLOBAL_MCP_SCOPE: McpScope = { kind: "global" };

/** One stored entry together with the scope it was written to. */
export interface ScopedMcpEntry {
  entry: McpServerEntry;
  scope: McpScope;
}

interface McpFile {
  version: 2;
  /** The global scope's entries. */
  servers: McpServerEntry[];
  /** Per-workspace entries, keyed by repository URL. */
  workspaces: Record<string, McpServerEntry[]>;
}

export interface McpStoreOptions {
  path: string;
}

const serverNamePattern = /^[A-Za-z0-9_-]{1,32}$/;

/** Reject the two fields the mcp-client and the HTTP transport both depend on. */
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
  private state: McpFile = {
    version: 2,
    servers: [],
    workspaces: {},
  };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: McpStoreOptions) {}

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
        this.state = { version: 2, servers: [], workspaces: {} };
      } else {
        throw error;
      }
    }
  }

  /** Every entry without its token, in every scope, global scope first. */
  entries(): ScopedMcpEntry[] {
    return [
      ...sorted(this.state.servers).map((entry) => ({
        entry: withoutToken(entry),
        scope: GLOBAL_MCP_SCOPE,
      })),
      ...Object.keys(this.workspacesSorted()).flatMap((repositoryUrl) =>
        sorted(this.state.workspaces[repositoryUrl] ?? []).map((entry) => ({
          entry: withoutToken(entry),
          scope: { kind: "workspace" as const, repositoryUrl },
        })),
      ),
    ];
  }

  /** One scope's entries without their tokens, sorted by name. */
  list(scope: McpScope): McpServerEntry[] {
    return this.stored(scope)
      .map((entry) => withoutToken(entry))
      .sort(compareByName);
  }

  /** One entry without its token, searched across scopes; undefined when absent. */
  get(serverName: string): McpServerEntry | undefined {
    const entry = this.entries().find(
      ({ entry }) => entry.serverName === serverName,
    )?.entry;
    return entry === undefined ? undefined : { ...entry };
  }

  /** The one accessor that returns a token, for building a request header. */
  tokenFor(serverName: string): string | undefined {
    const token = [
      ...this.state.servers,
      ...Object.values(this.state.workspaces).flat(),
    ].find((candidate) => candidate.serverName === serverName)?.token;
    return token ?? undefined;
  }

  /**
   * Store one entry in a scope. An omitted or empty token keeps the saved
   * token, so the browser can edit a server without ever receiving the value
   * back; `null` clears it, which is the only way to remove one without
   * deleting the server.
   *
   * A server name is taken by exactly one scope. A global server's tools sit
   * in every agent's view, so a workspace server of the same name would
   * collide with them there, and the status rows, retry, and token lookup are
   * all keyed by name.
   */
  async upsert(scope: McpScope, entry: McpServerEntry): Promise<void> {
    validateMcpServerEntry(entry);
    const conflict = this.entries().find(
      ({ entry: stored, scope: storedScope }) =>
        stored.serverName === entry.serverName &&
        !sameScope(storedScope, scope),
    );
    if (conflict !== undefined) {
      throw new Error(
        `MCP server name "${entry.serverName}" already exists in ${describeScope(conflict.scope)}; server names are shared by every scope`,
      );
    }
    const kept = entry.token === undefined || entry.token === "";
    const token =
      entry.token === null
        ? undefined
        : kept
          ? this.tokenFor(entry.serverName)
          : entry.token;
    const stored: McpServerEntry =
      token === undefined
        ? {
            serverName: entry.serverName,
            url: entry.url,
            enabled: entry.enabled,
          }
        : {
            serverName: entry.serverName,
            url: entry.url,
            token,
            enabled: entry.enabled,
          };
    if (scope.kind === "global") {
      this.state = {
        ...this.state,
        servers: [
          ...this.state.servers.filter(
            (candidate) => candidate.serverName !== entry.serverName,
          ),
          stored,
        ],
      };
    } else {
      const current = this.state.workspaces[scope.repositoryUrl] ?? [];
      const next = [
        ...current.filter(
          (candidate) => candidate.serverName !== entry.serverName,
        ),
        stored,
      ];
      this.state = {
        ...this.state,
        workspaces: { ...this.state.workspaces, [scope.repositoryUrl]: next },
      };
    }
    await this.persist();
  }

  async remove(scope: McpScope, serverName: string): Promise<void> {
    if (scope.kind === "global") {
      const servers = this.state.servers.filter(
        (candidate) => candidate.serverName !== serverName,
      );
      if (servers.length === this.state.servers.length) {
        return;
      }
      this.state = { ...this.state, servers };
    } else {
      const current = this.state.workspaces[scope.repositoryUrl];
      if (current === undefined) {
        return;
      }
      const next = current.filter(
        (candidate) => candidate.serverName !== serverName,
      );
      if (next.length === current.length) {
        return;
      }
      const workspaces = { ...this.state.workspaces };
      if (next.length === 0) {
        delete workspaces[scope.repositoryUrl];
      } else {
        workspaces[scope.repositoryUrl] = next;
      }
      this.state = { ...this.state, workspaces };
    }
    await this.persist();
  }

  /**
   * The stored records of one scope; the caller must not mutate them. A
   * session's repository can be spelled as a clone URL (a `.git` suffix, a
   * trailing slash), so the lookup matches the way secrets do.
   */
  private stored(scope: McpScope): McpServerEntry[] {
    if (scope.kind === "global") {
      return this.state.servers;
    }
    const key = workspaceKey(scope.repositoryUrl);
    return (
      Object.entries(this.state.workspaces).find(
        ([repositoryUrl]) => workspaceKey(repositoryUrl) === key,
      )?.[1] ?? []
    );
  }

  /** Workspace keys in plain code-unit order, for stable output. */
  private workspacesSorted(): Record<string, McpServerEntry[]> {
    return Object.fromEntries(
      Object.keys(this.state.workspaces)
        .sort()
        .map((repositoryUrl) => [
          repositoryUrl,
          this.state.workspaces[repositoryUrl] ?? [],
        ]),
    );
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(
      {
        version: 2,
        servers: sorted(this.state.servers),
        workspaces: Object.fromEntries(
          Object.entries(this.workspacesSorted()).map(([url, entries]) => [
            url,
            sorted(entries),
          ]),
        ),
      },
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

function withoutToken(entry: McpServerEntry): McpServerEntry {
  return {
    serverName: entry.serverName,
    url: entry.url,
    enabled: entry.enabled,
  };
}

function sameScope(left: McpScope, right: McpScope): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "global" ||
      left.repositoryUrl ===
        (right as { repositoryUrl?: string }).repositoryUrl)
  );
}

function describeScope(scope: McpScope): string {
  return scope.kind === "global"
    ? "the global scope"
    : `the workspace ${scope.repositoryUrl}`;
}

function compareByName(left: McpServerEntry, right: McpServerEntry): number {
  return left.serverName < right.serverName
    ? -1
    : left.serverName > right.serverName
      ? 1
      : 0;
}

function sorted(servers: McpServerEntry[]): McpServerEntry[] {
  // Plain code-unit order keeps the file and the API stable across locales.
  return [...servers].sort(compareByName);
}

/** Version 2 is the only format; no deployed install reads the old one. */
function parseMcpFile(value: unknown): McpFile {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 2 ||
    !("servers" in value) ||
    !Array.isArray(value.servers) ||
    !("workspaces" in value) ||
    typeof value.workspaces !== "object" ||
    value.workspaces === null ||
    Array.isArray(value.workspaces) ||
    Object.entries(value.workspaces).some(
      ([, entries]) => !Array.isArray(entries),
    )
  ) {
    throw new Error("MCP server file has an unsupported format");
  }
  const servers = (value.servers as unknown[]).map(parseEntry);
  const workspaces: Record<string, McpServerEntry[]> = {};
  for (const [repositoryUrl, entries] of Object.entries(
    value.workspaces as Record<string, unknown[]>,
  )) {
    workspaces[repositoryUrl] = entries.map(parseEntry);
  }
  return { version: 2, servers, workspaces };
}

/** Keep only the known fields so retired ones drop out on the next write. */
function parseEntry(value: unknown): McpServerEntry {
  if (typeof value !== "object" || value === null) {
    throw new Error("MCP server file has an unsupported format");
  }
  const record = value as Record<string, unknown>;
  const { serverName, url, token, enabled } = record;
  if (
    typeof serverName !== "string" ||
    typeof url !== "string" ||
    (token !== undefined && token !== null && typeof token !== "string") ||
    (enabled !== undefined && typeof enabled !== "boolean")
  ) {
    throw new Error("MCP server file has an unsupported format");
  }
  const entry: McpServerEntry = { serverName, url, enabled: enabled ?? true };
  // A hand-edited `null` reads as no token, the same as omitting it.
  return token === undefined || token === null ? entry : { ...entry, token };
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
