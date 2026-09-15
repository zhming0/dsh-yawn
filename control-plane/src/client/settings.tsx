import { useEffect, useState } from "react";

import { Button, Tag } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { SettingsNamespaceView } from "@deepseek-ai/dsh-api-remotes/client";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

import { defaultBuildkiteTokenCredential } from "../buildkite-credential.js";
import { DefaultsCard } from "./settings-defaults.js";
import { ProfileForm } from "./settings-form.js";
import {
  cardStyle,
  describeError,
  sectionHeadingStyle,
  stringFields,
  type ProfileDraft,
  type RuntimeWire,
  type SandboxesSettingsActions,
} from "./settings-shared.js";

/** The `sandbox-manager` namespace this page edits. */
const NS = "sandbox-manager";

type SandboxesSettingsProps = SettingsSectionOwnerProps &
  SandboxesSettingsActions;

/**
 * Settings page for sandbox profiles and lifecycle timers. Reads the layered
 * view the settings service serves — deployment base, user overrides, resolved
 * value — and writes only the user layer, so everything the deployment
 * configures stays one reset away and edits apply on the host without a
 * restart.
 */
export function SandboxesSettings({
  describeSettings,
  updateSettings,
  mutateSettings,
  replaceSettings,
  describeCredentials,
  setCredential,
  unsetCredential,
}: SandboxesSettingsProps) {
  const [view, setView] = useState<SettingsNamespaceView>();
  const [writable, setWritable] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState(false);
  /** The profile being created or edited; undefined closes the form. */
  const [editing, setEditing] = useState<{
    draft: ProfileDraft;
    seq: number;
  }>();
  /** Open the form on one profile; the sequence remounts it if it is already open. */
  const openEditor = (draft: ProfileDraft) =>
    setEditing((current) => ({ draft, seq: (current?.seq ?? 0) + 1 }));

  useEffect(() => {
    let cancelled = false;
    describeSettings()
      .then((described) => {
        if (cancelled) {
          return;
        }
        setWritable(described.writable);
        const found = described.namespaces.find((entry) => entry.ns === NS);
        if (found === undefined) {
          setError("the host did not register its sandbox-manager settings");
          return;
        }
        setView(found);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(describeError(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [describeSettings]);

  const write = async (
    action: (revision: number | undefined) => Promise<SettingsNamespaceView>,
  ): Promise<SettingsNamespaceView | undefined> => {
    if (view === undefined || pending) {
      return undefined;
    }
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await action(view.revision);
      setView(next);
      return next;
    } catch (reason) {
      setError(describeError(reason));
      // The revision may have moved under us (a concurrent editor, or a
      // direct edit of the settings document): re-read so the page shows
      // what actually landed.
      describeSettings()
        .then((described) => {
          const found = described.namespaces.find((entry) => entry.ns === NS);
          if (found !== undefined) {
            setView(found);
          }
        })
        .catch(() => {});
      return undefined;
    } finally {
      setPending(false);
    }
  };

  const value = (view?.value ?? {}) as RuntimeWire;
  const user = (view?.user ?? {}) as RuntimeWire;
  const profiles = value.profiles ?? {};
  const profileNames = Object.keys(profiles).sort();

  /**
   * Write the profile first, then the token under the name derived from it.
   * The credential document is host-side, never pushed into a sandbox. A
   * failed write keeps the form open with what the operator typed.
   */
  const saveProfile = async (
    name: string,
    profile: Record<string, JsonValue>,
    token: string,
  ): Promise<boolean> => {
    const saved = await write((revision) =>
      mutateSettings(
        NS,
        [{ op: "set", path: ["profiles", name], value: profile }],
        revision,
      ),
    );
    if (saved === undefined) {
      return false;
    }
    if (profile.backend === "buildkite" && token !== "") {
      setPending(true);
      try {
        await setCredential(defaultBuildkiteTokenCredential(name), token);
      } catch (reason) {
        // The profile itself is saved; keep the form open with the typed
        // token so Save retries only the credential write.
        setError(
          `the profile was saved, but the token could not be stored: ${describeError(reason)}`,
        );
        return false;
      } finally {
        setPending(false);
      }
    }
    setNotice(`saved profile ${name}`);
    setEditing(undefined);
    return true;
  };

  const clearStoredToken = async (name: string): Promise<boolean> => {
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await unsetCredential(defaultBuildkiteTokenCredential(name));
      setNotice(`cleared the stored token for ${name}`);
      return true;
    } catch (reason) {
      setError(describeError(reason));
      return false;
    } finally {
      setPending(false);
    }
  };

  const removeProfile = (name: string) => {
    void write((revision) =>
      mutateSettings(NS, [{ op: "unset", path: ["profiles", name] }], revision),
    ).then((removed) => {
      if (removed) {
        setNotice(`removed profile ${name}`);
      }
    });
  };

  const setTimer = (key: "idleMs" | "expiresAfterMs", valueMs: number) => {
    void write((revision) =>
      updateSettings(NS, { [key]: valueMs }, revision),
    ).then((saved) => {
      if (saved) {
        setNotice("saved");
      }
    });
  };

  const unsetField = (path: string[], note: string) => {
    void write((revision) =>
      mutateSettings(NS, [{ op: "unset", path }], revision),
    ).then((done) => {
      if (done) {
        setNotice(note);
      }
    });
  };

  const setDefaultProfile = (name: string) => {
    void write((revision) =>
      updateSettings(NS, { defaultProfile: name }, revision),
    ).then((saved) => {
      if (saved) {
        setNotice("saved the default profile");
      }
    });
  };

  const anyOverride =
    user.profiles !== undefined ||
    user.defaultProfile !== undefined ||
    user.idleMs !== undefined ||
    user.expiresAfterMs !== undefined;

  return (
    <section style={{ maxWidth: 760, color: "var(--dsw-alias-label-primary)" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>Sandboxes</h2>
      <p
        style={{
          margin: "0 0 24px",
          color: "var(--dsw-alias-label-secondary)",
          lineHeight: 1.5,
        }}
      >
        Sandbox profiles and lifecycle timers. Changes apply on the host without
        a restart; sessions that already have a sandbox keep it. Fields the
        deployment configures are marked <em>deployment</em>, and a reset
        returns to them.
      </p>

      {view === undefined && error === undefined ? (
        <p style={{ margin: 0, color: "var(--dsw-alias-label-secondary)" }}>
          Loading…
        </p>
      ) : null}

      {view !== undefined ? (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              margin: "0 0 12px",
            }}
          >
            <h3 style={{ ...sectionHeadingStyle, margin: 0 }}>Profiles</h3>
            {editing === undefined ? (
              <Button
                type="button"
                size="sm"
                variant="primary"
                disabled={pending || !writable}
                onClick={() =>
                  openEditor({ name: "", backend: "docker", fields: {} })
                }
              >
                New profile
              </Button>
            ) : null}
          </div>

          {profileNames.length === 0 ? (
            <p
              style={{
                ...cardStyle,
                margin: 0,
                color: "var(--dsw-alias-label-secondary)",
              }}
            >
              No sandbox profiles yet. Add one below, or the first message of a
              session cannot start a sandbox.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {profileNames.map((name) => {
                const profile = profiles[name];
                const backend =
                  typeof profile?.backend === "string" ? profile.backend : "";
                const custom = user.profiles?.[name] !== undefined;
                const fields = stringFields(profile);
                const summary = Object.entries(fields)
                  .map(([key, entry]) => `${key}: ${entry}`)
                  .join(", ");
                return (
                  <div key={name} style={cardStyle}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          flexWrap: "wrap",
                          minWidth: 0,
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{name}</span>
                        <Tag tone="neutral">{backend}</Tag>
                        <Tag tone={custom ? "info" : "quiet"}>
                          {custom ? "custom" : "deployment"}
                        </Tag>
                        {value.defaultProfile === name ? (
                          <Tag tone="outline">default</Tag>
                        ) : null}
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pending || !writable}
                          onClick={() =>
                            openEditor({
                              name,
                              backend: backend === "" ? "docker" : backend,
                              fields: { ...fields },
                            })
                          }
                        >
                          Edit
                        </Button>
                        {custom ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={pending || !writable}
                            onClick={() => removeProfile(name)}
                          >
                            Reset
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {summary !== "" ? (
                      <div
                        style={{
                          marginTop: 6,
                          color: "var(--dsw-alias-label-secondary)",
                          fontSize: 13,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {summary}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {editing !== undefined ? (
            <ProfileForm
              key={editing.seq}
              initial={editing.draft}
              profileNames={profileNames}
              writable={writable}
              pending={pending}
              describeCredentials={describeCredentials}
              onSubmit={saveProfile}
              onClearToken={clearStoredToken}
              onCancel={() => setEditing(undefined)}
            />
          ) : null}

          <DefaultsCard
            resolved={value}
            overrides={user}
            profileNames={profileNames}
            writable={writable}
            pending={pending}
            onSetDefault={setDefaultProfile}
            onUnset={unsetField}
            onSetTimer={setTimer}
          />

          {anyOverride ? (
            <p style={{ margin: "16px 0 0" }}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending || !writable}
                onClick={() =>
                  void write((revision) =>
                    replaceSettings(NS, {}, revision),
                  ).then((done) => {
                    if (done) {
                      setNotice(
                        "returned every field to the deployment settings",
                      );
                    }
                  })
                }
              >
                Reset everything to deployment settings
              </Button>
            </p>
          ) : null}
        </>
      ) : null}

      {notice !== undefined ? (
        <p
          role="status"
          style={{
            margin: "12px 0 0",
            color: "var(--dsw-alias-state-success-primary)",
          }}
        >
          {notice}
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
          margin: "28px 0 0",
          color: "var(--dsw-alias-label-secondary)",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        Profiles are layered over the deployment's configuration: a reset
        returns a field to what the chart or the settings file configures. The
        settings document is <code>$DSH_HOME/settings.yaml</code>, editable by
        hand and hot-reloaded.
      </p>
    </section>
  );
}
