import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Volatile } from "@deepseek-ai/cosmokit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveDegradingRuntime,
  resolveRuntime,
  type ProfileConfig,
  type RuntimeConfig,
} from "../src/config.js";
import { SandboxManager } from "../src/manager/index.js";
import { ProfileRegistry } from "../src/manager/profile-registry.js";
import { RuntimeSettings } from "../src/manager/runtime-settings.js";
import { FakeBackend, gatewayFor } from "./fakes.js";

/** A stand-in for the Loader's volatile reference over one field. */
function setting<T>(initial: T | undefined): {
  ref: Volatile<T | undefined>;
  set(value: T | undefined): void;
} {
  let current = initial;
  return {
    ref: { get: () => current } as Volatile<T | undefined>,
    set(value) {
      current = value;
    },
  };
}

/**
 * The runtime settings slice over the row's volatile config: the settings
 * form writes through the Loader's volatile update, so a write is a new
 * value behind the same references, and the manager sees it on its next
 * read.
 */
describe("sandbox-manager settings", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-settings-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("applies a profile added through the settings form without a restart", async () => {
    const ctx = new Context();
    const standard = new FakeBackend();
    // An empty credential store: Buildkite tokens resolve per request, so a
    // profile can be added and applied before its token is entered.
    const credentials = { resolve: async () => undefined };
    const profiles = setting<Record<string, ProfileConfig>>({
      standard: { backend: "docker" },
    });
    const manager = new SandboxManager(
      ctx,
      {
        profiles: profiles.ref,
        defaultProfile: setting<string>(undefined).ref,
        idleMs: setting<number>(60_000).ref,
        expiresAfterMs: setting<number>(60_000).ref,
        stateDir: directory,
      },
      { backends: { standard }, gateway: gatewayFor(standard), credentials },
    );

    const names = async () =>
      (await manager.getSessionProfile("session-one")).profiles
        .map((profile) => profile.name)
        .sort();
    expect(await names()).toEqual(["standard"]);

    profiles.set({
      standard: { backend: "docker" },
      large: { backend: "docker", image: "dsh-runner:dev" },
    });
    expect(await names()).toEqual(["large", "standard"]);
    const view = await manager.getSessionProfile("session-one");
    expect(view.selected).toBe("standard");
  });
});

describe("ProfileRegistry.update", () => {
  it("keeps a backend whose profile is unchanged and rebuilds the rest", () => {
    const kept = new FakeBackend();
    const standard = {
      name: "standard",
      backend: "docker" as const,
      image: "default-image",
      controlPlaneUrl: "ws://host.docker.internal:8081/tunnel",
    };
    const registry = new ProfileRegistry(
      { standard },
      { standard: kept },
      () => "token",
    );

    registry.update({
      standard,
      large: { ...standard, name: "large", image: "dsh-runner:dev" },
    });
    expect(registry.backendOf("standard")).toBe(kept);
    const built = registry.backendOf("large");
    expect(built).toBeDefined();

    // An edited profile gets a rebuilt backend — the replacement for
    // `standard` stays authoritative for its name, so prove the rebuild on
    // `large`, which this registry builds itself.
    registry.update({
      standard,
      large: { ...standard, name: "large", image: "dsh-runner:next" },
    });
    expect(registry.backendOf("standard")).toBe(kept);
    expect(registry.backendOf("large")).not.toBe(built);

    registry.update({ standard });
    expect(registry.backendOf("large")).toBeUndefined();
  });
});

describe("RuntimeSettings", () => {
  it("re-resolves on every read", () => {
    const initial = resolveRuntime(
      { profiles: {}, idleMs: 60_000, expiresAfterMs: 604_800_000 },
      8081,
    );
    let source: RuntimeConfig = { ...initial, idleMs: 120_000 };
    const holder = new RuntimeSettings(initial, [], () => source, 8081);
    expect(holder.idleMs).toBe(120_000);
    expect(holder.expiresAfterMs).toBe(604_800_000);
    source = { ...initial, idleMs: 240_000 };
    expect(holder.idleMs).toBe(240_000);
  });

  it("degrades one broken piece without freezing the rest of the slice", () => {
    const initial = resolveRuntime(
      { profiles: { standard: { backend: "docker" } }, idleMs: 60_000 },
      8081,
    );
    let source: RuntimeConfig = {
      profiles: {
        standard: { backend: "docker" },
        broken: {
          backend: "docker",
          controlPlaneUrl: "not a WebSocket URL",
        },
      },
      idleMs: 120_000,
    };
    const warnings: string[][] = [];
    const holder = new RuntimeSettings(
      initial,
      [],
      () => source,
      8081,
      (batch) => warnings.push(batch),
    );

    // The broken profile drops alone; the valid pieces of the same slice,
    // including the new timer, still apply. Boot resolves the same way.
    expect(Object.keys(holder.profiles)).toEqual(["standard"]);
    expect(holder.idleMs).toBe(120_000);
    expect(warnings).toEqual([
      [expect.stringContaining("ignoring sandbox profile broken")],
    ]);

    // A later valid edit lands even while the broken profile stays put, and
    // reads do not repeat the warning.
    source = { ...source, idleMs: 240_000 };
    expect(holder.idleMs).toBe(240_000);
    expect(warnings).toHaveLength(1);

    // A clean slice clears the warning state, so a new bad piece warns again.
    source = { profiles: {}, idleMs: 300_000 };
    expect(holder.idleMs).toBe(300_000);
    expect(warnings).toHaveLength(1);
    source = { profiles: {}, idleMs: -1 };
    // Boot parity: a bad timer restores its default rather than the previous
    // value, exactly what a restart would come up with.
    expect(holder.idleMs).toBe(600_000);
    expect(warnings).toHaveLength(2);
  });

  it("seeds the warning state from boot so the same slice is not logged twice", () => {
    const initial = resolveRuntime({ profiles: {} }, 8081);
    const source: RuntimeConfig = {
      profiles: {
        broken: {
          backend: "docker",
          controlPlaneUrl: "not a WebSocket URL",
        },
      },
    };
    // What boot logged for this exact slice, derived the same way.
    const bootWarnings = resolveDegradingRuntime(source, 8081).warnings;
    expect(bootWarnings).toHaveLength(1);
    const warnings: string[][] = [];
    const holder = new RuntimeSettings(
      initial,
      bootWarnings,
      () => source,
      8081,
      (batch) => warnings.push(batch),
    );
    expect(Object.keys(holder.profiles)).toEqual([]);
    expect(warnings).toHaveLength(0);
  });
});
