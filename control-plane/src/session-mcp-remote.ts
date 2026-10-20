import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

import type { McpServerStatus } from "./mcp-remote.js";

/** One enabled server as the New Session row's MCP menu lists it. */
export interface SessionMcpServer {
  serverName: string;
  status: McpServerStatus;
  toolCount: number;
}

export interface SessionMcpView {
  /** Servers enabled on the MCP settings page, in their saved order. */
  servers: SessionMcpServer[];
  /** The listed servers this session turned off. */
  disabled: string[];
  /** True once the session has sent a prompt; the choice can no longer change. */
  locked: boolean;
}

/** The namespace map declaration lives in remote-contributions.ts. */
export interface SessionMcpRemote {
  getSessionMcp(sessionId: string): Promise<RemoteResult<SessionMcpView>>;
  setSessionMcp(
    sessionId: string,
    disabled: string[],
  ): Promise<RemoteResult<SessionMcpView>>;
}

const stringSchema: TypertSchema<string> = {
  parse(value: unknown): string {
    if (typeof value !== "string") {
      throw new TypeError("expected a string");
    }
    return value;
  },
};

const stringsSchema: TypertSchema<string[]> = {
  parse(value: unknown): string[] {
    if (
      !Array.isArray(value) ||
      value.some((entry: unknown) => typeof entry !== "string")
    ) {
      throw new TypeError("expected an array of strings");
    }
    return value as string[];
  },
};

const statuses: readonly McpServerStatus[] = [
  "connected",
  "starting",
  "error",
  "disabled",
  "needs-auth",
];

const viewSchema: TypertSchema<SessionMcpView> = {
  parse(value: unknown): SessionMcpView {
    if (
      typeof value !== "object" ||
      value === null ||
      !("servers" in value) ||
      !Array.isArray(value.servers) ||
      value.servers.some(
        (entry: unknown) =>
          typeof entry !== "object" ||
          entry === null ||
          !("serverName" in entry) ||
          typeof entry.serverName !== "string" ||
          !("status" in entry) ||
          !statuses.includes(entry.status as McpServerStatus) ||
          !("toolCount" in entry) ||
          typeof entry.toolCount !== "number",
      ) ||
      !("disabled" in value) ||
      !Array.isArray(value.disabled) ||
      value.disabled.some((entry: unknown) => typeof entry !== "string") ||
      !("locked" in value) ||
      typeof value.locked !== "boolean"
    ) {
      throw new TypeError("expected a session MCP view");
    }
    return value as SessionMcpView;
  },
};

function describe(
  method: string,
  parameters: Array<{ name: string; schema: TypertSchema }>,
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
      create: () => viewSchema,
    },
  };
}

export const sessionMcpDescriptors: InvocationDescriptor[] = [
  describe("getSessionMcp", [{ name: "sessionId", schema: stringSchema }]),
  describe("setSessionMcp", [
    { name: "sessionId", schema: stringSchema },
    { name: "disabled", schema: stringsSchema },
  ]),
];
