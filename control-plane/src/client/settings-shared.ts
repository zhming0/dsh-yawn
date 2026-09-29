import type { CSSProperties } from "react";

import type {
  SettingsNamespaceView,
  SettingsPathOpView,
} from "@deepseek-ai/dsh-api-remotes/client";
import type { CredentialInfo } from "@deepseek-ai/dsh-credentials/types";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

import type { SandboxSettingsView } from "../sandbox-settings-remote.js";

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

export const controlStyle: CSSProperties = {
  width: "100%",
  minHeight: 38,
  boxSizing: "border-box",
  padding: "7px 10px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
  font: "inherit",
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
