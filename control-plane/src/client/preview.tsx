import { useEffect, useRef, useState, type ReactNode } from "react";

// Type-only import for the declaration merge that defines the
// `conversation.view` slot key and the session standard props.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

import type { SandboxStatusView } from "../sandbox-status-remote.js";

export interface PreviewActions {
  getSandboxStatus: (sessionId: string) => Promise<SandboxStatusView>;
}

type PreviewTabProps = PropsRuntime<"conversation.view"> & PreviewActions;

/**
 * The Preview view: the session's live preview, framed beside the chat. The
 * host is the Sandbox tab's preview host with the port swapped for whatever
 * the sandbox server listens on — and the runner reports which ports are
 * listening, so that is normally a choice, not a number to look up. Each
 * preview is its own origin, so the page keeps its storage and cookies and
 * cannot reach the dsh UI's origin around the frame; the URL is safe to open
 * in a tab of its own.
 */
export function PreviewTab({
  sessionId: id,
  useSession,
  getSandboxStatus,
}: PreviewTabProps) {
  const sessionId = String(id);
  const running = useSession((s) => s.running);
  const [view, setView] = useState<SandboxStatusView>();
  const [error, setError] = useState<string>();
  // Undefined means "follow the sandbox": the first detected port is used
  // until someone types or picks one. A fixed choice is remembered per
  // session, because leaving the tab unmounts this view.
  const remembered = useRef(recall(sessionId)).current;
  const [chosenPort, setChosenPort] = useState<string | undefined>(
    remembered.port,
  );
  // The path is an entry point, not a live address bar: reading the frame's
  // own location needs same-origin rights the UI keeps to itself. It is
  // edited in the toolbar and committed on Enter or Reload, so typing does
  // not navigate on every keystroke.
  const [path, setPath] = useState(remembered.path ?? "");
  const [pathDraft, setPathDraft] = useState(remembered.path ?? "");
  const [frameKey, setFrameKey] = useState(0);

  useEffect(() => {
    remember(sessionId, { port: chosenPort, path });
  }, [sessionId, chosenPort, path]);

  const load = () => {
    setPath(pathDraft);
    setFrameKey((key) => key + 1);
  };

  useEffect(() => {
    let cancelled = false;
    const fetch = () => {
      getSandboxStatus(sessionId).then(
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
    const timer = setInterval(fetch, running ? 5_000 : 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, running, getSandboxStatus]);

  const sandbox = view?.sandbox;
  const detected = view?.live?.listeningPorts ?? [];
  const port =
    chosenPort ?? (detected.length > 0 ? String(detected[0]) : "3000");
  const host =
    sandbox?.previewHost === undefined
      ? undefined
      : withPreviewPort(sandbox.previewHost, port);
  // The scheme is this page's: whatever serves the UI also fronts the
  // preview listener, so previews never go mixed-content or plain-HTTP-down.
  const src =
    host === undefined
      ? undefined
      : `${location.protocol}//${host}` + previewPathSuffix(path);

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        color: "var(--dsw-alias-label-primary)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 20px",
          flexWrap: "wrap",
        }}
      >
        {detected.length === 0 ? (
          <span style={{ fontSize: 12, color: captionColor }}>
            No listening port detected in the sandbox yet.
          </span>
        ) : (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: captionColor,
            }}
          >
            Detected
            {detected.map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => setChosenPort(String(candidate))}
                style={{
                  fontSize: 12,
                  fontWeight:
                    String(candidate) === port ? "bold" : ("normal" as const),
                }}
              >
                {candidate}
              </button>
            ))}
          </span>
        )}
        <input
          value={port}
          onChange={(event) => setChosenPort(event.target.value)}
          inputMode="numeric"
          aria-label="Sandbox server port"
          style={{
            width: 72,
            padding: "2px 8px",
            fontSize: 12,
            fontFamily: "inherit",
            color: "inherit",
            background: "var(--dsw-alias-fill-secondary)",
            border: "1px solid var(--dsw-alias-outline-secondary)",
            borderRadius: 4,
          }}
        />
        <input
          value={pathDraft}
          onChange={(event) => setPathDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              load();
            }
          }}
          placeholder="/"
          spellCheck={false}
          aria-label="Sandbox server path"
          title="Path on the sandbox server, such as /docs?tab=1. The framed page navigates on its own from there; this field is where it starts."
          style={{
            flex: "1 1 160px",
            minWidth: 0,
            padding: "2px 8px",
            fontSize: 12,
            fontFamily: "inherit",
            color: "inherit",
            background: "var(--dsw-alias-fill-secondary)",
            border: "1px solid var(--dsw-alias-outline-secondary)",
            borderRadius: 4,
          }}
        />
        <button
          type="button"
          onClick={load}
          disabled={src === undefined}
          style={{ fontSize: 12 }}
        >
          Reload
        </button>
        {src !== undefined && (
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12 }}
          >
            Open
          </a>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: "0 20px 16px" }}>
        {error !== undefined ? (
          <p style={{ margin: 0, color: "var(--dsw-alias-label-error)" }}>
            {error}
          </p>
        ) : view !== undefined && view.previewDomain === undefined ? (
          <Caption>
            Previews are not configured. Set a preview domain in the
            sandbox-manager settings (`preview.domain`) and expose its listener;
            each sandbox then serves its HTTP servers at sandbox-specific host
            names.
          </Caption>
        ) : sandbox?.previewHost === undefined ? (
          <Caption>
            {sandbox === undefined
              ? "This session has no sandbox yet. It is provisioned when you send the first prompt."
              : "This sandbox has no ID yet, so there is nothing to preview."}
          </Caption>
        ) : host === undefined ? (
          <Caption>The port must be a number between 1 and 65535.</Caption>
        ) : sandbox.state !== "running" ? (
          <Caption>
            The sandbox is {sandbox.state}. Send a prompt in the chat to wake
            it, then reload the preview.
          </Caption>
        ) : (
          <iframe
            key={frameKey}
            src={src}
            title="Sandbox web preview"
            // The preview's origin is its own, so it gets same-origin rights
            // (storage, service workers) without touching the UI's. The
            // sandbox attribute stays to keep the page from navigating this
            // top-level tab: without allow-top-navigation, that is refused.
            sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin"
            style={{
              width: "100%",
              height: "100%",
              border: "1px solid var(--dsw-alias-outline-secondary)",
              borderRadius: 4,
              background: "var(--dsw-alias-fill-secondary)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        fontSize: 13,
        color: captionColor,
      }}
    >
      {children}
    </p>
  );
}

