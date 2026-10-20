import type { McpServerView } from "../mcp-remote.js";
import type { SessionHiddenServers } from "../mcp-tool-exclusion.js";
import type { SessionMcpView } from "../session-mcp-remote.js";
import type { SessionStore } from "../state-store.js";

export interface McpChoiceOptions {
  store: SessionStore;
  /** Every configured server, enabled or not, in saved order. */
  servers: () => McpServerView[];
  /** Whether the session has sent a prompt, so its tool set is in use. */
  started: (sessionId: string) => boolean;
  /** Called after a session's choice changes, so live agents follow it. */
  changed: () => void;
}

/**
 * The MCP servers one session turned off. The New Session row's MCP menu
 * edits the list before the first prompt; after that it is locked, so the tool schemas and
 * prompt text the model saw on its first request stay the same for the whole
 * session and the cached prompt prefix keeps working.
 */
export class McpChoice {
  constructor(private readonly options: McpChoiceOptions) {}

  view(sessionId: string): SessionMcpView {
    const servers = this.options
      .servers()
      .filter((server) => server.enabled)
      .map(({ serverName, status, toolCount }) => ({
        serverName,
        status,
        toolCount,
      }));
    const listed = new Set(servers.map((server) => server.serverName));
    return {
      servers,
      disabled: this.options.store
        .disabledMcpServers(sessionId)
        .filter((name) => listed.has(name)),
      locked: this.options.started(sessionId),
    };
  }

  async set(sessionId: string, disabled: string[]): Promise<SessionMcpView> {
    if (this.options.started(sessionId)) {
      throw new Error("MCP servers cannot change after the first prompt");
    }
    const known = new Set(
      this.options.servers().map((server) => server.serverName),
    );
    for (const name of disabled) {
      if (!known.has(name)) {
        throw new Error(`unknown MCP server: ${name}`);
      }
    }
    // The lock check, the in-memory write, and the change notice run in one
    // synchronous step, so a prompt sent meanwhile sees either the old choice
    // or the new one in both its tools and its prompt sections, never a mix.
    const written = this.options.store.setDisabledMcpServers(
      sessionId,
      [...new Set(disabled)].sort(),
    );
    this.options.changed();
    await written;
    return this.view(sessionId);
  }

  /**
   * What one session hides: the servers it turned off (including ones since
   * removed) and whether those cover every enabled server.
   */
  hidden(sessionId: string): SessionHiddenServers {
    const servers = this.options.store.disabledMcpServers(sessionId);
    const off = new Set(servers);
    return {
      servers,
      everyServer:
        servers.length > 0 &&
        this.options
          .servers()
          .every((server) => !server.enabled || off.has(server.serverName)),
    };
  }
}
