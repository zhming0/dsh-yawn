import { useEffect, useState, type ReactNode } from "react";

import {
  StateDot,
  Switch,
  type StateDotState,
} from "@deepseek-ai/dsh-client-ui-primitives";
// Type-only imports for the declaration merges that define the
// `conversation.view` slot key and the session standard props.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

import type { SessionMcpView } from "../session-mcp-remote.js";

import type { SessionMcpActions } from "./session-mcp.js";

type SessionMcpViewProps = PropsRuntime<"conversation.view"> &
  SessionMcpActions;

/**
 * The MCP servers this session runs with, and the per-session switch for each.
 *
 * A session that started from the New Session row already has a choice; this
 * view reads it and changes it. A change applies from the next turn: a live
 * turn keeps the tool set it started with, and the next request rebuilds the
 * tool list and prompt, which is why the view warns about the prompt cache.
 */
export function McpServersView({
  sessionId: id,
  useSession,
  getSessionMcp,
  setSessionMcp,
}: SessionMcpViewProps) {
  const sessionId = String(id);
  const running = useSession((s) => s.running);
  const [view, setView] = useState<SessionMcpView>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const fetch = () => {
      getSessionMcp(sessionId).then(
        (next) => {
          if (!cancelled) {
            setView(next);
            setError(undefined);
          }
        },
        (reason: unknown) => {
          if (!cancelled) {
            setError(describe(reason));
          }
        },
      );
    };
    fetch();
    // Server statuses move on their own: a connection settles, a reconnect
    // budget runs out, a sign-in completes.
    const timer = setInterval(fetch, running ? 5_000 : 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, running, getSessionMcp]);

  if (view === undefined) {
    return (
      <Page>
        {error === undefined ? null : <p style={errorStyle}>{error}</p>}
      </Page>
    );
  }

  const off = new Set(view.disabled);
  const on = view.servers.filter((server) => !off.has(server.serverName));
  const disabled = view.presetHidesMcp || busy !== undefined;

  const toggle = (serverName: string, enabled: boolean) => {
    if (disabled) {
      return;
    }
    const next = enabled
      ? view.disabled.filter((name) => name !== serverName)
      : [...view.disabled, serverName];
    setBusy(serverName);
    setError(undefined);
    setSessionMcp(sessionId, next)
      .then(setView)
      .catch((reason: unknown) => {
        setError(describe(reason));
        // The switch is controlled by `view`, which the failed write never
        // changed; re-read so a concurrent change elsewhere is reflected.
        return getSessionMcp(sessionId).then(setView, () => {});
      })
      .finally(() => setBusy(undefined));
  };

  return (
    <Page>
      <header style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>MCP servers</h2>
      </header>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: captionColor }}>
        {view.servers.length === 0
          ? "No MCP server is enabled on this deployment. Add one under Settings → MCP."
          : `${on.length} of ${view.servers.length} on for this session.${
              view.presetHidesMcp ? "" : " Changes apply from the next turn."
            }`}
      </p>
      {view.servers.length === 0 ? null : (
        <p style={warningStyle}>
          {view.presetHidesMcp
            ? "This session's agent preset hides every MCP tool, so these switches have no effect here."
            : "A change rebuilds the tool list and prompt for that turn, so it cannot reuse the cached prompt prefix."}
        </p>
      )}
      {error === undefined ? null : <p style={errorStyle}>{error}</p>}
      {view.servers.length === 0 ? null : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {view.servers.map((server) => {
            const enabled = !off.has(server.serverName);
            const detail = serverDetail(
              server.status,
              enabled,
              server.toolCount,
            );
            return (
              <li
                key={server.serverName}
                style={{
                  padding: "8px 0",
                  borderTop: "1px solid var(--dsw-alias-border-l2)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <Switch
                    checked={enabled}
                    onChange={(next) => toggle(server.serverName, next)}
                    label={`${server.serverName} for this session`}
                    title={
                      view.presetHidesMcp
                        ? "This session's preset hides every MCP tool"
                        : enabled
                          ? "On for this session"
                          : "Off for this session"
                    }
                    disabled={disabled}
                  />
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <StateDot state={mcpDot(server.status, enabled)} />
                    <span
                      style={{
                        overflowWrap: "anywhere",
                        fontWeight: 500,
                        fontSize: 13,
                        color: enabled ? undefined : captionColor,
                      }}
                    >
                      {server.serverName}
                    </span>
                  </span>
                  {detail === "" ? null : (
                    <span style={{ color: captionColor, fontSize: 13 }}>
                      {detail}
                    </span>
                  )}
                </div>
                {!view.presetHidesMcp && server.tools.length > 0 && (
                  <details style={{ marginTop: 4, marginLeft: 46 }}>
                    <summary
                      style={{
                        cursor: "pointer",
                        fontSize: 12,
                        color: captionColor,
                      }}
                    >
                      {server.tools.length === 1
                        ? "1 tool"
                        : `${server.tools.length} tools`}
                    </summary>
                    <ul
                      style={{
                        margin: "4px 0 0",
                        paddingLeft: 18,
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 12,
                        color: "var(--dsw-alias-label-secondary)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {server.tools.map((tool) => (
                        <li key={tool}>{tool}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        padding: "16px 20px 32px",
        color: "var(--dsw-alias-label-primary)",
      }}
    >
      <div style={{ maxWidth: 720 }}>{children}</div>
    </div>
  );
}

function mcpDot(
  status: SessionMcpView["servers"][number]["status"],
  enabled: boolean,
): StateDotState {
  if (!enabled) {
    return "idle";
  }
  switch (status) {
    case "connected":
      return "done";
    case "starting":
      return "ongoing";
    case "needs-auth":
      return "warning";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function serverDetail(
  status: SessionMcpView["servers"][number]["status"],
  enabled: boolean,
  toolCount: number,
): string {
  if (!enabled) {
    return "not sent to the model";
  }
  switch (status) {
    case "connected":
      // The tool list below carries the count; a status word here would only
      // repeat what the dot and the list already say.
      return toolCount === 0 ? "connected" : "";
    case "needs-auth":
      return "needs sign-in";
    case "starting":
      return "starting";
    case "error":
      return "error";
    default:
      return "unavailable";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const captionColor = "var(--dsw-alias-label-caption)";
const warningStyle = {
  margin: "0 0 12px",
  padding: "8px 10px",
  borderLeft: "2px solid var(--dsw-alias-state-warn-primary)",
  background: "var(--dsw-alias-bg-layer-2)",
  borderRadius: 4,
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--dsw-alias-label-secondary)",
} as const;
const errorStyle = {
  margin: "0 0 12px",
  color: "var(--dsw-alias-label-error)",
} as const;
