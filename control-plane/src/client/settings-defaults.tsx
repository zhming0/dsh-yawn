import { useState } from "react";

import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";

import {
  cardStyle,
  controlStyle,
  sectionHeadingStyle,
} from "./settings-shared.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface DefaultsCardProps {
  /** The effective values: deployment settings with the page's edits applied. */
  defaultProfile?: string;
  idleMs: number;
  expiresAfterMs: number;
  /** Which scalars the page overrides; those get a reset control. */
  overridden: {
    defaultProfile: boolean;
    idleMs: boolean;
    expiresAfterMs: boolean;
  };
  profileNames: string[];
  writable: boolean;
  pending: boolean;
  onSetDefault: (name: string) => void;
  onUnset: (path: string[], note: string) => void;
  onSetTimer: (key: "idleMs" | "expiresAfterMs", valueMs: number) => void;
}

/** The default profile and the two lifecycle timers, each one reset away. */
export function DefaultsCard({
  defaultProfile,
  idleMs,
  expiresAfterMs,
  overridden,
  profileNames,
  writable,
  pending,
  onSetDefault,
  onUnset,
  onSetTimer,
}: DefaultsCardProps) {
  const disabled = pending || !writable;
  return (
    <>
      <h3 style={{ ...sectionHeadingStyle, margin: "28px 0 12px" }}>
        Defaults
      </h3>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          ...cardStyle,
          padding: 16,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ flex: "0 0 200px" }}>Default profile</span>
          <select
            aria-label="Default profile"
            value={defaultProfile ?? ""}
            disabled={disabled || profileNames.length === 0}
            onChange={(event) => onSetDefault(event.currentTarget.value)}
            style={{ ...controlStyle, width: 200 }}
          >
            {profileNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {overridden.defaultProfile ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() =>
                onUnset(["defaultProfile"], "reset the default profile")
              }
            >
              Reset
            </Button>
          ) : null}
        </div>
        <TimerRow
          label="Idle delay before hibernating"
          unit="minutes"
          current={idleMs / MINUTE}
          overridden={overridden.idleMs}
          disabled={disabled}
          onSave={(minutes) => onSetTimer("idleMs", minutes * MINUTE)}
          onReset={() => onUnset(["idleMs"], "reset the idle delay")}
        />
        <TimerRow
          label="Retention of hibernated workspaces"
          unit="days"
          current={expiresAfterMs / DAY}
          overridden={overridden.expiresAfterMs}
          disabled={disabled}
          onSave={(days) => onSetTimer("expiresAfterMs", days * DAY)}
          onReset={() =>
            onUnset(["expiresAfterMs"], "reset the retention window")
          }
        />
      </div>
    </>
  );
}

function TimerRow({
  label,
  unit,
  current,
  overridden,
  disabled,
  onSave,
  onReset,
}: {
  label: string;
  unit: string;
  current: number | undefined;
  overridden: boolean;
  disabled: boolean;
  onSave: (steps: number) => void;
  onReset: () => void;
}) {
  const [text, setText] = useState("");
  const rounded = current === undefined ? undefined : Math.round(current);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: "0 0 200px" }}>
        {label}
        <div
          style={{
            color: "var(--dsw-alias-label-secondary)",
            fontSize: 13,
          }}
        >
          {rounded === undefined ? "—" : `${rounded} ${unit}`} ·{" "}
          {overridden ? "custom" : "deployment"}
        </div>
      </div>
      <Input
        aria-label={`${label} in ${unit}`}
        placeholder={unit}
        inputMode="numeric"
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.currentTarget.value)}
        style={{ width: 120 }}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={
          disabled || text === "" || Number.isNaN(Number.parseInt(text, 10))
        }
        onClick={() => {
          onSave(Number.parseInt(text, 10));
          setText("");
        }}
      >
        Save
      </Button>
      {overridden ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={onReset}
        >
          Reset
        </Button>
      ) : null}
    </div>
  );
}
