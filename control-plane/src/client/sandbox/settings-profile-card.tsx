import type { ReactNode } from "react";

import { Button, Tag } from "@deepseek-ai/dsh-client-ui-primitives";

import type { SandboxProfileOptionView } from "../../sandbox/sandbox-settings-remote.js";
import { BackendIcon } from "./backend-icons.js";
import {
  BACKEND_FIELDS,
  BACKEND_LABELS,
  INTERNAL_PROFILE_FIELDS,
  cardStyle,
  formatDuration,
} from "./settings-shared.js";

export interface ProfileCardProps {
  profile: SandboxProfileOptionView;
  isDefault: boolean;
  confirming: boolean;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

/**
 * One profile: a header naming it and its backend, then one row per setting.
 * The timers always show, with the inherited value marked as the default, so
 * the card says what the host applies. Delete asks once before it removes.
 */
export function ProfileCard({
  profile,
  isDefault,
  confirming,
  disabled,
  onEdit,
  onDelete,
  onCancelDelete,
  onConfirmDelete,
}: ProfileCardProps) {
  const rows: Array<{ label: string; value: ReactNode }> = [];
  const known = BACKEND_FIELDS[profile.backend] ?? [];
  for (const field of known) {
    const raw = profile.fields[field.key];
    if (field.key === "idleMs") {
      rows.push({
        label: field.label,
        value: timerValue(profile.idleMs, raw === undefined),
      });
    } else if (field.key === "readyTimeoutMs") {
      if (profile.readyTimeoutMs !== undefined) {
        rows.push({
          label: field.label,
          value: timerValue(profile.readyTimeoutMs, raw === undefined),
        });
      }
    } else if (raw !== undefined) {
      rows.push({ label: field.label, value: <code>{raw}</code> });
    }
  }
  // A hand-edited field the page does not know still shows, under its key;
  // internal references stay out of the operator's view.
  for (const [key, raw] of Object.entries(profile.fields)) {
    if (
      !INTERNAL_PROFILE_FIELDS.has(key) &&
      !known.some((field) => field.key === key)
    ) {
      rows.push({ label: key, value: <code>{raw}</code> });
    }
  }

  return (
    <div style={{ ...cardStyle, padding: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 14px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            minWidth: 0,
          }}
        >
          <BackendIcon backend={profile.backend} size={24} />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontWeight: 600 }}>{profile.name}</span>
              {isDefault ? <Tag tone="outline">default</Tag> : null}
            </div>
            <div
              style={{
                color: "var(--dsw-alias-label-secondary)",
                fontSize: 13,
              }}
            >
              {BACKEND_LABELS[profile.backend] ?? profile.backend} ·{" "}
              {profile.locked ? "set by the deployment" : "added on this page"}
            </div>
          </div>
        </div>
        {profile.locked ? null : (
          <div style={{ display: "flex", gap: 6, flex: "none" }}>
            {confirming ? (
              <>
                <span
                  style={{
                    color: "var(--dsw-alias-label-secondary)",
                    alignSelf: "center",
                    fontSize: 13,
                  }}
                >
                  Delete this profile?
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
                  aria-label={`Confirm delete ${profile.name}`}
                >
                  Delete
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={onEdit}
                  aria-label={`Edit ${profile.name}`}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={onDelete}
                  aria-label={`Delete ${profile.name}`}
                >
                  Delete
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {rows.length > 0 ? (
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(140px, max-content) 1fr",
            columnGap: 16,
            rowGap: 6,
            margin: 0,
            padding: "10px 14px 12px",
            borderTop: "1px solid var(--dsw-alias-border-l2)",
            fontSize: 13,
          }}
        >
          {rows.map((row) => (
            <div key={row.label} style={{ display: "contents" }}>
              <dt style={{ color: "var(--dsw-alias-label-secondary)" }}>
                {row.label}
              </dt>
              <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function timerValue(ms: number, inherited: boolean): ReactNode {
  return (
    <>
      {formatDuration(ms)}
      {inherited ? (
        <span style={{ color: "var(--dsw-alias-label-secondary)" }}>
          {" "}
          · default
        </span>
      ) : null}
    </>
  );
}
