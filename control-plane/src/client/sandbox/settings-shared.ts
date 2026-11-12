import type { CSSProperties } from "react";

import type {
  SettingsNamespaceView,
  SettingsPathOpView,
} from "@deepseek-ai/dsh-api-remotes/client";
import type { CredentialInfo } from "@deepseek-ai/dsh-credentials/types";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

import { defaultBuildkiteTokenCredential } from "../../credentials/buildkite-credential.js";
import type {
  SandboxProfileOptionView,
  SandboxSettingsView,
} from "../../sandbox/sandbox-settings-remote.js";

/** What the Sandboxes page calls on the host: settings and write-only credentials. */
export interface SandboxesSettingsActions {
  updateSettings: (
    ns: string,
    patch: Record<string, JsonValue>,
    expectedRevision: number | undefined,
  ) => Promise<SettingsNamespaceView>;
  mutateSettings: (
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ) => Promise<SettingsNamespaceView>;
  replaceSettings: (
    ns: string,
    section: Record<string, JsonValue>,
    expectedRevision: number | undefined,
  ) => Promise<SettingsNamespaceView>;
  describeCredentials: (
    refs: string[],
  ) => Promise<Record<string, CredentialInfo>>;
  setCredential: (ref: string, value: string) => Promise<void>;
  unsetCredential: (ref: string) => Promise<void>;
  /** The combined read model: deployment values with the page's edits on top. */
  getSandboxSettings: () => Promise<SandboxSettingsView>;
}

/** The top-level timers the Defaults card writes. */
export type TimerKey = "idleMs" | "expiresAfterMs" | "readyTimeoutMs";

/** One profile as the form edits it: a backend plus its scalar fields. */
export interface ProfileDraft {
  name: string;
  backend: string;
  fields: Record<string, string>;
}

/**
 * The credential reference holding a profile's API token. A profile may name
 * one explicitly, which is how a rename keeps the token it already has; a
 * Buildkite profile without one uses the name derived from its current name.
 */
export function effectiveTokenCredential(
  name: string,
  backend: string,
  tokenCredential: string | undefined,
): string | undefined {
  const explicit = tokenCredential?.trim();
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  return backend === "buildkite"
    ? defaultBuildkiteTokenCredential(name)
    : undefined;
}

/**
 * The credential reference the form may show for an existing profile. A new
 * profile has none yet: its opaque reference is assigned only when it is
 * saved, so describing the derived name could show (or clear) another
 * profile's token.
 */
export function formTokenCredential(
  originalName: string | undefined,
  tokenOwner: string,
  backend: string,
  tokenCredential: string | undefined,
): string {
  if (originalName === undefined || backend !== "buildkite") {
    return "";
  }
  return effectiveTokenCredential(tokenOwner, backend, tokenCredential) ?? "";
}

/**
 * Pin the credential name a legacy Buildkite profile already uses, so the
 * stored token keeps working without moving it. Any explicit reference wins.
 * A rename always pins; so does switching away from Buildkite, which keeps the
 * reference available if the profile switches back or is deleted.
 */
export function profileWithStableTokenCredential(
  profile: Record<string, JsonValue>,
  name: string,
  originalName: string | undefined,
  originalBackend: string | undefined,
): Record<string, JsonValue> {
  if (
    profile.tokenCredential !== undefined ||
    originalName === undefined ||
    originalBackend !== "buildkite" ||
    (originalName === name && profile.backend === "buildkite")
  ) {
    return profile;
  }
  return {
    ...profile,
    tokenCredential: defaultBuildkiteTokenCredential(originalName),
  };
}

/** A fresh, opaque credential reference for a page-created Buildkite profile. */
export function newTokenCredential(): string {
  // randomUUID needs a secure context; the control plane may be served over
  // plain HTTP on a LAN, where getRandomValues still works.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `DSH_YAWN_BUILDKITE_${id}_TOKEN`;
}

/**
 * The credential reference a save should use: an explicit one wins; a new
 * Buildkite profile gets an opaque name that no profile name can collide with;
 * a renamed legacy profile keeps the derived name it was already using.
 */
export function profileWithTokenCredential(
  profile: Record<string, JsonValue>,
  name: string,
  originalName: string | undefined,
  originalBackend: string | undefined,
): Record<string, JsonValue> {
  if (
    profile.tokenCredential === undefined &&
    originalName === undefined &&
    profile.backend === "buildkite"
  ) {
    return { ...profile, tokenCredential: newTokenCredential() };
  }
  return profileWithStableTokenCredential(
    profile,
    name,
    originalName,
    originalBackend,
  );
}

