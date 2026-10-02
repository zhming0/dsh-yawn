import { useEffect, useState, type CSSProperties, type FormEvent } from "react";

import {
  Button,
  Checkbox,
  Input,
  Modal,
  Switch,
  Tag,
  type TagTone,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";

import type { McpServerView, McpTestResult } from "../mcp-remote.js";
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
}

interface McpSettingsProps extends SettingsSectionOwnerProps, McpActions {}

/** The open dialog: a new server, or an existing one to edit. */
type Dialog = { kind: "add" } | { kind: "edit"; server: McpServerView };

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
}: McpSettingsProps) {
  const [servers, setServers] = useState<McpServerView[]>();
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

  /** Run one write; the caller decides where a failure shows. */
  const run = async (action: () => Promise<McpServerView[]>) => {
    setPending(true);
    try {
      setServers(await action());
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
      setMcpServer({ serverName: server.serverName, url: server.url, enabled }),
    );

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
            onSave={(entry) => run(() => setMcpServer(entry))}
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
          {server.hasToken ? "Token saved" : "No token"}
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
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setServerName(edited?.serverName ?? "");
    setUrl(edited?.url ?? "");
    setToken("");
    setClearToken(false);
    setTestResult(undefined);
    setError(undefined);
  }, [dialog, edited]);

  const busy = pending || testing;

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
      enabled: edited?.enabled ?? true,
    };
    if (clearToken) {
      return { ...entry, token: null };
    }
    return token === "" ? entry : { ...entry, token };
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
        <label htmlFor="dsh-yawn-mcp-token" style={fieldLabelStyle}>
          Bearer token
        </label>
        <Input
          id="dsh-yawn-mcp-token"
          type="password"
          autoComplete="off"
          placeholder={
            clearToken
              ? "Removed on save"
              : edited?.hasToken
                ? "Saved; leave blank to keep"
                : "Optional"
          }
          value={token}
          disabled={busy || clearToken}
          onChange={(event) =>
            change(() => setToken(event.currentTarget.value))
          }
        />
        {edited?.hasToken ? (
          <div style={{ marginTop: 8 }}>
            <Checkbox
              checked={clearToken}
              disabled={busy}
              label="Remove the saved token"
              onChange={(next) =>
                change(() => {
                  setClearToken(next);
                  setToken("");
                })
              }
            />
          </div>
        ) : null}
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
