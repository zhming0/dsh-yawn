import { useEffect, useState, type FormEvent } from "react";

import { Button, Input, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";

import type { McpServerView, McpSettingsView } from "../mcp-remote.js";
import type { McpServerEntry } from "../mcp-store.js";
import { GLOBAL_SCOPE, ScopeSelector } from "./scope-selector.js";

interface McpActions {
  listMcpServers: () => Promise<McpSettingsView>;
  setGlobalMcpServer: (entry: McpServerEntry) => Promise<McpSettingsView>;
  setWorkspaceMcpServer: (
    repositoryUrl: string,
    entry: McpServerEntry,
  ) => Promise<McpSettingsView>;
  deleteGlobalMcpServer: (serverName: string) => Promise<McpSettingsView>;
  deleteWorkspaceMcpServer: (
    repositoryUrl: string,
    serverName: string,
  ) => Promise<McpSettingsView>;
  retryMcpServer: (serverName: string) => Promise<McpSettingsView>;
  testMcpServer: (
    entry: McpServerEntry,
  ) => Promise<{ ok: boolean; toolCount: number; error?: string }>;
}

interface McpSettingsProps extends SettingsSectionOwnerProps, McpActions {}

/**
 * Settings page for remote Streamable HTTP MCP servers, one scope at a time.
 * Tokens are write-only.
 */
export function McpSettings({
  listMcpServers,
  setGlobalMcpServer,
  setWorkspaceMcpServer,
  deleteGlobalMcpServer,
  deleteWorkspaceMcpServer,
  retryMcpServer,
  testMcpServer,
}: McpSettingsProps) {
  const [settings, setSettings] = useState<McpSettingsView>();
  const [scope, setScope] = useState(GLOBAL_SCOPE);
  const [editing, setEditing] = useState<string>();
  const [serverName, setServerName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    listMcpServers().then(setSettings, (reason) => setError(describe(reason)));
  }, [listMcpServers]);

  // A mount settles asynchronously, so a row that is still starting is re-read
  // until it reaches a terminal state; otherwise a freshly saved server would
  // sit on "starting" until the page was reopened.
  const starting = settings?.servers.some(
    (server) => server.status === "starting",
  );
  useEffect(() => {
    if (starting !== true) {
      return;
    }
    const timer = setInterval(() => {
      listMcpServers().then(setSettings, (reason) =>
        setError(describe(reason)),
      );
    }, 1_500);
    return () => clearInterval(timer);
  }, [starting, listMcpServers]);

  const inScope = (server: McpServerView): boolean =>
    scope === GLOBAL_SCOPE
      ? server.scope === "global"
      : server.scope === "workspace" && server.repositoryUrl === scope;
  const servers = (settings?.servers ?? []).filter(inScope);

  const edited = (settings?.servers ?? []).find(
    (server) => server.serverName === editing,
  );

  const draft = (): McpServerEntry | undefined => {
    const name = serverName.trim();
    const endpoint = url.trim();
    if (name === "" || endpoint === "") {
      return undefined;
    }
    const entry: McpServerEntry = { serverName: name, url: endpoint, enabled };
    // Blank means "keep the saved token"; the host applies the same rule.
    // Clearing is the one case that sends an explicit null.
    if (clearToken) {
      return { ...entry, token: null };
    }
    return token === "" ? entry : { ...entry, token };
  };

  const reset = () => {
    setEditing(undefined);
    setServerName("");
    setUrl("");
    setToken("");
    setClearToken(false);
    setEnabled(true);
    setTestResult(undefined);
  };

  const run = async (
    action: () => Promise<McpSettingsView>,
  ): Promise<boolean> => {
    setPending(true);
    setError(undefined);
    try {
      setSettings(await action());
      return true;
    } catch (reason) {
      setError(describe(reason));
      return false;
    } finally {
      setPending(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const entry = draft();
    if (pending || entry === undefined) {
      return;
    }
    setTestResult(undefined);
    const saved =
      scope === GLOBAL_SCOPE
        ? await run(() => setGlobalMcpServer(entry))
        : await run(() => setWorkspaceMcpServer(scope, entry));
    if (saved) {
      reset();
    }
  };

  const test = async () => {
    const entry = draft();
    if (pending || entry === undefined) {
      return;
    }
    setPending(true);
    setError(undefined);
    setTestResult(undefined);
    try {
      const result = await testMcpServer(entry);
      setTestResult(
        result.ok
          ? {
              ok: true,
              text: `Connected: ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}.`,
            }
          : { ok: false, text: `Failed: ${result.error ?? "unknown error"}` },
      );
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setPending(false);
    }
  };

  const edit = (server: McpServerView) => {
    setEditing(server.serverName);
    setServerName(server.serverName);
    setUrl(server.url);
    setToken("");
    setClearToken(false);
    setEnabled(server.enabled);
    setTestResult(undefined);
    setError(undefined);
  };

  const remove = async (name: string) => {
    const removed =
      scope === GLOBAL_SCOPE
        ? await run(() => deleteGlobalMcpServer(name))
        : await run(() => deleteWorkspaceMcpServer(scope, name));
    if (removed && editing === name) {
      reset();
    }
  };

  const retry = (name: string) => run(() => retryMcpServer(name));

  return (
    <section style={{ maxWidth: 760, color: "var(--dsw-alias-label-primary)" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>MCP</h2>
      <p
        style={{
          margin: "0 0 24px",
          color: "var(--dsw-alias-label-secondary)",
          lineHeight: 1.5,
        }}
      >
        Remote MCP servers reached over Streamable HTTP. Each server's tools
        join the model's tool list as <code>mcp__name__tool</code>. A token is
        sent as an <code>Authorization: Bearer</code> header, stored write-only
        on the host, and never shown again. Global servers reach every session;
        workspace servers reach that workspace's sessions only. Changes apply to
        new tool calls without restarting the host.
      </p>

      {settings === undefined && error === undefined ? (
        <p style={{ margin: 0, color: "var(--dsw-alias-label-secondary)" }}>
          Loading…
        </p>
      ) : null}

      {settings !== undefined ? (
        <>
          <label
            htmlFor="dsh-yawn-mcp-scope"
            style={{ display: "block", marginBottom: 8, fontWeight: 500 }}
          >
            Scope
          </label>
          <ScopeSelector
            id="dsh-yawn-mcp-scope"
            workspaces={settings.workspaces}
            scope={scope}
            disabled={pending}
            onScopeChange={(nextScope) => {
              setScope(nextScope);
              reset();
              setError(undefined);
            }}
          />

          {servers.length === 0 ? (
            <p
              style={{
                margin: "16px 0 0",
                color: "var(--dsw-alias-label-secondary)",
              }}
            >
              No MCP servers in this scope.
            </p>
          ) : null}
          {servers.length > 0 ? (
            <ul
              style={{
                listStyle: "none",
                margin: "16px 0 0",
                padding: 0,
              }}
            >
              {servers.map((server) => (
                <li
                  key={server.serverName}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "10px 0",
                    borderTop: "1px solid var(--dsw-alias-border-l2)",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "baseline",
                      }}
                    >
                      <code>{server.serverName}</code>
                      <span
                        style={{
                          color: statusColor(server.status),
                          fontSize: 13,
                        }}
                      >
                        {statusText(server)}
                      </span>
                    </div>
                    <div
                      style={{
                        marginTop: 2,
                        color: "var(--dsw-alias-label-tertiary)",
                        fontSize: 13,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {server.url}
                      {" · "}
                      {server.hasToken ? "token saved" : "no token"}
                    </div>
                    {server.error !== undefined ? (
                      <div
                        style={{
                          marginTop: 2,
                          color: "var(--dsw-alias-state-error-primary)",
                          fontSize: 13,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {server.error}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    {server.status === "error" ? (
                      <Button
                        type="button"
                        disabled={pending}
                        onClick={() => retry(server.serverName)}
                      >
                        Retry
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      disabled={pending}
                      onClick={() => edit(server)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      disabled={pending}
                      onClick={() => remove(server.serverName)}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          <form
            onSubmit={submit}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              marginTop: 20,
            }}
          >
            <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>
              {editing === undefined
                ? `Add server to ${scope === GLOBAL_SCOPE ? "global scope" : "this workspace"}`
                : `Edit ${editing}`}
            </h3>
            <Input
              aria-label="MCP server name"
              placeholder="serverName"
              value={serverName}
              disabled={pending || editing !== undefined}
              onChange={(event) => {
                setServerName(event.currentTarget.value);
                setTestResult(undefined);
              }}
              style={{ width: "100%" }}
            />
            <Input
              aria-label="MCP server URL"
              placeholder="https://example.com/mcp"
              value={url}
              disabled={pending}
              onChange={(event) => {
                setUrl(event.currentTarget.value);
                setTestResult(undefined);
              }}
              style={{ width: "100%" }}
            />
            <Input
              aria-label="MCP bearer token"
              type="password"
              placeholder={
                clearToken
                  ? "token will be removed on save"
                  : edited?.hasToken
                    ? "a token is saved; leave blank to keep it"
                    : "token (optional)"
              }
              autoComplete="off"
              value={token}
              disabled={pending || clearToken}
              onChange={(event) => {
                setToken(event.currentTarget.value);
                setTestResult(undefined);
              }}
              style={{ width: "100%" }}
            />
            {edited?.hasToken ? (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  color: "var(--dsw-alias-label-secondary)",
                  fontSize: 13,
                }}
              >
                <input
                  type="checkbox"
                  checked={clearToken}
                  disabled={pending}
                  onChange={(event) => {
                    setClearToken(event.currentTarget.checked);
                    setToken("");
                    setTestResult(undefined);
                  }}
                />
                Remove the saved token
              </label>
            ) : null}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Switch
                checked={enabled}
                onChange={(next) => {
                  setEnabled(next);
                  setTestResult(undefined);
                }}
                label="Enabled"
                disabled={pending}
              />
              <span
                style={{
                  color: "var(--dsw-alias-label-secondary)",
                  fontSize: 13,
                }}
              >
                Enabled
              </span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 4,
              }}
            >
              <Button
                type="button"
                disabled={pending || draft() === undefined}
                onClick={test}
              >
                Test connection
              </Button>
              {editing !== undefined ? (
                <Button type="button" disabled={pending} onClick={reset}>
                  Cancel
                </Button>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                disabled={pending || draft() === undefined}
              >
                {editing === undefined ? "Add" : "Save"}
              </Button>
            </div>
          </form>
        </>
      ) : null}

      {testResult !== undefined ? (
        <p
          role="status"
          style={{
            margin: "12px 0 0",
            color: testResult.ok
              ? "var(--dsw-alias-state-success-primary)"
              : "var(--dsw-alias-state-error-primary)",
          }}
        >
          {testResult.text}
        </p>
      ) : null}

      {error !== undefined ? (
        <p
          role="alert"
          style={{
            margin: "12px 0 0",
            color: "var(--dsw-alias-state-error-primary)",
          }}
        >
          {error}
        </p>
      ) : null}

      <p
        style={{
          margin: "24px 0 0",
          color: "var(--dsw-alias-label-secondary)",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        A server name belongs to exactly one scope — global or one workspace. A
        workspace server&apos;s tools, resources, and instructions reach only
        that workspace&apos;s sessions, each of which opens its own connection
        to it. A disabled server keeps its configuration and token but connects
        nothing. <strong>Test connection</strong> probes an unsaved entry where
        no session can see it.
      </p>
    </section>
  );
}

function statusText(server: McpServerView): string {
  switch (server.status) {
    case "connected":
      return `connected · ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
    case "starting":
      return "starting…";
    case "error":
      return "error";
    case "disabled":
      return "disabled";
  }
}

function statusColor(status: McpServerView["status"]): string {
  switch (status) {
    case "connected":
      return "var(--dsw-alias-state-success-primary)";
    case "error":
      return "var(--dsw-alias-state-error-primary)";
    default:
      return "var(--dsw-alias-label-tertiary)";
  }
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
