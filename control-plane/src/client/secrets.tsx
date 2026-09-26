import { useEffect, useState, type FormEvent } from "react";

import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";

import type { SecretSettingsView } from "../secrets-remote.js";
import { GLOBAL_SCOPE, ScopeSelector } from "./scope-selector.js";

interface SecretsActions {
  getSecrets: () => Promise<SecretSettingsView>;
  setGlobalSecret: (name: string, value: string) => Promise<SecretSettingsView>;
  setWorkspaceSecret: (
    repositoryUrl: string,
    name: string,
    value: string,
  ) => Promise<SecretSettingsView>;
  deleteGlobalSecret: (name: string) => Promise<SecretSettingsView>;
  deleteWorkspaceSecret: (
    repositoryUrl: string,
    name: string,
  ) => Promise<SecretSettingsView>;
}

interface SecretsSettingsProps
  extends SettingsSectionOwnerProps,
    SecretsActions {}

/**
 * Settings page for the host credential broker, one scope at a time. Values
 * are write-only: saving one stores it, and nothing reads it back.
 */
export function SecretsSettings({
  getSecrets,
  setGlobalSecret,
  setWorkspaceSecret,
  deleteGlobalSecret,
  deleteWorkspaceSecret,
}: SecretsSettingsProps) {
  const [settings, setSettings] = useState<SecretSettingsView>();
  const [scope, setScope] = useState(GLOBAL_SCOPE);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    getSecrets().then(setSettings, (reason) => setError(describe(reason)));
  }, [getSecrets]);

  const names =
    scope === GLOBAL_SCOPE
      ? (settings?.global ?? [])
      : (settings?.workspaces.find(
          (workspace) => workspace.repositoryUrl === scope,
        )?.names ?? []);
  const globalNames = new Set(settings?.global ?? []);

  const run = async (
    action: () => Promise<SecretSettingsView>,
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
    const trimmed = name.trim();
    if (pending || trimmed === "" || value === "") {
      return;
    }
    const saved =
      scope === GLOBAL_SCOPE
        ? await run(() => setGlobalSecret(trimmed, value))
        : await run(() => setWorkspaceSecret(scope, trimmed, value));
    if (saved) {
      setName("");
      setValue("");
    }
  };

  const remove = (secretName: string) =>
    scope === GLOBAL_SCOPE
      ? run(() => deleteGlobalSecret(secretName))
      : run(() => deleteWorkspaceSecret(scope, secretName));

  return (
    <section style={{ maxWidth: 760, color: "var(--dsh-alias-label-primary)" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>Secrets</h2>
      <p
        style={{
          margin: "0 0 24px",
          color: "var(--dsw-alias-label-secondary)",
          lineHeight: 1.5,
        }}
      >
        Environment variables injected into sandbox commands. Global secrets
        reach every sandbox; workspace secrets reach that workspace's sandboxes
        and override a global secret of the same name. Values are write-only:
        saving one stores it, and nothing reads it back.
      </p>

      {settings === undefined && error === undefined ? (
        <p style={{ margin: 0, color: "var(--dsw-alias-label-secondary)" }}>
          Loading…
        </p>
      ) : null}

      {settings !== undefined ? (
        <>
          <label
            htmlFor="dsh-yawn-secrets-scope"
            style={{ display: "block", marginBottom: 8, fontWeight: 500 }}
          >
            Scope
          </label>
          <ScopeSelector
            id="dsh-yawn-secrets-scope"
            workspaces={settings.workspaces}
            scope={scope}
            disabled={pending}
            onScopeChange={(nextScope) => {
              setScope(nextScope);
              setError(undefined);
            }}
          />

          {names.length === 0 ? (
            <p
              style={{
                margin: "16px 0 0",
                color: "var(--dsw-alias-label-secondary)",
              }}
            >
              No secrets in this scope.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: "16px 0 0", padding: 0 }}>
              {names.map((secretName) => (
                <li
                  key={secretName}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "4px 0",
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <code>{secretName}</code>
                    {scope !== GLOBAL_SCOPE && globalNames.has(secretName) ? (
                      <span
                        style={{
                          marginLeft: 8,
                          color: "var(--dsw-alias-label-tertiary)",
                          fontSize: 13,
                        }}
                      >
                        overrides global
                      </span>
                    ) : null}
                  </span>
                  <Button
                    type="button"
                    disabled={pending}
                    onClick={() => remove(secretName)}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <form
            onSubmit={submit}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              marginTop: 16,
            }}
          >
            <Input
              aria-label="Secret name"
              placeholder="NAME"
              value={name}
              disabled={pending}
              onChange={(event) => setName(event.currentTarget.value)}
              style={{ width: "100%" }}
            />
            <Input
              aria-label="Secret value"
              type="password"
              placeholder="value"
              autoComplete="off"
              value={value}
              disabled={pending}
              onChange={(event) => setValue(event.currentTarget.value)}
              style={{ width: "100%" }}
            />
            <Button
              type="submit"
              variant="primary"
              disabled={pending || name.trim() === "" || value === ""}
              style={{ alignSelf: "flex-end" }}
            >
              Save to this scope
            </Button>
          </form>
        </>
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
        A secret named <code>GITHUB_TOKEN</code> also serves as the Git
        credential for github.com repositories; a workspace-scoped one serves
        that workspace's clones. A change applies before the session's next
        command, running sessions included. Sandbox code can read injected
        secrets, which is their purpose — scoping limits which sandbox receives
        a value, nothing more.
      </p>
    </section>
  );
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
