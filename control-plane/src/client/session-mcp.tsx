import { useEffect, useState } from "react";

import {
  Menu,
  IconChevronDownOutlineMedium,
} from "@deepseek-ai/dsh-client-ui-primitives";
// Type-only imports for the declaration merges that define the
// `conversation.hero.options` slot key and the session standard props.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

import type {
  SessionMcpServer,
  SessionMcpView,
} from "../session-mcp-remote.js";

export interface SessionMcpActions {
  getSessionMcp: (sessionId: string) => Promise<SessionMcpView>;
  setSessionMcp: (
    sessionId: string,
    disabled: string[],
  ) => Promise<SessionMcpView>;
}

type SessionMcpChipProps = PropsRuntime<"conversation.hero.options"> &
  SessionMcpActions;

/**
 * New Session row control that turns MCP servers off for one session before
 * its first prompt, so their tool schemas and instructions stay out of every
 * request. The row only renders for a blank session, which is exactly when
 * the choice can change. Hidden when no server is enabled.
 */
export function SessionMcpChip({
  sessionId: id,
  getSessionMcp,
  setSessionMcp,
}: SessionMcpChipProps) {
  const sessionId = String(id);
  const [view, setView] = useState<SessionMcpView>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [error, setError] = useState<string>();

  // Read again each time the menu opens: servers connect and sign in while
  // the New Session row is on screen, and their status and tool counts move.
  useEffect(() => {
    let cancelled = false;
    getSessionMcp(sessionId)
      .then((next) => {
        if (!cancelled) {
          setView(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setView(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, open, getSessionMcp]);

  if (view === undefined || view.servers.length === 0) {
    return null;
  }

  const disabledSet = new Set(view.disabled);
  const enabled = view.servers.filter(
    (server) => !disabledSet.has(server.serverName),
  );

  // The menu stays open so several servers can be toggled in one visit.
  const toggle = (serverName: string) => {
    if (busy || view.locked) {
      return;
    }
    const next = disabledSet.has(serverName)
      ? view.disabled.filter((name) => name !== serverName)
      : [...view.disabled, serverName];
    setBusy(true);
    setError(undefined);
    setSessionMcp(sessionId, next)
      .then(setView)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        return getSessionMcp(sessionId).then(setView, () => {});
      })
      .finally(() => setBusy(false));
  };

  const disabled = view.locked;
  const label =
    enabled.length === view.servers.length
      ? "MCP"
      : `MCP ${enabled.length}/${view.servers.length}`;
  return (
    <Menu
      open={open}
      align="end"
      items={[
        { type: "label", id: "heading", text: "MCP servers" },
        ...view.servers.map((server) => ({
          id: server.serverName,
          disabled: busy,
          label: (
            <>
              {server.serverName}
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  color: "var(--dsw-alias-label-caption)",
                }}
              >
                {caption(server)}
              </span>
            </>
          ),
        })),
      ]}
      footer={
        error === undefined ? [] : [{ type: "label", id: "error", text: error }]
      }
      selectedIds={enabled.map((server) => server.serverName)}
      onSelect={toggle}
      onClose={() => {
        setOpen(false);
        setError(undefined);
      }}
      anchor={
        <button
          type="button"
          data-testid="dsh-yawn-session-mcp"
          aria-label={`MCP servers: ${enabled.length} of ${view.servers.length} on`}
          title={
            view.locked
              ? "MCP servers cannot change after the first prompt"
              : "Turn MCP servers off for this session"
          }
          disabled={disabled}
          onClick={() => setOpen(!open)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 28,
            padding: "0 4px 0 8px",
            background: hovered && !disabled ? hoverBackground : "none",
            border: "none",
            borderRadius: 24,
            color: disabled ? "var(--dsw-alias-label-dimmed)" : labelColor,
            cursor: disabled ? "default" : "pointer",
            font: "inherit",
            fontSize: 13,
            fontWeight: 500,
            lineHeight: "20px",
            whiteSpace: "nowrap",
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <PlugIcon />
          {label}
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              color: "var(--dsw-alias-label-caption)",
              transition: "transform .12s",
              transform: open ? "rotate(180deg)" : undefined,
            }}
          >
            <IconChevronDownOutlineMedium />
          </span>
        </button>
      }
    />
  );
}

/** Tool count for a connected server, otherwise why it has no tools yet. */
function caption(server: SessionMcpServer): string {
  switch (server.status) {
    case "connected":
      return server.toolCount === 1 ? "1 tool" : `${server.toolCount} tools`;
    case "needs-auth":
      return "needs sign-in";
    default:
      return server.status;
  }
}

const labelColor = "var(--dsw-alias-label-secondary)";
const hoverBackground = "var(--dsw-alias-interactive-bg-hover)";

/** A plug glyph in the 16px outline style of dsh's own chip icons. */
function PlugIcon() {
  return (
    <svg
      aria-hidden
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none" }}
    >
      <path d="M5.75 1.75v3M10.25 1.75v3" />
      <path d="M3.75 4.75h8.5v2.5a4.25 4.25 0 0 1-8.5 0v-2.5Z" />
      <path d="M8 11.5v2.75" />
    </svg>
  );
}
