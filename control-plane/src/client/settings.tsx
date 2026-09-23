import { useEffect, useState } from "react";

import { Button, Tag } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

import { defaultBuildkiteTokenCredential } from "../buildkite-credential.js";
import type { SandboxSettingsView } from "../sandbox-settings-remote.js";
import { RegistrationTokenCard } from "./registration-token.js";
import { DefaultsCard } from "./settings-defaults.js";
import { ProfileForm } from "./settings-form.js";
import {
  cardStyle,
  describeError,
  sectionHeadingStyle,
  type ProfileDraft,
  type RegistrationTokenActions,
  type SandboxesSettingsActions,
} from "./settings-shared.js";

/** The `sandbox-manager` namespace this page edits. */
const NS = "sandbox-manager";

type SandboxesSettingsProps = SettingsSectionOwnerProps &
  SandboxesSettingsActions &
  RegistrationTokenActions;

/**
 * Settings page for sandbox profiles and lifecycle timers. The host sends one
 * combined view — the deployment's settings with the page's edits applied —
 * and this page only displays it and writes the page's own layer, so profiles
 * the deployment configures stay locked and every editable field stays one
 * reset away.
 */
export function SandboxesSettings({
  updateSettings,
  mutateSettings,
  replaceSettings,
  describeCredentials,
  setCredential,
  unsetCredential,
  getSandboxSettings,
  getRegistrationToken,
  rotateRegistrationToken,
  retireRegistrationToken,
}: SandboxesSettingsProps) {
  const [view, setView] = useState<SandboxSettingsView>();
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
    getSandboxSettings()
      .then((settings) => {
        if (!cancelled) {
          setView(settings);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(describeError(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [getSandboxSettings]);

  /** Re-read the host's view; callers decide what a failure means. */
  const load = async (): Promise<void> => {
    setView(await getSandboxSettings());
  };

  /**
   * Run one settings write and re-read the combined view. A write failure is
   * reported and the view is re-read anyway, because the revision may have
   * moved under us: a concurrent editor, or a direct edit of the settings
   * document.
   */
  const write = async (
    action: (revision: number) => Promise<unknown>,
  ): Promise<boolean> => {
    if (view === undefined || pending) {
      return false;
    }
    const revision = view.revision;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await action(revision);
    } catch (reason) {
      setError(describeError(reason));
      await load().catch(() => {});
      return false;
    } finally {
      setPending(false);
    }
    // The write landed; a failed re-read only leaves the last view in place.
    await load().catch(() => {});
    return true;
  };

  const profileNames = view?.profiles.map((profile) => profile.name) ?? [];
  const lockedNames = (view?.profiles ?? [])
    .filter((profile) => profile.locked)
    .map((profile) => profile.name);

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
    // Deployment profile names are reserved: the host keeps the deployment's
    // definition for them, so a page entry under one would never apply.
    if (lockedNames.includes(name)) {
      setError(
        `profile ${name} is configured by the deployment; pick another name`,
      );
      return false;
    }
    const saved = await write((revision) =>
      mutateSettings(
        NS,
        [{ op: "set", path: ["profiles", name], value: profile }],
        revision,
      ),
    );
    if (!saved) {
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

  const writable = view?.writable ?? false;
  const anyOverride =
    view !== undefined &&
    (view.overridden.defaultProfile ||
      view.overridden.idleMs ||
      view.overridden.expiresAfterMs ||
      view.profiles.some((profile) => !profile.locked));

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
        a restart; sessions that already have a sandbox keep it. Profiles the
        deployment configures are locked, and a reset returns every field to the
        deployment's value.
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

          {view.profiles.length === 0 ? (
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
              {view.profiles.map((profile) => {
                const summary = Object.entries(profile.fields)
                  .map(([key, entry]) => `${key}: ${entry}`)
                  .join(", ");
                return (
                  <div key={profile.name} style={cardStyle}>
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
                        <span style={{ fontWeight: 600 }}>{profile.name}</span>
                        <Tag tone="neutral">{profile.backend}</Tag>
                        <Tag tone={profile.locked ? "quiet" : "info"}>
                          {profile.locked ? "deployment" : "custom"}
                        </Tag>
                        {view.defaultProfile === profile.name ? (
                          <Tag tone="outline">default</Tag>
                        ) : null}
                      </div>
                      {profile.locked ? null : (
                        <div style={{ display: "flex", gap: 6 }}>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={pending || !writable}
                            onClick={() =>
                              openEditor({
                                name: profile.name,
                                backend: profile.backend,
                                fields: { ...profile.fields },
                              })
                            }
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={pending || !writable}
                            onClick={() => removeProfile(profile.name)}
                          >
                            Reset
                          </Button>
                        </div>
                      )}
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
            {...(view.defaultProfile === undefined
              ? {}
              : { defaultProfile: view.defaultProfile })}
            idleMs={view.idleMs}
            expiresAfterMs={view.expiresAfterMs}
            overridden={view.overridden}
            profileNames={profileNames}
            writable={writable}
            pending={pending}
            onSetDefault={setDefaultProfile}
            onUnset={unsetField}
            onSetTimer={setTimer}
          />

          <RegistrationTokenCard
            getRegistrationToken={getRegistrationToken}
            rotateRegistrationToken={rotateRegistrationToken}
            retireRegistrationToken={retireRegistrationToken}
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
        Deployment profiles come from{" "}
        <code>/etc/dsh-yawn/sandbox-settings.yaml</code> and are locked here;
        this page can add its own profiles and change the default and timers.
        Edits persist into the profile patch,{" "}
        <code>$DSH_HOME/profiles/web/cordis.patch.yml</code>, which is also
        editable by hand.
      </p>
    </section>
  );
}
