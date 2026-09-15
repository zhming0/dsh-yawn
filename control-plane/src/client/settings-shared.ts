import type { CSSProperties } from "react";

import type {
  SettingsDescribeValue,
  SettingsNamespaceView,
  SettingsPathOpView,
} from "@deepseek-ai/dsh-api-remotes/client";
import type { CredentialInfo } from "@deepseek-ai/dsh-credentials/types";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

/** What the Sandboxes page calls on the host: settings and write-only credentials. */
export interface SandboxesSettingsActions {
  describeSettings: () => Promise<SettingsDescribeValue>;
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
}

/** One profile as the form edits it: a backend plus its scalar fields. */
export interface ProfileDraft {
  name: string;
  backend: string;
  fields: Record<string, string>;
}

/** The runtime slice as it rides the wire, defaults already applied. */
export interface RuntimeWire {
  profiles?: Record<string, Record<string, JsonValue>>;
  defaultProfile?: string;
  idleMs?: number;
  expiresAfterMs?: number;
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

/** The scalar fields of a wire profile, `backend` aside, for display and edit. */
export function stringFields(
  profile: Record<string, JsonValue> | undefined,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, entry] of Object.entries(profile ?? {})) {
    if (
      key !== "backend" &&
      (typeof entry === "string" || typeof entry === "number")
    ) {
      fields[key] = String(entry);
    }
  }
  return fields;
}
