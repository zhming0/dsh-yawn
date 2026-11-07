import type { McpServerEntry } from "./mcp-store.js";
import type { McpServerView } from "./mcp-remote.js";
import type { SessionHiddenServers } from "./mcp-tool-exclusion.js";
import type { SessionMcpView } from "./session-mcp-remote.js";
import type { SessionStore } from "../core/state-store.js";

/** The part of the session view the choice decides; the manager adds the rest. */
type McpChoiceView = Omit<SessionMcpView, "presetHidesMcp">;

export interface McpChoiceOptions {
  store: SessionStore;
  /** The saved server entries; cheap, unlike a status view. */
  servers: () => McpServerEntry[];
  /** Every configured server with its live status and tool count. */
  views: () => McpServerView[];
  /** Whether a turn is open, so its tool set must not change under it. */
  turnLive: (sessionId: string) => boolean;
  /** Called after a session's choice changes, so live agents follow it. */
  changed: () => void;
  warn: (message: string) => void;
}

/**
 * The MCP servers one session hides: the servers its page turned off, or, for
 * a session that never chose, the servers configured to start off.
 *
 * The New Session row's MCP menu and the MCP view edit one stored list. An
 * open turn keeps the list it started with, so a change made mid-turn lands on
 * the next one: the tool mask and the prompt sections read the snapshot in
 * `live` until `endTurn`, and the next request then rebuilds both. That
 * rebuild is why a change costs one prompt-cache miss. The default is frozen
 * into the session's own record when its first turn starts, so changing a
 * server's default later cannot change a session that is already running.
 */
export class McpChoice {
  /** The list each open turn runs with, keyed by root session. */
  private readonly live = new Map<string, readonly string[]>();

  constructor(private readonly options: McpChoiceOptions) {}

  view(sessionId: string): McpChoiceView {
    // `views()` projects the registry once and carries the names, so the
    // count and the list under it cannot disagree.
    const servers = this.options
      .views()
      .filter((server) => server.enabled)
      .map(({ serverName, status, toolCount, tools }) => ({
        serverName,
        status,
        toolCount,
        tools,
      }));
    const listed = new Set(servers.map((server) => server.serverName));
    return {
      servers,
      disabled: this.chosen(sessionId).filter((name) => listed.has(name)),
    };
  }

  async set(sessionId: string, disabled: string[]): Promise<McpChoiceView> {
    const known = new Set(
      this.options.servers().map((server) => server.serverName),
    );
    for (const name of disabled) {
      if (!known.has(name)) {
        throw new Error(`unknown MCP server: ${name}`);
      }
    }
    // The in-memory write and the change notice run in one synchronous step,
    // so a prompt assembled meanwhile sees either the old choice or the new
    // one in both its tools and its prompt sections, never a mix.
    const written = this.options.store.setDisabledMcpServers(
      sessionId,
      [...new Set(disabled)].sort(),
    );
    // An open turn keeps the snapshot it started with; the last `endTurn`
    // applies this list. Outside a turn there is nothing to hold back.
    if (!this.options.turnLive(sessionId)) {
      this.live.delete(sessionId);
      this.options.changed();
    }
    await written;
    return this.view(sessionId);
  }

  /**
   * What one session hides: the servers it turned off (including ones since
   * removed) and whether those cover every enabled server.
   */
  hidden(sessionId: string): SessionHiddenServers {
    const servers = this.options.turnLive(sessionId)
      ? (this.live.get(sessionId) ?? this.chosen(sessionId))
      : this.chosen(sessionId);
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
   * Start a turn with the current choice. A change made while it runs waits
   * for `endTurn`, so the tool mask and prompt text stay put under the model.
   *
   * Turns of one root session overlap (a subagent shares the root's sandbox
   * and its turns), so the first open turn owns the snapshot: a later start
   * must not pick up a change that was deferred for the first one.
   */
  beginTurn(sessionId: string): void {
    if (!this.live.has(sessionId)) {
      this.live.set(sessionId, this.chosen(sessionId));
    }
  }

  /**
   * Close one turn and say whether the page changed the list while it ran.
   * The last open turn applies the change; an earlier one leaves it waiting,
   * because another turn under the same root still runs on the snapshot.
   */
  endTurn(sessionId: string): boolean {
    if (this.options.turnLive(sessionId)) {
      return false;
    }
    const open = this.live.get(sessionId);
    this.live.delete(sessionId);
    return open !== undefined && !sameServers(open, this.chosen(sessionId));
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

/** Whether two choices name the same servers, order aside. */
function sameServers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const seen = new Set(left);
  return right.every((name) => seen.has(name));
}