const captionColor = "var(--dsw-alias-label-caption)";

/**
 * Swap the port segment of a preview host. The shape is the control plane's
 * (`<sandboxId>-p<port>.<domain>`, see src/preview.ts); only the trailing
 * port marker is touched, and anything that does not parse leaves the host
 * alone.
 */
function withPreviewPort(host: string, port: string): string | undefined {
  const trimmed = port.trim();
  if (!/^\d{1,5}$/.test(trimmed)) {
    return undefined;
  }
  const number = Number(trimmed);
  if (number < 1 || number > 65_535) {
    return undefined;
  }
  // The first DNS label ends in the port marker; the domain may contain the
  // same shape, so only a first label that parses is swapped.
  if (!/^[a-z0-9-]+-p\d{1,5}\./.test(host)) {
    return undefined;
  }
  return host.replace(/-p\d{1,5}\./, `-p${trimmed}.`);
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The entry path appended to a preview origin. Leading slashes are dropped
 * rather than doubled; an empty path means the server's root, and a query
 * rides along untouched.
 */
function previewPathSuffix(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, "");
  return trimmed === "" ? "" : `/${trimmed}`;
}

/** The port and path one session's preview was last left at. */
interface PreviewMemory {
  port?: string | undefined;
  path?: string | undefined;
}

const STORAGE_PREFIX = "dsh-yawn.preview.";

function recall(sessionId: string): PreviewMemory {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + sessionId);
    if (raw === null || raw === "") {
      return {};
    }
    const parsed = JSON.parse(raw) as { port?: unknown; path?: unknown };
    return {
      ...(typeof parsed.port === "string" ? { port: parsed.port } : {}),
      ...(typeof parsed.path === "string" ? { path: parsed.path } : {}),
    };
  } catch {
    // Storage disabled, or a value from an older shape: the fields fall back
    // to the detected port and the server root.
    return {};
  }
}

function remember(sessionId: string, memory: PreviewMemory): void {
  try {
    window.localStorage.setItem(
      STORAGE_PREFIX + sessionId,
      JSON.stringify(memory),
    );
  } catch {
    // Storage disabled: the choice just resets when the view unmounts.
  }
}
