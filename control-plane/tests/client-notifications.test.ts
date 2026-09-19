import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ISessions,
  SessionListState,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

import {
  installTurnNotifications,
  notificationsEnabled,
  setNotificationsEnabled,
  watchTurnEnds,
  type TurnNotificationRuntime,
} from "../src/client/notifications.js";

const id = (value: string): SessionId => value as SessionId;

/** A session list feed a test can publish into. */
class FakeList {
  private state: SessionListState = listOf();
  private readonly listeners = new Set<() => void>();

  getSnapshot(): SessionListState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(state: SessionListState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

interface Row {
  id: SessionId;
  running: boolean;
  origin?: "subagent";
}

function listOf(rows: readonly Row[] = []): SessionListState {
  const byId: Record<string, SessionSummary> = {};
  for (const row of rows) {
    byId[row.id] = {
      id: row.id,
      displayTitle: `Session ${String(row.id)}`,
      running: row.running,
      blank: false,
      updatedAt: 0,
      ...(row.origin === undefined ? {} : { origin: row.origin }),
    };
  }
  return {
    ids: rows.map((row) => row.id),
    byId,
    current: undefined,
    phase: "ready",
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  };
}

function runtime(
  overrides: Partial<TurnNotificationRuntime> = {},
): TurnNotificationRuntime {
  return {
    enabled: () => true,
    permission: () => "granted",
    looking: () => false,
    show: () => undefined,
    ...overrides,
  };
}

describe("turn finished notifications", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports one running→idle edge and nothing else", () => {
    const list = new FakeList();
    const finished: string[] = [];
    const stop = watchTurnEnds(list, (summary) => {
      finished.push(String(summary.id));
    });

    list.publish(listOf([{ id: id("root"), running: true }]));
    expect(finished).toEqual([]);
    // A refresh that does not move the bit stays silent.
    list.publish(listOf([{ id: id("root"), running: true }]));
    expect(finished).toEqual([]);

    list.publish(listOf([{ id: id("root"), running: false }]));
    expect(finished).toEqual(["root"]);
    // Idle stays idle: no repeated notification.
    list.publish(listOf([{ id: id("root"), running: false }]));
    expect(finished).toEqual(["root"]);

    stop();
    list.publish(listOf([{ id: id("root"), running: true }]));
    list.publish(listOf([{ id: id("root"), running: false }]));
    expect(finished).toEqual(["root"]);
  });

  it("stays silent for a session that was already idle when the page loaded", () => {
    const list = new FakeList();
    list.publish(listOf([{ id: id("root"), running: false }]));
    const finished: string[] = [];

    watchTurnEnds(list, (summary) => {
      finished.push(String(summary.id));
    });
    list.publish(listOf([{ id: id("root"), running: false }]));

    expect(finished).toEqual([]);
  });

  it("ignores subagent turns, whose parent is still working", () => {
    const list = new FakeList();
    const finished: string[] = [];
    watchTurnEnds(list, (summary) => {
      finished.push(String(summary.id));
    });

    list.publish(
      listOf([{ id: id("child"), running: true, origin: "subagent" }]),
    );
    list.publish(
      listOf([{ id: id("child"), running: false, origin: "subagent" }]),
    );

    expect(finished).toEqual([]);
  });

  it("notifies only when enabled, permitted, and not being looked at", () => {
    const open = vi.fn();
    const cases: ReadonlyArray<[Partial<TurnNotificationRuntime>, number]> = [
      [{}, 1],
      [{ enabled: () => false }, 0],
      [{ permission: () => "default" }, 0],
      [{ permission: () => "denied" }, 0],
      [{ permission: () => "unsupported" }, 0],
      [{ looking: () => true }, 0],
    ];

    for (const [overrides, expected] of cases) {
      const list = new FakeList();
      const sessions = { list, open } as unknown as Pick<
        ISessions,
        "list" | "open"
      >;
      const show = vi.fn();
      const stop = installTurnNotifications(
        sessions,
        runtime({ ...overrides, show }),
      );
      list.publish(listOf([{ id: id("root"), running: true }]));
      list.publish(listOf([{ id: id("root"), running: false }]));
      expect(show).toHaveBeenCalledTimes(expected);
      stop();
    }
  });

  it("names the session and opens it when the notification is clicked", () => {
    const list = new FakeList();
    const open = vi.fn();
    const sessions = { list, open } as unknown as Pick<
      ISessions,
      "list" | "open"
    >;
    const show = vi.fn();
    installTurnNotifications(sessions, runtime({ show }));

    list.publish(listOf([{ id: id("root"), running: true }]));
    list.publish(listOf([{ id: id("root"), running: false }]));

    const [notice, onClick] = show.mock.calls[0] as [
      { sessionId: string; title: string },
      () => void,
    ];
    expect(notice).toEqual({ sessionId: "root", title: "Session root" });

    onClick();
    expect(open).toHaveBeenCalledWith(id("root"));
  });

  it("keeps the choice in browser storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });

    expect(notificationsEnabled()).toBe(false);
    setNotificationsEnabled(true);
    expect(notificationsEnabled()).toBe(true);
    setNotificationsEnabled(false);
    expect(notificationsEnabled()).toBe(false);
  });

  it("keeps the feature off when storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);

    expect(notificationsEnabled()).toBe(false);
    expect(() => setNotificationsEnabled(true)).not.toThrow();
  });

  /**
   * The feature watches the session list's `running` bit, which stays live only
   * while the pinned client subscribes to the status frame and feeds it into
   * the list manager. A dsh bump that drops either half would silence the
   * notifications without breaking a type, so pin both here.
   */
  it("still receives a live running bit from the pinned dsh client", () => {
    const require = createRequire(import.meta.url);
    const bundle = readFileSync(
      join(
        require.resolve("@deepseek-ai/dsh-api-session-controller/package.json"),
        "..",
        "lib",
        "client.js",
      ),
      "utf8",
    );

    expect(bundle).toContain('$on("api-session/status"');
    expect(bundle).toMatch(
      /sessions\.handleSessionStatus\(sessionId, running\)/,
    );
  });
});
