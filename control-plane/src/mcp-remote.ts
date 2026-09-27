import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

import type { McpServerEntry } from "./mcp-store.js";

export type McpServerStatus = "connected" | "starting" | "error" | "disabled";

/** Read-only browser view of one configured server. Never carries the token. */
export interface McpServerView {
  serverName: string;
  url: string;
  enabled: boolean;
  hasToken: boolean;
  /** Where the entry is configured: `global` reaches every session. */
  scope: "global" | "workspace";
  /** The workspace a `workspace`-scoped entry belongs to. */
  repositoryUrl?: string;
  status: McpServerStatus;
  toolCount: number;
  error?: string;
}

export interface McpTestResult {
  ok: boolean;
  toolCount: number;
  error?: string;
}

/** The workspaces the page's scope selector offers. */
export interface McpWorkspaceView {
  repositoryUrl: string;
  title: string;
}

/** The MCP page's read model: every server in every scope, plus the scopes. */
export interface McpSettingsView {
  servers: McpServerView[];
  workspaces: McpWorkspaceView[];
}

/**
 * Browser CRUD surface for remote MCP servers. Tokens flow browser→host only;
 * every method answers with the updated view, never a token.
 * The namespace map declaration lives in remote-contributions.ts.
 */
export interface SandboxMcpRemote {
  listMcpServers(): Promise<RemoteResult<McpSettingsView>>;
  setGlobalMcpServer(
    entry: McpServerEntry,
  ): Promise<RemoteResult<McpSettingsView>>;
  setWorkspaceMcpServer(
    repositoryUrl: string,
    entry: McpServerEntry,
  ): Promise<RemoteResult<McpSettingsView>>;
  deleteGlobalMcpServer(
    serverName: string,
  ): Promise<RemoteResult<McpSettingsView>>;
  deleteWorkspaceMcpServer(
    repositoryUrl: string,
    serverName: string,
  ): Promise<RemoteResult<McpSettingsView>>;
  retryMcpServer(serverName: string): Promise<RemoteResult<McpSettingsView>>;
  testMcpServer(entry: McpServerEntry): Promise<RemoteResult<McpTestResult>>;
}

const stringSchema: TypertSchema<string> = {
  parse(value: unknown): string {
    if (typeof value !== "string") {
      throw new TypeError("expected a string");
    }
    return value;
  },
};

const entrySchema: TypertSchema<McpServerEntry> = {
  parse(value: unknown): McpServerEntry {
    if (typeof value !== "object" || value === null) {
      throw new TypeError("expected an MCP server entry");
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!["serverName", "url", "token", "enabled"].includes(key)) {
        throw new TypeError(`unexpected MCP server entry field: ${key}`);
      }
    }
    if (typeof record.serverName !== "string") {
      throw new TypeError(
        "expected an MCP server entry with a string serverName",
      );
    }
    if (typeof record.url !== "string") {
      throw new TypeError("expected an MCP server entry with a string url");
    }
    if (
      record.token !== undefined &&
      record.token !== null &&
      typeof record.token !== "string"
    ) {
      throw new TypeError(
        "expected an MCP server entry with a string or null token",
      );
    }
    if (typeof record.enabled !== "boolean") {
      throw new TypeError(
        "expected an MCP server entry with a boolean enabled",
      );
    }
    const entry: McpServerEntry = {
      serverName: record.serverName,
      url: record.url,
      enabled: record.enabled,
    };
    // `null` clears a saved token; omitting it keeps one.
    return record.token === undefined
      ? entry
      : { ...entry, token: record.token };
  },
};

const statuses: readonly McpServerStatus[] = [
  "connected",
  "starting",
  "error",
  "disabled",
];

