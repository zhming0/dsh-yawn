import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import McpResourceRuntime from "@deepseek-ai/dsh-mcp-resources";
import { createScope, type Scope } from "@deepseek-ai/dsh-scope";
import systemPrompt from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpPool } from "../src/mcp-pool.js";
import { GLOBAL_MCP_SCOPE, McpServerStore } from "../src/mcp-store.js";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";

/**
 * End-to-end coverage with the real `@deepseek-ai/dsh-mcp-client`: a local
 * Streamable HTTP server, the real dynamic mount, and the real tools registry
 * shape. The unit tests cover the reconcile logic with a fake mount; this one
 * proves the seam between them actually connects and publishes tools.
 */
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

function toWebRequest(req: IncomingMessage, body: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    }
  }
  const init: RequestInit = { method: req.method ?? "POST", headers };
  if (body !== "") {
    init.body = body;
  }
  return new Request(`http://127.0.0.1${req.url ?? "/"}`, init);
}

async function startMcpServer(name = "drink"): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      // A stateless transport serves exactly one request, so each gets a pair.
      // A stateless transport: no session id, one request per instance.
      const transport = new WebStandardStreamableHTTPServerTransport();
      const mcp = new McpServer(
        { name: "yawn-test", version: "1.0.0" },
        { instructions: `Instructions of ${name}.` },
      );
      mcp.registerTool(
        name,
        { description: "report the validation drink", inputSchema: {} },
        async () => ({ content: [{ type: "text" as const, text: "lapsang" }] }),
      );
      mcp.registerResource("runbook", `${name}://runbook`, {}, async (uri) => ({
        contents: [{ uri: uri.href, text: `${name} runbook` }],
      }));
      await mcp.connect(transport);
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const web = await transport.handleRequest(
        toWebRequest(req, Buffer.concat(chunks).toString()),
      );
      res.writeHead(web.status, Object.fromEntries(web.headers));
      res.end(Buffer.from(await web.arrayBuffer()));
      await transport.close();
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server did not bind a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // A client still mounted when a test fails holds a keep-alive
        // connection, which would otherwise stall close until the timeout.
        server.closeAllConnections();
      }),
  };
}

/** Mounting and discovery are asynchronous, so poll rather than sleep. */
async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for a mount");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("MCP pool against a real server", () => {
  let directory: string;
  let store: McpServerStore;
  let pool: McpPool;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-mcp-live-"));
    store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();
    const ctx = new Context();
    await ctx.plugin(toolsPlugin);
    pool = new McpPool({ ctx, store, warn: () => {} });
  });

  afterEach(async () => {
    await pool.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it("connects, publishes tools, and removes them on dispose", async () => {
    const server = await startMcpServer();
    try {
      await store.upsert(GLOBAL_MCP_SCOPE, {
        serverName: "yawn",
        url: server.url,
        enabled: true,
      });

      await pool.sync();
      const connected = await waitFor(() => {
        const view = pool.views()[0];
        return view?.status === "connected" ? view : undefined;
      });
      expect(connected.toolCount).toBe(1);
      expect(connected.error).toBeUndefined();

      await pool.dispose();
      expect(pool.views()[0]?.status).toBe("disabled");
    } finally {
      await server.close();
    }
  }, 30_000);
});

/**
 * The isolation claim, against the real dsh services a session reads: the
 * tools registry, the system prompt, and the shared resource service. Two
 * agent scopes of different workspaces must see only their own workspace
 * server — its tools, its instructions, its name in the resource-server list —
 * and both must see the global server.
 */
