import { useEffect, useState } from "react";

import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

import type { SandboxSettingsView } from "../../sandbox/sandbox-settings-remote.js";
import { DefaultsCard } from "./settings-defaults.js";
import { ProfileForm } from "./settings-form.js";
import { ProfileCard } from "./settings-profile-card.js";
import {
  cardStyle,
  describeError,
  effectiveTokenCredential,
  type TimerKey,
  sectionHeadingStyle,
  type ProfileDraft,
  type SandboxesSettingsActions,
  profileRemoveOps,
  profileSaveOps,
  profileWithTokenCredential,
  tokenCredentialOwner,
} from "./settings-shared.js";

/** The `sandbox-manager` namespace this page edits. */
const NS = "sandbox-manager";

type SandboxesSettingsProps = SettingsSectionOwnerProps &
  SandboxesSettingsActions;

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
}: SandboxesSettingsProps) {
  const [view, setView] = useState<SandboxSettingsView>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState(false);
  /** The profile being created or edited; undefined closes the form. */
  const [editing, setEditing] = useState<{
    draft: ProfileDraft;
    /** The name it was opened under, absent for a new profile. */
    originalName?: string;
    /** The backend it was opened under, so a rename keeps its token. */
    originalBackend?: string;
    seq: number;
  }>();
  /** The profile whose delete confirmation is open. */
  const [confirming, setConfirming] = useState<string>();
  /** Open the form on one profile; the sequence remounts it if it is already open. */
  const openEditor = (
    draft: ProfileDraft,
    originalName?: string,
    originalBackend?: string,
  ) => {
    setConfirming(undefined);
    setEditing((current) => ({
      draft,
      ...(originalName === undefined ? {} : { originalName }),
      ...(originalBackend === undefined ? {} : { originalBackend }),
      seq: (current?.seq ?? 0) + 1,
    }));
  };

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
   * Write the profile, then any token typed into the form. The credential
   * document is host-side, never pushed into a sandbox. A rename is one write
   * that removes the old name, so the page never shows both; it also pins the
   * profile's existing credential reference, which keeps the stored token
   * where it is.
   */
  const saveProfile = async (
    name: string,
    profile: Record<string, JsonValue>,
    token: string,
    originalName?: string,
    originalBackend?: string,
  ): Promise<boolean> => {
    const renamed = originalName !== undefined && originalName !== name;
    // Deployment profile names are reserved: the host keeps the deployment's
    // definition for them, so a page entry under one would never apply.
    if (lockedNames.includes(name)) {
      setError(
        `profile ${name} is configured by the deployment; pick another name`,
      );
      return false;
    }
    if (name !== originalName && profileNames.includes(name)) {
      setError(`profile ${name} already exists; pick another name`);
      return false;
    }
    const savedProfile = profileWithTokenCredential(
      profile,
      name,
      originalName,
      originalBackend,
    );
    const savedBackend =
      typeof savedProfile.backend === "string" ? savedProfile.backend : "";
    const savedRef = effectiveTokenCredential(
      name,
      savedBackend,
      typeof savedProfile.tokenCredential === "string"
        ? savedProfile.tokenCredential
        : undefined,
    );
    const originalRef =
      originalName === undefined
        ? undefined
        : effectiveTokenCredential(
            originalName,
            originalBackend ?? "",
            typeof editing?.draft.fields.tokenCredential === "string"
              ? editing.draft.fields.tokenCredential
              : undefined,
          );
    if (savedRef !== undefined && savedRef !== originalRef) {
      const taken = tokenCredentialOwner(view?.profiles ?? [], name, savedRef);
      if (taken !== undefined) {
        setError(
          `profile ${taken} already uses the API token credential ${savedRef}; pick another credential`,
        );
        return false;
      }
    }
    const saved = await write((revision) =>
      mutateSettings(
        NS,
        profileSaveOps(
          name,
          savedProfile,
          originalName,
          renamed && view?.defaultProfile === originalName,
        ),
        revision,
      ),
    );
    if (!saved) {
      return false;
    }
    // A rename is already written. Close the form before touching the
    // credential, so a credential failure cannot leave it editing a name that
    // now exists; the operator fixes the token on the renamed profile.
    if (renamed && originalName !== undefined) {
      setEditing(undefined);
    }
    let tokenError: string | undefined;
    if (token !== "" && savedRef !== undefined) {
      setPending(true);
      try {
        await setCredential(savedRef, token);
      } catch (reason) {
        const message = renamed
          ? `the profile was renamed, but its token could not be stored: ${describeError(reason)}`
          : `the profile was saved, but the token could not be stored: ${describeError(reason)}`;
        if (!renamed) {
          // The profile itself is saved; keep the form open with the typed
          // token so Save retries only the credential write.
          setError(message);
          return false;
        }
        tokenError = message;
      } finally {
        setPending(false);
      }
    }
    if (renamed && originalName !== undefined) {
      if (tokenError !== undefined) {
        setError(tokenError);
      } else {
        setNotice(`renamed profile ${originalName} to ${name}`);
      }
      return true;
    }
    setNotice(`saved profile ${name}`);
    setEditing(undefined);
    return true;
  };

  const clearStoredToken = async (ref: string): Promise<boolean> => {
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await unsetCredential(ref);
      setNotice("cleared the stored token");
      return true;
    } catch (reason) {
      setError(describeError(reason));
      return false;
    } finally {
      setPending(false);
    }
  };

  const removeProfile = (name: string) => {
    const target = view?.profiles.find((profile) => profile.name === name);
    const tokenRef =
      target === undefined
        ? undefined
        : effectiveTokenCredential(
            target.name,
            target.backend,
            target.fields.tokenCredential,
          );
    // Another profile may point at the same credential reference, either
    // because an old profile named one explicitly or because two names derive
    // the same string. Removing the shared token would break that profile.
    const shared =
      tokenRef !== undefined &&
      tokenCredentialOwner(view?.profiles ?? [], name, tokenRef) !== undefined;
    const clearDefault =
      view?.overridden.defaultProfile === true && view.defaultProfile === name;
    void write((revision) =>
      mutateSettings(NS, profileRemoveOps(name, clearDefault), revision),
    ).then(async (removed) => {
      if (!removed) {
        return;
      }
      setConfirming(undefined);
      if (tokenRef === undefined || shared) {
        setNotice(
          shared
            ? `removed profile ${name}; kept the shared API token`
            : `removed profile ${name}`,
        );
        return;
      }
      setPending(true);
      try {
        // A profile owns the credential named after it; removing the profile
        // must not leave that secret behind for a future profile to inherit.
        await unsetCredential(tokenRef);
        setNotice(`removed profile ${name}`);
      } catch (reason) {
        setError(
          `the profile was removed, but its stored token could not be removed: ${describeError(reason)}`,
        );
      } finally {
        setPending(false);
      }
    });
  };

  const setTimer = (key: TimerKey, valueMs: number) => {
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
      view.overridden.readyTimeoutMs ||
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
        deployment configures are locked; profiles added here can be edited,
        renamed, or deleted. A rename keeps a Buildkite profile's stored token.
        A reset on a timer or the default profile returns it to the deployment's
        value.
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
              {view.profiles.map((profile) => (
                <ProfileCard
                  key={profile.name}
                  profile={profile}
                  isDefault={view.defaultProfile === profile.name}
                  confirming={confirming === profile.name}
                  disabled={pending || !writable}
                  onEdit={() =>
                    openEditor(
                      {
                        name: profile.name,
                        backend: profile.backend,
                        fields: { ...profile.fields },
                      },
                      profile.name,
                      profile.backend,
                    )
                  }
                  onDelete={() => setConfirming(profile.name)}
                  onCancelDelete={() => setConfirming(undefined)}
                  onConfirmDelete={() => removeProfile(profile.name)}
                />
              ))}
            </div>
          )}

          {editing !== undefined ? (
            <ProfileForm
              key={editing.seq}
              initial={editing.draft}
              {...(editing.originalName === undefined
                ? {}
                : { originalName: editing.originalName })}
              {...(editing.originalBackend === undefined
                ? {}
                : { originalBackend: editing.originalBackend })}
              writable={writable}
              pending={pending}
              describeCredentials={describeCredentials}
              onSubmit={(name, profile, token) =>
                saveProfile(
                  name,
                  profile,
                  token,
                  editing.originalName,
                  editing.originalBackend,
                )
              }
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
            {...(view.readyTimeoutMs === undefined
              ? {}
              : { readyTimeoutMs: view.readyTimeoutMs })}
            overridden={view.overridden}
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
        Deployment profiles come from{" "}
        <code>/etc/dsh-yawn/sandbox-settings.yaml</code> and are locked here;
        this page can add, edit, rename, and delete its own profiles and change
        the default and timers. Edits persist into the profile patch,{" "}
        <code>$DSH_HOME/profiles/web/cordis.patch.yml</code>, which is also
        editable by hand.
      </p>
    </section>
  );
}
