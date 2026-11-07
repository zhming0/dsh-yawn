import { useEffect, useState, type ReactNode } from "react";

import {
  IconInfoOutlineMedium,
  IconWarningTriangleOutlineMedium,
  StateDot,
  Switch,
  type StateDotState,
} from "@deepseek-ai/dsh-client-ui-primitives";
// Type-only imports for the declaration merges that define the
// `conversation.view` slot key and the session standard props.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

import type { SessionMcpView } from "../../mcp/session-mcp-remote.js";

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
      <header style={headerStyle}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            MCP servers
          </h2>
          <p style={descriptionStyle}>
            {view.servers.length === 0
              ? "No MCP server is enabled on this deployment. Add one under Settings → MCP."
              : "Choose which servers this session can use."}
          </p>
        </div>
        {view.servers.length === 0 ? null : (
          <span style={countStyle}>
            {on.length} of {view.servers.length} enabled
          </span>
        )}
      </header>
      {view.servers.length === 0 ? null : (
        <div style={noticeStyle}>
          <span aria-hidden style={noticeIconStyle}>
            {view.presetHidesMcp ? (
              <IconWarningTriangleOutlineMedium size={16} />
            ) : (
              <IconInfoOutlineMedium size={16} />
            )}
          </span>
          <p style={{ margin: 0 }}>
            {view.presetHidesMcp ? (
              <>
                <strong>MCP tools are disabled by this agent preset.</strong>{" "}
                Server switches are unavailable.
              </>
            ) : (
              <>
                <strong>Changes apply to your next message.</strong> The next
                response may be slower while the prompt cache is refreshed.
              </>
            )}
          </p>
        </div>
      )}
      {error === undefined ? null : <p style={errorStyle}>{error}</p>}
      {view.servers.length === 0 ? null : (
        <ul style={serverListStyle}>
          {view.servers.map((server, index) => {
            const enabled = !off.has(server.serverName);
            return (
              <li
                key={server.serverName}
                style={index === 0 ? undefined : serverDividerStyle}
              >
                <div style={serverRowStyle}>
                  <div style={{ minWidth: 0 }}>
                    <div style={serverNameRowStyle}>
                      <StateDot
                        size={10}
                        state={mcpDot(server.status, enabled)}
                      />
                      <span
                        style={{
                          overflowWrap: "anywhere",
                          fontWeight: 500,
                          fontSize: 14,
                          color: enabled ? undefined : captionColor,
                        }}
                      >
                        {server.serverName}
                      </span>
                    </div>
                    <p style={serverDetailStyle}>
                      {serverDetail(server.status, enabled, server.toolCount)}
                    </p>
                  </div>
                  <Switch
                    checked={enabled}
                    onChange={(next) => toggle(server.serverName, next)}
                    label={`${server.serverName} for this session`}
                    title={
                      view.presetHidesMcp
                        ? "MCP tools are disabled by this agent preset"
                        : enabled
                          ? "On for this session"
                          : "Off for this session"
                    }
                    disabled={disabled}
                  />
                </div>
                {!view.presetHidesMcp && server.tools.length > 0 && (
                  <details style={toolsStyle}>
                    <summary style={toolsSummaryStyle}>View tools</summary>
                    <ul style={toolListStyle}>
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
    return "Off for this session";
  }
  switch (status) {
    case "connected":
      return `Connected · ${toolCount === 1 ? "1 tool" : `${toolCount} tools`}`;
    case "needs-auth":
      return "Sign-in required";
    case "starting":
      return "Connecting…";
    case "error":
      return "Connection error";
    default:
      return "Unavailable";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const captionColor = "var(--dsw-alias-label-caption)";
const headerStyle = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 16,
  margin: "0 0 16px",
} as const;
const descriptionStyle = {
  margin: "6px 0 0",
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--dsw-alias-label-secondary)",
} as const;
const countStyle = {
  marginTop: 2,
  fontSize: 12,
  whiteSpace: "nowrap",
  color: captionColor,
} as const;
const noticeStyle = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  margin: "0 0 16px",
  padding: "10px 12px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-2)",
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--dsw-alias-label-secondary)",
} as const;
const noticeIconStyle = {
  display: "inline-flex",
  flex: "none",
  marginTop: 1,
  color: captionColor,
} as const;
const serverListStyle = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 8,
  background: "var(--dsw-alias-settings-card-fill)",
  overflow: "hidden",
} as const;
const serverDividerStyle = {
  borderTop: "1px solid var(--dsw-alias-border-l2)",
} as const;
const serverRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  padding: "14px 16px",
} as const;
const serverNameRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
} as const;
const serverDetailStyle = {
  margin: "4px 0 0 18px",
  fontSize: 12,
  lineHeight: 1.5,
  color: captionColor,
} as const;
const toolsStyle = {
  margin: "-4px 16px 14px 34px",
} as const;
const toolsSummaryStyle = {
  width: "fit-content",
  cursor: "pointer",
  fontSize: 12,
  color: "var(--dsw-alias-label-secondary)",
} as const;
const toolListStyle = {
  margin: "8px 0 0",
  padding: "8px 12px 8px 30px",
  borderRadius: 6,
  background: "var(--dsw-alias-bg-layer-2)",
  fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)",
  fontSize: 12,
  lineHeight: 1.6,
  color: "var(--dsw-alias-label-secondary)",
  overflowWrap: "anywhere",
} as const;
const errorStyle = {
  margin: "0 0 12px",
  color: "var(--dsw-alias-label-error)",
} as const;