describe("MCP pool scoping with real dsh services", () => {
  let directory: string;
  let store: McpServerStore;
  let pool: McpPool;
  let ctx: Context;
  let scopes: Scope[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-mcp-scope-"));
    store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();
    ctx = new Context();
    await ctx.plugin(systemPrompt);
    new ToolRuntime(ctx);
    await ctx.plugin(McpResourceRuntime);
    pool = new McpPool({ ctx, store, warn: () => {} });
    scopes = [];
  });

  afterEach(async () => {
    await pool.dispose();
    for (const scope of scopes) {
      await scope.dispose();
    }
    await rm(directory, { recursive: true, force: true });
  });

  /** An agent's scope, as dsh-agent-loop mints one per agent. */
  function agentScope(): { key: object; ctx: Context } {
    const key = {};
    const scope = createScope(ctx, key);
    scopes.push(scope);
    return { key, ctx: scope.ctx };
  }

  async function promptFor(key: object): Promise<string> {
    const assembly = await ctx.get("systemPrompt")!.assemble({ scope: key });
    return assembly.sections.map((section) => section.text).join("\n");
  }

  /** One agent scope's tool names; without a key, the host-wide view. */
  function toolsFor(key?: object): string[] {
    return ctx
      .get("tools")!
      .schemas(key)
      .map((schema) => schema.name)
      .sort();
  }

  it("keeps a workspace server inside that workspace's agents", async () => {
    const one = "https://github.com/example/one";
    const two = "https://github.com/example/two";
    const global = await startMcpServer("shared");
    const deploy = await startMcpServer("deploy");
    try {
      await store.upsert(GLOBAL_MCP_SCOPE, {
        serverName: "shared",
        url: global.url,
        enabled: true,
      });
      await store.upsert(
        { kind: "workspace", repositoryUrl: one },
        { serverName: "deploy", url: deploy.url, enabled: true },
      );
      await pool.sync();
      await waitFor(() =>
        pool.views().every((view) => view.status === "connected")
          ? true
          : undefined,
      );

      const inOne = agentScope();
      const inTwo = agentScope();
      await pool.attachAgent("agent-one", inOne.ctx, one);
      await pool.attachAgent("agent-two", inTwo.ctx, two);

      expect(toolsFor(inOne.key)).toEqual([
        "list_mcp_resource_templates",
        "list_mcp_resources",
        "mcp__deploy__deploy",
        "mcp__shared__shared",
        "read_mcp_resource",
      ]);
      expect(toolsFor(inTwo.key)).toEqual([
        "list_mcp_resource_templates",
        "list_mcp_resources",
        "mcp__shared__shared",
        "read_mcp_resource",
      ]);

      const promptOne = await promptFor(inOne.key);
      expect(promptOne).toContain("Instructions of deploy.");
      expect(promptOne).toContain('["deploy","shared"]');
      const promptTwo = await promptFor(inTwo.key);
      expect(promptTwo).toContain("Instructions of shared.");
      expect(promptTwo).not.toContain("deploy");

      // The shared resource tool resolves the server in the caller's scope.
      const resources = ctx.get("mcpResources")! as unknown as {
        request(
          server: string,
          request: unknown,
          exec: { agent: object },
        ): Promise<unknown>;
      };
      expect(() =>
        resources.request(
          "deploy",
          { method: "resources/read", params: { uri: "deploy://runbook" } },
          { agent: inTwo.key },
        ),
      ).toThrow("unavailable in this agent's scope");

      // Neither the status mount nor the host-wide view carries it.
      expect(toolsFor()).not.toContain("mcp__deploy__deploy");
      expect(
        pool.views().find((view) => view.serverName === "deploy"),
      ).toMatchObject({ status: "connected", toolCount: 1 });

      await pool.detachAgent("agent-one", inOne.ctx);
      expect(toolsFor(inOne.key)).not.toContain("mcp__deploy__deploy");
    } finally {
      await global.close();
      await deploy.close();
    }
  }, 30_000);

  it("probes a connection where no session can see it", async () => {
    const server = await startMcpServer("probe");
    try {
      const probing = pool.testConnection({
        serverName: "fresh",
        url: server.url,
        enabled: true,
      });
      const seen = new Set<string>();
      const watcher = setInterval(() => {
        for (const name of toolsFor()) {
          seen.add(name);
        }
      }, 1);
      const result = await probing;
      clearInterval(watcher);
      expect(result).toEqual({ ok: true, toolCount: 1 });
      expect([...seen].filter((name) => name.startsWith("mcp__"))).toEqual([]);
    } finally {
      await server.close();
    }
  }, 30_000);
});
