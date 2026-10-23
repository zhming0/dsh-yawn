import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore } from "../src/state-store.js";

describe("session state store", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-control-plane-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("persists session records atomically", async () => {
    const path = join(directory, "sessions.json");
    const store = new SessionStore(path);
    await store.initialize();
    await store.set({
      sessionId: "one",
      backend: "fake",
      profile: "standard",
      sandboxId: "sandbox-one",
      reference: { id: "one" },
      repositoryUrl: "https://github.com/example/repo.git",
      state: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const reopened = new SessionStore(path);
    await reopened.initialize();
    expect(reopened.get("one")).toMatchObject({ sandboxId: "sandbox-one" });
  });

  it("keeps a choice of no servers apart from having made none", async () => {
    const path = join(directory, "sessions.json");
    const store = new SessionStore(path);
    await store.initialize();
    expect(store.disabledMcpServers("one")).toBeUndefined();
    await store.setDisabledMcpServers("one", []);
    expect(store.disabledMcpServers("one")).toEqual([]);

    // An empty list is the choice "every server on", so it must survive a
    // restart: dropping it would let a later default change rewrite the
    // session.
    const reopened = new SessionStore(path);
    await reopened.initialize();
    expect(reopened.disabledMcpServers("one")).toEqual([]);
    expect(reopened.disabledMcpServers("two")).toBeUndefined();
  });

  it("gives a record written before createdAt existed one, from updatedAt", async () => {
    const path = join(directory, "sessions.json");
    await writeFile(
      path,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            legacy: {
              sessionId: "legacy",
              backend: "docker",
              profile: "standard",
              sandboxId: "sandbox-legacy",
              reference: { id: "legacy" },
              repositoryUrl: "https://github.com/example/repo.git",
              state: "hibernated",
              expiresAt: "2026-08-08T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
          },
          pendingProfiles: {},
        },
        null,
        2,
      )}\n`,
    );

    const store = new SessionStore(path);
    await store.initialize();
    expect(store.get("legacy")?.createdAt).toBe("2026-08-01T00:00:00.000Z");
  });
});
