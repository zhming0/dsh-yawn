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
  warn: (message: string) => void;
}

/**
 * The MCP servers one session hides: the servers its page turned off, or, for
 * a session that never chose, the servers configured to start off.
 *
 * The New Session row's MCP menu edits the list before the first prompt;
 * after that it is locked, so the tool schemas and prompt text the model saw
 * on its first request stay the same for the whole session and the cached
 * prompt prefix keeps working. The default is frozen into the session's own
 * record when its first turn starts, so changing a server's default later
 * cannot change a session that is already running.
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
      disabled: this.chosen(sessionId).filter((name) => listed.has(name)),
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
    const servers = this.chosen(sessionId);
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

  /**
   * Record the servers a session runs with as its own choice, so a later edit
   * to a server's default leaves this session alone. Called when a turn
   * starts; a session that already chose is kept.
   *
   * A session past its first turn ran before it had a record, when every
   * server was on, so it records everything on rather than today's default: a
   * conversation must not lose a server mid-way because the default changed
   * after it started.
   */
  freeze(sessionId: string, turn: number): void {
    if (this.options.store.disabledMcpServers(sessionId) !== undefined) {
      return;
    }
    const written = this.options.store.setDisabledMcpServers(
      sessionId,
      turn > 1 ? [] : this.defaults(),
    );
    // The list the mask and the prompt sections read has just changed; the
    // notice must follow it in the same synchronous step, or a session frozen
    // on its first turn would drop the server's instructions while still
    // sending its tools.
    this.options.changed();
    void written.catch((reason: unknown) => {
      this.options.warn(
        `could not freeze the MCP server choice of session ${sessionId}: ${describe(reason)}`,
      );
    });
  }

  /** The session's own choice, or the configured default for a new one. */
  private chosen(sessionId: string): readonly string[] {
    return this.options.store.disabledMcpServers(sessionId) ?? this.defaults();
  }

  /** The servers a new session starts with turned off. */
  private defaults(): string[] {
    return this.options
      .servers()
      .filter((server) => server.enabled && server.offByDefault)
      .map((server) => server.serverName);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