/**
 * The other profile that already resolves to the same credential reference,
 * if one exists. Derived names can collide (`a-b` and `a_b` both become
 * `A_B`), so the page cannot let one profile silently take another's token.
 */
export function tokenCredentialOwner(
  profiles: SandboxProfileOptionView[],
  name: string,
  tokenCredential: string | undefined,
): string | undefined {
  if (tokenCredential === undefined) {
    return undefined;
  }
  return profiles.find(
    (profile) =>
      profile.name !== name &&
      effectiveTokenCredential(
        profile.name,
        profile.backend,
        profile.fields.tokenCredential,
      ) === tokenCredential,
  )?.name;
}

/**
 * The settings writes that save one profile. A rename is one write: add the
 * new name and remove the old one together, so the page never ends up with
 * both. A default selection on the old name moves with the profile.
 */
export function profileSaveOps(
  name: string,
  profile: Record<string, JsonValue>,
  originalName: string | undefined,
  makeDefault: boolean,
): SettingsPathOpView[] {
  const ops: SettingsPathOpView[] = [
    { op: "set", path: ["profiles", name], value: profile },
  ];
  if (originalName !== undefined && originalName !== name) {
    ops.push({ op: "unset", path: ["profiles", originalName] });
  }
  if (makeDefault) {
    ops.push({ op: "set", path: ["defaultProfile"], value: name });
  }
  return ops;
}

/** The settings writes that remove one profile, and its default selection. */
export function profileRemoveOps(
  name: string,
  clearDefault: boolean,
): SettingsPathOpView[] {
  const ops: SettingsPathOpView[] = [{ op: "unset", path: ["profiles", name] }];
  if (clearDefault) {
    ops.push({ op: "unset", path: ["defaultProfile"] });
  }
  return ops;
}

export const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Display names for the backend ids a profile stores. */
export const BACKEND_LABELS: Record<string, string> = {
  docker: "Docker",
  kas: "Kubernetes",
  buildkite: "Buildkite",
};

/**
 * One profile field. `number` parses as an integer; `minutes` is stored in
 * milliseconds and edited in minutes.
 */
export interface ProfileField {
  key: string;
  label: string;
  kind?: "number" | "minutes";
  optional?: boolean;
}

const idleField: ProfileField = {
  key: "idleMs",
  label: "Idle delay before hibernating",
  kind: "minutes",
  optional: true,
};

const readyTimeoutField: ProfileField = {
  key: "readyTimeoutMs",
  label: "Ready timeout",
  kind: "minutes",
  optional: true,
};

/** Fields per backend, in display order. */
export const BACKEND_FIELDS: Record<string, ProfileField[]> = {
  docker: [
    { key: "image", label: "Runner image", optional: true },
    { key: "binary", label: "Docker command", optional: true },
    { key: "controlPlaneUrl", label: "Control plane URL", optional: true },
    idleField,
  ],
  kas: [
    { key: "namespace", label: "Namespace" },
    { key: "warmPool", label: "Warm pool" },
    { key: "kubeconfig", label: "Kubeconfig path", optional: true },
    readyTimeoutField,
    idleField,
  ],
  buildkite: [
    { key: "organization", label: "Organization" },
    { key: "pipeline", label: "Pipeline" },
    { key: "controlPlaneUrl", label: "Control plane URL" },
    { key: "image", label: "Runner image", optional: true },
    readyTimeoutField,
    idleField,
  ],
};

/**
 * Profile fields the page keeps but never shows. The API token credential is
 * an internal pointer: the page pins it on rename, and a deployment that needs
 * a custom reference sets it in the profile patch.
 */
export const INTERNAL_PROFILE_FIELDS = new Set(["tokenCredential"]);

/** A duration in the largest unit that divides it evenly, such as "3 minutes". */
export function formatDuration(ms: number): string {
  const units: Array<[number, string]> = [
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [1000, "second"],
  ];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const count = ms / size;
      return `${count} ${name}${count === 1 ? "" : "s"}`;
    }
  }
  return `${ms} ms`;
}

// The settings page's own vocabulary, matching the cards this package already
// contributes: token-styled native controls, labels above them, and primitives
// for action hierarchy.
export const labelStyle: CSSProperties = {
  display: "block",
  margin: "12px 0 6px",
  fontWeight: 500,
};

export const cardStyle: CSSProperties = {
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-1)",
  padding: "10px 12px",
};

export const sectionHeadingStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 16,
  fontWeight: 600,
};

export function describeError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
