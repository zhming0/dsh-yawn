import { useEffect, useState, type CSSProperties, type FormEvent } from "react";

import {
  Button,
  Input,
  Modal,
  SegmentedControl,
  Switch,
  Tag,
  type TagTone,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";

import type { McpAuth, McpServerView, McpTestResult } from "../mcp-remote.js";
import type { McpServerEntry } from "../mcp-store.js";
import {
  addButtonStyle,
  cardStyle,
  dialogFormStyle,
  errorStyle,
  fieldLabelStyle,
  firstFieldLabelStyle,
  hintStyle,
  introStyle,
  listStyle,
  monoStyle,
  mutedStyle,
  sectionStyle,
  titleStyle,
} from "./settings-page-style.js";

interface McpActions {
  listMcpServers: () => Promise<McpServerView[]>;
  setMcpServer: (entry: McpServerEntry) => Promise<McpServerView[]>;
  deleteMcpServer: (serverName: string) => Promise<McpServerView[]>;
  retryMcpServer: (serverName: string) => Promise<McpServerView[]>;
  testMcpServer: (entry: McpServerEntry) => Promise<McpTestResult>;
  startMcpAuthorization: (
    serverName: string,
    origin: string,
  ) => Promise<string>;
}

interface McpSettingsProps extends SettingsSectionOwnerProps, McpActions {}

/** The open dialog: a new server, or an existing one to edit. */
type Dialog = { kind: "add" } | { kind: "edit"; server: McpServerView };

/** A sign-in tab the page opened and is waiting on. */
interface SignIn {
  serverName: string;
  /** The server's sign-in state when the tab opened; any change ends the wait. */
  before: string;
  startedAt: number;
  /** Closing it ends the wait too: a failed sign-in leaves its reason there. */
  tab: Window;
}

/** The control plane forgets an unfinished sign-in after ten minutes. */
const signInWaitMs = 10 * 60_000;

const authOptions: ReadonlyArray<{ value: McpAuth; label: string }> = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer token" },
  { value: "oauth", label: "OAuth" },
];

/**
 * Settings page for remote Streamable HTTP MCP servers: one card per server
 * with its live status, in the stock Agent presets layout, and a dialog to add
 * or edit one. Tokens are write-only.
 */
