import { useState } from "react";

import { Button, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";

import {
  notificationPermission,
  notificationsEnabled,
  requestNotificationPermission,
  setNotificationsEnabled,
  showTestNotification,
  type NotificationPermissionState,
} from "./notifications.js";

const messageStyle = {
  color: "var(--dsw-alias-label-secondary)",
  lineHeight: 1.5,
} as const;

/** Settings page for browser notifications when a turn finishes. */
export function NotificationsSettings(_props: SettingsSectionOwnerProps) {
  const [enabled, setEnabled] = useState(notificationsEnabled);
  const [permission, setPermission] = useState<NotificationPermissionState>(
    notificationPermission,
  );
  const [error, setError] = useState<string>();
  const active = enabled && permission === "granted";

  const toggle = async (next: boolean) => {
    setError(undefined);
    if (!next) {
      setNotificationsEnabled(false);
      setEnabled(false);
      return;
    }
    try {
      // Called inside the click, before any await: browsers only ask for
      // notification permission from a user gesture.
      const result = await requestNotificationPermission();
      setPermission(result);
      setNotificationsEnabled(result === "granted");
      setEnabled(result === "granted");
    } catch (reason) {
      setEnabled(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section style={{ maxWidth: 760, color: "var(--dsw-alias-label-primary)" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>Notifications</h2>
      <p style={{ ...messageStyle, margin: "0 0 24px" }}>
        Shows a browser notification when a turn finishes while you are looking
        at another tab or window. Clicking the notification opens that session.
        The choice is stored in this browser, not on the control plane.
      </p>

      {permission === "unsupported" ? (
        <p style={{ margin: 0, ...messageStyle }}>
          This page cannot show notifications. Browsers allow them only on
          https:// pages, or on localhost.
        </p>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Switch
            checked={active}
            label="Notify me when a turn finishes"
            onChange={(next) => void toggle(next)}
          />
          <span>Notify me when a turn finishes</span>
        </div>
      )}

      {permission === "denied" ? (
        <p role="alert" style={{ margin: "12px 0 0", ...messageStyle }}>
          This browser has blocked notifications for this site. Allow them in
          the browser's site settings, then reload this page.
        </p>
      ) : null}

      {active ? (
        <div style={{ marginTop: 20 }}>
          <Button variant="outline" onClick={showTestNotification}>
            Send test notification
          </Button>
        </div>
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
          color: "var(--dsw-alias-label-tertiary)",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        Notifications need this page to stay open in a tab; a fully closed
        browser receives nothing. A background tab may delay one until the
        browser wakes it.
      </p>
    </section>
  );
}