const viewSchema: TypertSchema<McpServerView> = {
  parse(value: unknown): McpServerView {
    if (typeof value !== "object" || value === null) {
      throw new TypeError("expected an MCP server view");
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.serverName !== "string" ||
      typeof record.url !== "string" ||
      typeof record.enabled !== "boolean" ||
      typeof record.hasToken !== "boolean" ||
      (record.scope !== "global" && record.scope !== "workspace") ||
      (record.repositoryUrl !== undefined &&
        typeof record.repositoryUrl !== "string") ||
      !statuses.includes(record.status as McpServerStatus) ||
      typeof record.toolCount !== "number" ||
      (record.error !== undefined && typeof record.error !== "string")
    ) {
      throw new TypeError("expected an MCP server view");
    }
    if (record.scope === "workspace" && record.repositoryUrl === undefined) {
      throw new TypeError(
        "expected a workspace-scoped MCP server view to carry a repositoryUrl",
      );
    }
    return value as McpServerView;
  },
};

const settingsSchema: TypertSchema<McpSettingsView> = {
  parse(value: unknown): McpSettingsView {
    if (
      typeof value !== "object" ||
      value === null ||
      !("servers" in value) ||
      !Array.isArray(value.servers) ||
      value.servers.some((entry) => viewSchema.parse(entry) === undefined) ||
      !("workspaces" in value) ||
      !Array.isArray(value.workspaces) ||
      // Array.isArray narrows to any[]; widen so the entry checks stay typed.
      (value.workspaces as unknown[]).some(
        (entry) =>
          typeof entry !== "object" ||
          entry === null ||
          !("repositoryUrl" in entry) ||
          typeof entry.repositoryUrl !== "string" ||
          !("title" in entry) ||
          typeof entry.title !== "string",
      )
    ) {
      throw new TypeError("expected an MCP settings view");
    }
    return value as McpSettingsView;
  },
};

const testResultSchema: TypertSchema<McpTestResult> = {
  parse(value: unknown): McpTestResult {
    if (typeof value !== "object" || value === null) {
      throw new TypeError("expected an MCP test result");
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.ok !== "boolean" ||
      typeof record.toolCount !== "number" ||
      (record.error !== undefined && typeof record.error !== "string")
    ) {
      throw new TypeError("expected an MCP test result");
    }
    return value as McpTestResult;
  },
};

function describe(
  method: string,
  parameters: Array<{ name: string; schema: TypertSchema }>,
  result: TypertSchema,
): InvocationDescriptor {
  const id = `@zhming0/dsh-yawn#sandboxManager/${method}`;
  return {
    id,
    service: "sandboxManager",
    namespace: "sandboxManager",
    method,
    invocation: { kind: "direct" },
    parameters: parameters.map(({ name, schema }) => ({
      name,
      wire: name,
      source: "json",
      codec: {
        mode: "strict",
        typeSymbol: `${id}:${name}`,
        create: () => schema,
      },
    })),
    result: {
      mode: "strict",
      typeSymbol: `${id}:result`,
      create: () => result,
    },
  };
}

export const sandboxMcpDescriptors: InvocationDescriptor[] = [
  describe("listMcpServers", [], settingsSchema),
  describe(
    "setGlobalMcpServer",
    [{ name: "entry", schema: entrySchema }],
    settingsSchema,
  ),
  describe(
    "setWorkspaceMcpServer",
    [
      { name: "repositoryUrl", schema: stringSchema },
      { name: "entry", schema: entrySchema },
    ],
    settingsSchema,
  ),
  describe(
    "deleteGlobalMcpServer",
    [{ name: "serverName", schema: stringSchema }],
    settingsSchema,
  ),
  describe(
    "deleteWorkspaceMcpServer",
    [
      { name: "repositoryUrl", schema: stringSchema },
      { name: "serverName", schema: stringSchema },
    ],
    settingsSchema,
  ),
  describe(
    "retryMcpServer",
    [{ name: "serverName", schema: stringSchema }],
    settingsSchema,
  ),
  describe(
    "testMcpServer",
    [{ name: "entry", schema: entrySchema }],
    testResultSchema,
  ),
];
