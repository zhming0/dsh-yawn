/**
 * Browser notifications when a session turn finishes.
 *
 * The browser already receives one running/idle bit per session on the session
 * list feed — the same bit dsh reads for its sidebar "done" mark — so this
 * module only watches that feed for a running→idle edge and shows a
 * notification while the page is not being looked at.
 *
 * The choice belongs to one browser profile, not to the control plane, so it
 * lives in localStorage and never crosses the wire.
 *
 * Three browser rules bound this feature and none of them can be lifted here:
 * the Notifications API exists only in a secure context (https, or localhost),
 * the user must grant permission from a click, and a frozen background tab can
 * delay the feed until the tab wakes. Support is also uneven: iOS exposes the
 * API to Safari only (16.4+, and for a web app added to the Home Screen), so
 * every other browser there reports `unsupported` even on https. This module
 * keeps the browser's reason apart from the page's, so Settings can say which.
 *
 * @module @zhming0/dsh-yawn/client/notifications
 */

import type {
  ISessions,
  SessionListState,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { ObservableSnapshot } from "@deepseek-ai/dsh-client-store";

/** localStorage key holding whether this browser asked for turn notifications. */
export const NOTIFICATIONS_ENABLED_KEY = "dsh-yawn.notifications.enabled";

/** The browser's answer, or `unsupported` where the Notifications API is absent. */
export type NotificationPermissionState =
  | "unsupported"
  | NotificationPermission;

/**
 * Why this page cannot show notifications at all.
 *
 * `insecure` is the page's fault: the browser exposes the API to a secure
 * context only. `unsupported` is the browser's: it never exposes the API here,
 * as on the iOS browsers other than Safari, whatever the page's scheme.
 */
export type NotificationBlockedReason = "insecure" | "unsupported";

/**
 * The client session verbs the notification layer uses. Named here because the
 * host package (`dsh-session`) augments the same `Context.sessions` key with
 * its own store type, so `Pick<ISessions, …>` is the honest face in a program
 * that type-checks both planes.
 */
export type ClientSessions = Pick<ISessions, "list" | "open">;

/** What one finished turn looks like to the notification layer. */
export interface TurnFinishedNotice {
  readonly sessionId: string;
  readonly title: string;
}

/**
 * What the watcher needs from the browser. Injectable so a test can drive the
 * decision without a DOM or a real notification.
 */
export interface TurnNotificationRuntime {
  /** Whether this browser asked for notifications (the Settings toggle). */
  enabled(): boolean;
  /** The browser's permission, or `unsupported` without the API. */
  permission(): NotificationPermissionState;
  /** Whether the user is looking at this page right now. */
  looking(): boolean;
  /** Show one notification; clicking it runs `onClick`. */
  show(notice: TurnFinishedNotice, onClick: () => void): void;
}

/** Whether this browser has turn notifications switched on. */
export function notificationsEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(NOTIFICATIONS_ENABLED_KEY) === "on";
  } catch {
    // A browser that refuses storage (private mode, blocked cookies) keeps the
    // feature off rather than failing the settings page.
    return false;
  }
}

/** Persist the on/off choice. */
export function setNotificationsEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      globalThis.localStorage?.setItem(NOTIFICATIONS_ENABLED_KEY, "on");
    } else {
      globalThis.localStorage?.removeItem(NOTIFICATIONS_ENABLED_KEY);
    }
  } catch {
    // See notificationsEnabled.
  }
}

/**
 * Why this page cannot ask for notifications, or `undefined` when it can.
 *
 * `Notification` is absent both when the browser never implements the API here
 * and when the page is not a secure context, and the two need different words:
 * one is fixed by https, the other by changing browser.
 */
export function notificationBlockedReason():
  | NotificationBlockedReason
  | undefined {
  if (typeof Notification === "undefined") {
    return globalThis.isSecureContext === false ? "insecure" : "unsupported";
  }
  if (typeof Notification.permission !== "string") {
    return "unsupported";
  }
  return undefined;
}

/** Read the browser's notification permission. */
export function notificationPermission(): NotificationPermissionState {
  return notificationBlockedReason() === undefined
    ? Notification.permission
    : "unsupported";
}

/** Ask the browser for permission. Call from a click: browsers require a gesture. */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (notificationBlockedReason() !== undefined) {
    return "unsupported";
  }
  return await Notification.requestPermission();
}

/** Show one example notification, so the user can check their browser path. */
export function showTestNotification(): void {
  if (notificationPermission() !== "granted") {
    return;
  }
  showNotification(
    "DeepSeek Harness",
    "Test notification. Turn notifications are on.",
    "dsh-yawn-test",
  );
}

/**
 * Watch a session list feed and report each top-level session that stops
 * running. The first observation of a session only records its running bit, so
 * a page loaded onto idle sessions stays silent; subagent children are skipped
 * because their turns end constantly and their parent is still working.
 *
 * @param list - session list snapshot source.
 * @param onFinished - called once per running→idle edge.
 * @returns unsubscribe.
 */
export function watchTurnEnds(
  list: ObservableSnapshot<SessionListState>,
  onFinished: (summary: SessionSummary) => void,
): () => void {
  const running = new Map<string, boolean>();
  const inspect = () => {
    const state = list.getSnapshot();
    const seen = new Set<string>();
    for (const id of state.ids) {
      const summary = state.byId[id];
      if (summary === undefined || summary.origin === "subagent") {
        continue;
      }
      seen.add(id);
      const previous = running.get(id);
      running.set(id, summary.running);
      if (previous === true && !summary.running) {
        onFinished(summary);
      }
    }
    for (const id of running.keys()) {
      if (!seen.has(id)) {
        running.delete(id);
      }
    }
  };
  inspect();
  return list.subscribe(inspect);
}

/**
 * Notify when a turn finishes while this page is in the background.
 *
 * @param sessions - the client session service (list feed plus selection).
 * @param runtime - browser facts; defaults to the real browser.
 * @returns unsubscribe.
 */
export function installTurnNotifications(
  sessions: ClientSessions,
  runtime: TurnNotificationRuntime = browserRuntime,
): () => void {
  return watchTurnEnds(sessions.list, (summary) => {
    if (!runtime.enabled() || runtime.permission() !== "granted") {
      return;
    }
    if (runtime.looking()) {
      return;
    }
    runtime.show(
      { sessionId: String(summary.id), title: summary.displayTitle },
      () => {
        try {
          sessions.open(summary.id);
        } catch {
          // The session left the list between the notification and the click.
        }
      },
    );
  });
}

/** The real browser behind {@link TurnNotificationRuntime}. */
export const browserRuntime: TurnNotificationRuntime = {
  enabled: notificationsEnabled,
  permission: notificationPermission,
  looking: () => !document.hidden && document.hasFocus(),
  show: (notice, onClick) =>
    showNotification(
      notice.title,
      "The turn finished.",
      // One notification per session: a second browser tab showing the same
      // completion replaces this one instead of alerting twice.
      `dsh-yawn-turn:${notice.sessionId}`,
      onClick,
    ),
};

/** Build and wire one Notification; a click focuses the page first. */
function showNotification(
  title: string,
  body: string,
  tag: string,
  onClick?: () => void,
): void {
  let notification: Notification;
  try {
    notification = new Notification(title, { body, tag });
  } catch {
    // Chrome on Android refuses the constructor; it needs a service worker.
    return;
  }
  notification.onclick = () => {
    window.focus();
    notification.close();
    onClick?.();
  };
}
