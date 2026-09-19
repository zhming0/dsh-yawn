import { useEffect, useState, type FormEvent } from "react";

import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import type { CredentialInfo } from "@deepseek-ai/dsh-credentials/types";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

import { defaultBuildkiteTokenCredential } from "../buildkite-credential.js";
import {
  cardStyle,
  controlStyle,
  labelStyle,
  sectionHeadingStyle,
  type ProfileDraft,
  type SandboxesSettingsActions,
} from "./settings-shared.js";

const BACKENDS = ["docker", "kas", "buildkite"] as const;

/** Text inputs per backend, in display order; `number` fields parse as ints. */
const BACKEND_FIELDS: Record<
  string,
  Array<{ key: string; label: string; kind?: "number" }>
> = {
  docker: [
    { key: "image", label: "Runner image (optional)" },
    { key: "binary", label: "Docker command (optional)" },
    { key: "controlPlaneUrl", label: "Control plane URL (optional)" },
  ],
  kas: [
    { key: "namespace", label: "Namespace" },
    { key: "warmPool", label: "Warm pool" },
    { key: "readyTimeoutMs", label: "Ready timeout (ms)", kind: "number" },
    { key: "kubeconfig", label: "Kubeconfig path (optional)" },
  ],
  buildkite: [
    { key: "organization", label: "Organization" },
    { key: "pipeline", label: "Pipeline" },
    { key: "branch", label: "Branch" },
    { key: "controlPlaneUrl", label: "Control plane URL" },
    { key: "image", label: "Runner image (optional)" },
    { key: "readyTimeoutMs", label: "Ready timeout (ms)", kind: "number" },
  ],
};

export interface ProfileFormProps {
  /** The profile to edit, or a blank draft for a new one. */
  initial: ProfileDraft;
  /** Names already configured, so the heading knows whether this is an edit. */
  profileNames: string[];
  writable: boolean;
  pending: boolean;
  describeCredentials: SandboxesSettingsActions["describeCredentials"];
  /**
   * Saves the profile and its token. The page closes the form when it
   * resolves true, so a failed write keeps the draft the operator typed.
   */
  onSubmit: (
    name: string,
    profile: Record<string, JsonValue>,
    token: string,
  ) => Promise<boolean>;
  /** Clears the token stored for the profile; true when it was cleared. */
  onClearToken: (name: string) => Promise<boolean>;
  onCancel: () => void;
}

/**
 * The create-or-edit form for one sandbox profile, with the Buildkite token as
 * a write-only field. The token's credential name is derived from the profile
 * name on both sides, so nothing about credential naming reaches the form.
 */
export function ProfileForm({
  initial,
  profileNames,
  writable,
  pending,
  describeCredentials,
  onSubmit,
  onClearToken,
  onCancel,
}: ProfileFormProps) {
  const [draft, setDraft] = useState<ProfileDraft>(initial);
  /** The Buildkite token typed in this form; never read back from the host. */
  const [token, setToken] = useState("");
  const [tokenInfo, setTokenInfo] = useState<CredentialInfo>();
  const tokenRef =
    draft.backend === "buildkite"
      ? defaultBuildkiteTokenCredential(draft.name)
      : "";
  const tokenStored =
    tokenInfo?.configured === true && tokenInfo.source !== "env";

  useEffect(() => {
    if (tokenRef === "") {
      setTokenInfo(undefined);
      return;
    }
    let cancelled = false;
    describeCredentials([tokenRef])
      .then((described) => {
        if (!cancelled) {
          setTokenInfo(described[tokenRef]);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTokenInfo(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [describeCredentials, tokenRef]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const profile: Record<string, JsonValue> = { backend: draft.backend };
    for (const field of BACKEND_FIELDS[draft.backend] ?? []) {
      const raw = draft.fields[field.key]?.trim();
      if (raw === undefined || raw === "") {
        continue;
      }
      profile[field.key] =
        field.kind === "number" ? Number.parseInt(raw, 10) : raw;
    }
    void onSubmit(draft.name, profile, token);
  };

  const clearToken = async () => {
    if (tokenRef === "" || !(await onClearToken(draft.name))) {
      return;
    }
    setTokenInfo((current) =>
      current === undefined ? current : { ...current, configured: false },
    );
  };

  return (
    <form
      onSubmit={submit}
      style={{ ...cardStyle, marginTop: 12, padding: 16 }}
    >
      <h3 style={sectionHeadingStyle}>
        {profileNames.includes(draft.name) && draft.name !== ""
          ? `Edit ${draft.name}`
          : "New profile"}
      </h3>
      <label htmlFor="dsh-yawn-profile-name" style={labelStyle}>
        Name
      </label>
      <Input
        id="dsh-yawn-profile-name"
        placeholder="standard"
        value={draft.name}
        disabled={pending}
        onChange={(event) => {
          // Read the value now: the state updater runs after dispatch, when
          // currentTarget is already null.
          const name = event.currentTarget.value;
          setDraft((current) => ({ ...current, name }));
        }}
        style={{ width: "100%" }}
      />
      <label htmlFor="dsh-yawn-profile-backend" style={labelStyle}>
        Backend
      </label>
      <select
        id="dsh-yawn-profile-backend"
        value={draft.backend}
        disabled={pending}
        onChange={(event) => {
          const backend = event.currentTarget.value;
          setDraft((current) => ({ ...current, backend }));
        }}
        style={controlStyle}
      >
        {BACKENDS.map((backend) => (
          <option key={backend} value={backend}>
            {backend}
          </option>
        ))}
      </select>
      {(BACKEND_FIELDS[draft.backend] ?? []).map((field) => (
        <div key={field.key}>
          <label
            htmlFor={`dsh-yawn-profile-field-${field.key}`}
            style={labelStyle}
          >
            {field.label}
          </label>
          <Input
            id={`dsh-yawn-profile-field-${field.key}`}
            inputMode={field.kind === "number" ? "numeric" : undefined}
            value={draft.fields[field.key] ?? ""}
            disabled={pending}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({
                ...current,
                fields: { ...current.fields, [field.key]: value },
              }));
            }}
            style={{ width: "100%" }}
          />
        </div>
      ))}
      {draft.backend === "buildkite" ? (
        <div>
          <label htmlFor="dsh-yawn-buildkite-token" style={labelStyle}>
            API token
          </label>
          <Input
            id="dsh-yawn-buildkite-token"
            type="password"
            autoComplete="off"
            placeholder={
              tokenStored
                ? "stored (write-only)"
                : tokenInfo?.configured
                  ? "supplied by the environment"
                  : "paste an API token"
            }
            value={token}
            disabled={pending}
            onChange={(event) => setToken(event.currentTarget.value)}
            style={{ width: "100%" }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 6,
              color: "var(--dsw-alias-label-secondary)",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <span>
              {tokenStored
                ? "Stored write-only on the control plane for this profile. It never reaches a sandbox."
                : tokenInfo?.configured
                  ? "Currently supplied by an environment variable on the control plane."
                  : "Used for this profile's Buildkite API calls. Stored write-only on the control plane; it never reaches a sandbox."}
            </span>
            {tokenStored ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void clearToken()}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 20,
        }}
      >
        <Button type="button" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={pending || !writable || draft.name.trim() === ""}
        >
          {pending ? "Saving…" : "Save profile"}
        </Button>
      </div>
    </form>
  );
}