export function McpSettings({
  listMcpServers,
  setMcpServer,
  deleteMcpServer,
  retryMcpServer,
  testMcpServer,
  startMcpAuthorization,
}: McpSettingsProps) {
  const [servers, setServers] = useState<McpServerView[]>();
  const [signIn, setSignIn] = useState<SignIn>();
  const [dialog, setDialog] = useState<Dialog>();
  const [confirming, setConfirming] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    listMcpServers().then(setServers, (reason) => setError(describe(reason)));
  }, [listMcpServers]);

  // A mount settles asynchronously, so a server that is still starting is
  // re-read until it reaches a terminal state; otherwise a freshly saved
  // server would sit on "Connecting" until the page was reopened.
  const starting = servers?.some((server) => server.status === "starting");
  useEffect(() => {
    if (starting !== true) {
      return;
    }
    const timer = setInterval(() => {
      listMcpServers().then(setServers, (reason) => setError(describe(reason)));
    }, 1_500);
    return () => clearInterval(timer);
  }, [starting, listMcpServers]);

  // The sign-in finishes in another tab, so the page re-reads until the
  // server's sign-in state moves, the tab is closed, or the control plane
  // would have forgotten the sign-in.
  useEffect(() => {
    if (signIn === undefined) {
      return;
    }
    const timer = setInterval(() => {
      if (Date.now() - signIn.startedAt > signInWaitMs) {
        setSignIn(undefined);
        return;
      }
      const closed = signIn.tab.closed;
      listMcpServers().then(
        (next) => {
          setServers(next);
          const server = next.find(
            (candidate) => candidate.serverName === signIn.serverName,
          );
          if (server === undefined || signInState(server) !== signIn.before) {
            setSignIn(undefined);
          } else if (closed) {
            setSignIn(undefined);
            setError(
              `The sign-in for ${signIn.serverName} was closed before it finished.`,
            );
          }
        },
        (reason) => setError(describe(reason)),
      );
    }, 1_500);
    return () => clearInterval(timer);
  }, [signIn, listMcpServers]);

  /** Run one write; the caller decides where a failure shows. */
  const run = async (action: () => Promise<McpServerView[]>) => {
    setPending(true);
    try {
      const next = await action();
      setServers(next);
      return next;
    } finally {
      setPending(false);
    }
  };

  /** A card action: failures show under the list. */
  const act = async (action: () => Promise<McpServerView[]>) => {
    setError(undefined);
    try {
      await run(action);
      return true;
    } catch (reason) {
      setError(describe(reason));
      return false;
    }
  };

  const remove = async (serverName: string) => {
    if (await act(() => deleteMcpServer(serverName))) {
      setConfirming(undefined);
    }
  };

  // Omitting the token keeps the saved one, so a toggle never touches it.
  const toggle = (server: McpServerView, enabled: boolean) =>
    void act(() =>
      setMcpServer({
        serverName: server.serverName,
        url: server.url,
        auth: server.auth,
        enabled,
      }),
    );

  /**
   * Open the authorization server's sign-in in a new tab. The tab must open
   * inside the click, before any await, or the browser blocks it; it is
   * pointed at the sign-in once the control plane answers the URL.
   */
  const connect = async (server: McpServerView, tab = openSignInTab()) => {
    setError(undefined);
    if (tab === null) {
      setError(
        "The browser blocked the sign-in tab. Allow pop-ups for this page and try again.",
      );
      return;
    }
    try {
      const url = await startMcpAuthorization(
        server.serverName,
        window.location.origin,
      );
      tab.location.href = url;
      setSignIn({
        serverName: server.serverName,
        before: signInState(server),
        startedAt: Date.now(),
        tab,
      });
    } catch (reason) {
      tab.close();
      setError(describe(reason));
    }
  };

  /** Save from the dialog; a server that still needs a sign-in starts one. */
  const save = async (entry: McpServerEntry) => {
    const previous = servers?.find(
      (server) => server.serverName === entry.serverName,
    );
    // A changed URL signs out, so it needs a sign-in as well.
    const needsSignIn =
      entry.auth === "oauth" &&
      entry.enabled &&
      (previous?.authorization?.kind !== "valid" || previous.url !== entry.url);
    const tab = needsSignIn ? openSignInTab() : undefined;
    let saved: McpServerView[];
    try {
      saved = await run(() => setMcpServer(entry));
    } catch (reason) {
      tab?.close();
      throw reason;
    }
    if (tab === undefined) {
      return;
    }
    const server = saved.find(
      (candidate) => candidate.serverName === entry.serverName,
    );
    if (server?.status === "needs-auth") {
      void connect(server, tab);
    } else {
      tab?.close();
    }
  };

  const openDialog = (next: Dialog) => {
    setConfirming(undefined);
    setDialog(next);
  };

  return (
    <section style={sectionStyle}>
      <h2 style={titleStyle}>MCP</h2>
      <p style={introStyle}>
        Remote MCP servers over Streamable HTTP. Their tools are available to
        every session.
      </p>

      {servers === undefined && error === undefined ? (
        <p style={introStyle}>Loading…</p>
      ) : null}

      {servers !== undefined ? (
        <>
          {servers.length === 0 ? (
            <p style={{ ...cardStyle, ...mutedStyle, margin: 0, padding: 16 }}>
              No MCP servers yet.
            </p>
          ) : (
            <ul style={gridStyle}>
              {servers.map((server) => (
                <ServerCard
                  key={server.serverName}
                  server={server}
                  confirming={confirming === server.serverName}
                  disabled={pending}
                  onToggle={(enabled) => toggle(server, enabled)}
                  onRetry={() =>
                    void act(() => retryMcpServer(server.serverName))
                  }
                  signingIn={signIn?.serverName === server.serverName}
                  onConnect={() => void connect(server)}
                  onEdit={() => openDialog({ kind: "edit", server })}
                  onDelete={() => setConfirming(server.serverName)}
                  onCancelDelete={() => setConfirming(undefined)}
                  onConfirmDelete={() => void remove(server.serverName)}
                />
              ))}
            </ul>
          )}

          <button
            type="button"
            disabled={pending}
            onClick={() => openDialog({ kind: "add" })}
            style={{ ...addButtonStyle, opacity: pending ? 0.4 : 1 }}
          >
            <span aria-hidden="true">+</span> Add server
          </button>

          <ServerDialog
            dialog={dialog}
            pending={pending}
            onSave={save}
            onTest={testMcpServer}
            onClose={() => setDialog(undefined)}
          />
        </>
      ) : null}

      {error !== undefined ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

interface ServerCardProps {
  server: McpServerView;
  confirming: boolean;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onRetry: () => void;
  signingIn: boolean;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

/**
 * One server: name, live status, and its Enabled switch, then its URL and
 * token state, then the actions. Delete asks once before it removes.
 */
function ServerCard({
  server,
  confirming,
  disabled,
  onToggle,
  onRetry,
  signingIn,
  onConnect,
  onEdit,
  onDelete,
  onCancelDelete,
  onConfirmDelete,
}: ServerCardProps) {
  const status = statusTag(server);
  return (
    <li style={{ ...cardStyle, display: "flex", flexDirection: "column" }}>
      <div style={cardBodyStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={cardNameStyle}>{server.serverName}</h3>
          <Tag tone={status.tone}>{status.text}</Tag>
          <span style={{ marginLeft: "auto", display: "flex" }}>
            <Switch
              checked={server.enabled}
              onChange={onToggle}
              label={`Enable ${server.serverName}`}
              title={server.enabled ? "Enabled" : "Disabled"}
              disabled={disabled}
            />
          </span>
        </div>
        <div style={{ ...monoStyle, ...mutedStyle, fontSize: 12 }}>
          {server.url}
        </div>
        <div style={{ ...mutedStyle, fontSize: 12 }}>
          {signingIn
            ? "Waiting for sign-in in the other tab…"
            : authText(server)}
        </div>
        {server.error !== undefined ? (
          <div style={cardErrorStyle} title={server.error}>
            {server.error}
          </div>
        ) : null}
      </div>
      <div style={cardFootStyle}>
        {confirming ? (
          <>
            <span style={{ ...mutedStyle, marginRight: "auto" }}>
              Delete this server?
            </span>
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={onCancelDelete}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={disabled}
              onClick={onConfirmDelete}
              aria-label={`Confirm delete ${server.serverName}`}
            >
              Delete
            </Button>
          </>
        ) : (
          <>
            {server.auth === "oauth" ? (
              <Button
                type="button"
                size="sm"
                {...(server.status === "needs-auth"
                  ? { variant: "primary" as const }
                  : {})}
                disabled={disabled}
                onClick={onConnect}
                aria-label={`${connectText(server)} ${server.serverName}`}
              >
                {connectText(server)}
              </Button>
            ) : null}
            {server.status === "error" ? (
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                onClick={onRetry}
                aria-label={`Retry ${server.serverName}`}
              >
                Retry
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={onEdit}
              aria-label={`Edit ${server.serverName}`}
            >
              Edit
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={onDelete}
              aria-label={`Delete ${server.serverName}`}
            >
              Delete
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

interface ServerDialogProps {
  dialog: Dialog | undefined;
  pending: boolean;
  onSave: (entry: McpServerEntry) => Promise<void>;
  onTest: (entry: McpServerEntry) => Promise<McpTestResult>;
  onClose: () => void;
}

/**
 * Add a server, or edit one. The name is the server's identity, so editing
 * keeps it; a blank token keeps the saved one, the same rule the host applies.
 * Saving an OAuth server that has no sign-in opens one.
 */
function ServerDialog({
  dialog,
  pending,
  onSave,
  onTest,
  onClose,
}: ServerDialogProps) {
  const edited = dialog?.kind === "edit" ? dialog.server : undefined;
  const [serverName, setServerName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<McpAuth>("none");
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setServerName(edited?.serverName ?? "");
    setUrl(edited?.url ?? "");
    setAuth(edited?.auth ?? "none");
    setToken("");
    setTestResult(undefined);
    setError(undefined);
  }, [dialog, edited]);

  const busy = pending || testing;
  const keepsToken = edited?.auth === "bearer" && edited.hasToken;

  const draft = (): McpServerEntry | undefined => {
    const name = serverName.trim();
    const endpoint = url.trim();
    if (name === "" || endpoint === "") {
      return undefined;
    }
    // A new server starts enabled; an edit keeps the card's switch.
    const entry: McpServerEntry = {
      serverName: name,
      url: endpoint,
      auth,
      enabled: edited?.enabled ?? true,
    };
    if (auth !== "bearer") {
      return entry;
    }
    if (token !== "") {
      return { ...entry, token };
    }
    // A bearer server needs a token: a typed one, or the one already saved.
    return keepsToken ? entry : undefined;
  };
  const entry = draft();

  /** Any edit makes an earlier test result stale. */
  const change = (apply: () => void) => {
    apply();
    setTestResult(undefined);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || entry === undefined) {
      return;
    }
    setError(undefined);
    try {
      await onSave(entry);
      onClose();
    } catch (reason) {
      setError(describe(reason));
    }
  };

  const test = async () => {
    if (busy || entry === undefined) {
      return;
    }
    setTesting(true);
    setError(undefined);
    setTestResult(undefined);
    try {
      setTestResult(await onTest(entry));
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal
      open={dialog !== undefined}
      onClose={() => {
        if (!busy) {
          onClose();
        }
      }}
      title={
        edited === undefined ? "Add MCP server" : `Edit ${edited.serverName}`
      }
      closeLabel="Close"
      footer={
        <>
          <Button
            type="button"
            disabled={busy || entry === undefined}
            onClick={() => void test()}
            style={{ marginRight: "auto" }}
          >
            {testing ? "Testing…" : "Test connection"}
          </Button>
          <Button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="dsh-yawn-mcp-form"
            variant="primary"
            disabled={busy || entry === undefined}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form id="dsh-yawn-mcp-form" onSubmit={submit} style={dialogFormStyle}>
        {edited === undefined ? (
          <>
            <label htmlFor="dsh-yawn-mcp-name" style={firstFieldLabelStyle}>
              Name
            </label>
            <Input
              id="dsh-yawn-mcp-name"
              data-modal-autofocus
              placeholder="github"
              autoComplete="off"
              spellCheck={false}
              value={serverName}
              disabled={busy}
              onChange={(event) =>
                change(() => setServerName(event.currentTarget.value))
              }
            />
            <p style={hintStyle}>
              Tools appear as{" "}
              <code>mcp__{serverName.trim() || "name"}__tool</code>.
            </p>
          </>
        ) : null}
        <label
          htmlFor="dsh-yawn-mcp-url"
          style={edited === undefined ? fieldLabelStyle : firstFieldLabelStyle}
        >
          URL
        </label>
        <Input
          id="dsh-yawn-mcp-url"
          {...(edited === undefined ? {} : { "data-modal-autofocus": true })}
          type="url"
          placeholder="https://example.com/mcp"
          autoComplete="off"
          spellCheck={false}
          value={url}
          disabled={busy}
          onChange={(event) => change(() => setUrl(event.currentTarget.value))}
        />
        <span style={fieldLabelStyle}>Authentication</span>
        <SegmentedControl
          id="dsh-yawn-mcp-auth"
          label="Authentication"
          value={auth}
          options={authOptions}
          disabled={busy}
          onChange={(next) => change(() => setAuth(next))}
        />
        <div
          id={`dsh-yawn-mcp-auth-${auth}-panel`}
          role="tabpanel"
          aria-labelledby={`dsh-yawn-mcp-auth-${auth}`}
        >
          {auth === "bearer" ? (
            <Input
              id="dsh-yawn-mcp-token"
              aria-label="Bearer token"
              type="password"
              autoComplete="off"
              placeholder={keepsToken ? "Saved; leave blank to keep" : "Token"}
              value={token}
              disabled={busy}
              onChange={(event) =>
                change(() => setToken(event.currentTarget.value))
              }
              style={{ marginTop: 8 }}
            />
          ) : null}
          <p style={hintStyle}>{authHint(auth, edited)}</p>
        </div>
        {testResult !== undefined ? (
          <p
            role="status"
            style={{
              ...hintStyle,
              color: testResult.ok
                ? "var(--dsw-alias-state-success-primary)"
                : "var(--dsw-alias-state-error-primary)",
              overflowWrap: "anywhere",
            }}
          >
            {testResult.ok
              ? `Connected: ${toolCountText(testResult.toolCount)}.`
              : `Failed: ${testResult.error ?? "unknown error"}`}
          </p>
        ) : null}
        {error !== undefined ? (
          <p role="alert" style={{ ...errorStyle, margin: "8px 0 0" }}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

function statusTag(server: McpServerView): { tone: TagTone; text: string } {
  switch (server.status) {
    case "needs-auth":
      return { tone: "warning", text: "Sign-in needed" };
    case "connected":
      return { tone: "success", text: toolCountText(server.toolCount) };
    case "starting":
      return { tone: "info", text: "Connecting…" };
    case "error":
      return { tone: "danger", text: "Error" };
    case "disabled":
      return { tone: "neutral", text: "Off" };
  }
}

/** The card's authentication line. */
function authText(server: McpServerView): string {
  switch (server.auth) {
    case "none":
      return "No authentication";
    case "bearer":
      return server.hasToken ? "Bearer token saved" : "Bearer token missing";
    case "oauth":
      switch (server.authorization?.kind) {
        case "valid":
          return server.authorization.until === undefined
            ? "OAuth: signed in"
            : `OAuth: signed in, expires ${expiryText(server.authorization.until)}`;
        case "expired":
          return "OAuth: sign-in expired";
        default:
          return "OAuth: not signed in";
      }
  }
}

function connectText(server: McpServerView): string {
  return server.authorization?.kind === "none" ? "Connect" : "Reauthenticate";
}

function authHint(auth: McpAuth, edited: McpServerView | undefined): string {
  switch (auth) {
    case "none":
      return "Requests carry no credentials.";
    case "bearer":
      return "Sent as an Authorization: Bearer header. Stays on the control plane.";
    case "oauth":
      return edited?.auth === "oauth" && edited.authorization?.kind !== "none"
        ? "Signed in through the server's own login. Changing the URL signs out."
        : "Saving opens the server's sign-in in a new tab. Tokens stay on the control plane and are not refreshed: sign in again when they expire.";
  }
}

/** A coarse "in 7 hours" for an expiry time. */
function expiryText(until: number): string {
  const minutes = Math.round((until - Date.now()) / 60_000);
  if (minutes < 60) {
    return `in ${Math.max(minutes, 1)} min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `in ${hours} h`;
  }
  return `on ${new Date(until).toLocaleDateString()}`;
}

/** What the page compares to tell that a sign-in finished. */
function signInState(server: McpServerView): string {
  return JSON.stringify([server.status, server.authorization]);
}

/**
 * A blank tab for a sign-in, cut off from this page: the authorization
 * server's pages must not be able to reach it through `window.opener`.
 */
function openSignInTab(): Window | null {
  const tab = window.open("", "_blank");
  if (tab !== null) {
    tab.opener = null;
  }
  return tab;
}

function toolCountText(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

// Cards follow the stock Agent presets grid: two columns when they fit.
const gridStyle: CSSProperties = {
  ...listStyle,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(268px, 1fr))",
  gap: 12,
};

const cardBodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  flex: 1,
  minWidth: 0,
  padding: "14px 16px 12px",
};

const cardNameStyle: CSSProperties = {
  ...monoStyle,
  margin: 0,
  fontFamily: "inherit",
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.4,
};

const cardErrorStyle: CSSProperties = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 3,
  overflow: "hidden",
  overflowWrap: "anywhere",
  marginTop: 4,
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--dsw-alias-state-error-primary)",
};

const cardFootStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  minHeight: 40,
  boxSizing: "border-box",
  padding: "6px 10px 6px 16px",
  borderTop: "0.5px solid var(--dsw-alias-border-l2)",
  justifyContent: "flex-end",
};
