import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SandboxManager } from "../src/manager/index.js";
import {
  dshHome,
  missingImportedProfiles,
} from "../src/deployment-settings.js";
import { SessionStore } from "../src/state-store.js";
import { FakeBackend, gatewayFor } from "./fakes.js";

describe("session profile choice", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-control-plane-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("provisions with the profile a session picked before its first prompt", async () => {
    const standard = new FakeBackend();
    const large = new FakeBackend();
    const config = {
      stateDir: directory,
      repository: "https://github.com/example/public.git",
      profiles: {
        standard: { backend: "docker" as const },
        large: { backend: "kas" as const, warmPool: "dsh-large" },
      },
    };
    const manager = new SandboxManager(new Context(), config, {
      backends: { standard, large },
      gateway: gatewayFor(large),
    });

    expect(await manager.getSessionProfile("session-one")).toEqual({
      profiles: [
        { name: "standard", backend: "docker" },
        { name: "large", backend: "kas" },
      ],
      selected: "standard",
      locked: false,
    });
    await expect(
      manager.setSessionProfile("session-one", "huge"),
    ).rejects.toThrow("unknown sandbox profile: huge");
    await manager.setSessionProfile("session-one", "large");

    // The choice survives a host restart before the sandbox exists.
    const restarted = new SandboxManager(new Context(), config, {
      backends: { standard, large },
      gateway: gatewayFor(large),
    });
    expect((await restarted.getSessionProfile("session-one")).selected).toBe(
      "large",
    );

    await restarted.ensureRunning({
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent);
    expect(standard.provisions).toBe(0);
    expect(large.provisions).toBe(1);
    const state = JSON.parse(
      await readFile(join(directory, "sessions.json"), "utf8"),
    ) as {
      sessions: Record<string, { backend: string; profile: string }>;
      pendingProfiles: Record<string, string>;
    };
    expect(state.sessions["session-one"]).toMatchObject({
      backend: "fake",
      profile: "large",
    });
    expect(state.pendingProfiles).toEqual({});

    expect(await restarted.getSessionProfile("session-one")).toMatchObject({
      selected: "large",
      locked: true,
    });
    await expect(
      restarted.setSessionProfile("session-one", "standard"),
    ).rejects.toThrow("already has a sandbox");
  });

  it("boots with no profiles and explains the missing profile on the first prompt", async () => {
    const warnings: string[] = [];
    const ctx = new Context();
    // A bare context logs only error and info by default; raise the sink's
    // threshold so the boot warning is captured.
    ctx.logger.exporter({
      levels: { default: 3 },
      export: (message) => {
        if (message.type === "warn") {
          warnings.push(String(message.args[0]));
        }
      },
    });
    const manager = new SandboxManager(
      ctx,
      {
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        profiles: {},
      },
      { gateway: gatewayFor(new FakeBackend()) },
    );

    // The boot warning is what surfaces a mistyped map, before any prompt.
    expect(warnings).toContain(
      "no sandbox profiles configured; add one to the sandbox-manager settings or no session can start a sandbox",
    );
    expect(await manager.getSessionProfile("session-one")).toEqual({
      profiles: [],
      selected: "",
      locked: false,
    });
    await expect(
      manager.ensureRunning({
        id: "session-one",
        session: { header: {} },
      } as unknown as Agent),
    ).rejects.toThrow(
      "no sandbox profile is configured; add one to the sandbox-manager settings",
    );
  });

  it("keeps sessions whose profile is no longer configured", async () => {
    const store = new SessionStore(join(directory, "sessions.json"));
    await store.initialize();
    await store.set({
      sessionId: "session-one",
      backend: "kas",
      profile: "large",
      sandboxId: "sandbox-one",
      reference: { claimName: "claim-one", sandboxId: "sandbox-one" },
      repositoryUrl: "https://github.com/example/public.git",
      state: "hibernated",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Same profile name, but the profile now points at a different backend.
    await store.set({
      sessionId: "session-two",
      backend: "kas",
      profile: "standard",
      sandboxId: "sandbox-two",
      reference: { claimName: "claim-two", sandboxId: "sandbox-two" },
      repositoryUrl: "https://github.com/example/public.git",
      state: "hibernated",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const backend = new FakeBackend();
    const manager = new SandboxManager(
      new Context(),
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public",
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );

    for (const [sessionId, profile] of [
      ["session-one", "large"],
      ["session-two", "standard"],
    ]) {
      await expect(
        manager.ensureRunning({
          id: sessionId,
          session: { header: {} },
        } as unknown as Agent),
      ).rejects.toThrow(
        `kas sandbox from profile ${profile}, which is no longer configured on that backend`,
      );
    }
    expect(backend.provisions).toBe(0);
    const reopened = new SessionStore(join(directory, "sessions.json"));
    await reopened.initialize();
    expect(reopened.get("session-one")?.state).toBe("hibernated");
    expect(reopened.get("session-two")?.state).toBe("hibernated");
  });

  it("combines deployment profiles with the page's own, and locks the deployment's", async () => {
    const standard = new FakeBackend();
    const hosted = new FakeBackend();
    const manager = new SandboxManager(
      new Context(),
      {
        // What the image seeds, plus a profile the page added. The deployment
        // document supplies the rest.
        profiles: {
          local: { backend: "docker", image: "page:image" },
        },
        stateDir: directory,
      },
      {
        backends: { standard, hosted, local: standard },
        gateway: gatewayFor(hosted),
        deploymentSettings: {
          profiles: {
            standard: { backend: "docker" },
            hosted: {
              backend: "buildkite",
              organization: "acme",
              pipeline: "dsh-yawn",
              controlPlaneUrl: "wss://dsh.example.com/tunnel",
            },
          },
          defaultProfile: "hosted",
          idleMs: 300_000,
        },
      },
    );

    // The composer chip and the settings page see the same profile set:
    // deployment profiles first, then the page's own.
    expect(await manager.getSessionProfile("session-one")).toEqual({
      profiles: [
        { name: "standard", backend: "docker" },
        { name: "hosted", backend: "buildkite" },
        { name: "local", backend: "docker" },
      ],
      selected: "hosted",
      locked: false,
    });
    const settings = manager.getSandboxSettings();
    expect(settings.profiles).toEqual([
      {
        name: "standard",
        backend: "docker",
        fields: {},
        locked: true,
      },
      {
        name: "hosted",
        backend: "buildkite",
        fields: {
          organization: "acme",
          pipeline: "dsh-yawn",
          controlPlaneUrl: "wss://dsh.example.com/tunnel",
        },
        locked: true,
      },
      {
        name: "local",
        backend: "docker",
        fields: { image: "page:image" },
        locked: false,
      },
    ]);
    expect(settings.defaultProfile).toBe("hosted");
    expect(settings.idleMs).toBe(300_000);
    expect(settings.overridden).toEqual({
      defaultProfile: false,
      idleMs: false,
      expiresAfterMs: false,
    });
    // No settings service is mounted in this bare context, so the page has
    // nothing it could write with.
    expect(settings.revision).toBe(0);
    expect(settings.writable).toBe(false);

    // A session pick still wins over the deployment's default.
    await manager.setSessionProfile("session-one", "standard");
    expect((await manager.getSessionProfile("session-one")).selected).toBe(
      "standard",
    );
  });

  it("keeps the deployment's definition when the page reuses a profile name", async () => {
    const standard = new FakeBackend();
    const manager = new SandboxManager(
      new Context(),
      {
        profiles: { standard: { backend: "docker", image: "page:image" } },
        stateDir: directory,
      },
      {
        backends: { standard },
        gateway: gatewayFor(standard),
        deploymentSettings: {
          profiles: { standard: { backend: "docker", image: "chart:image" } },
        },
      },
    );

    const settings = manager.getSandboxSettings();
    expect(settings.profiles).toEqual([
      {
        name: "standard",
        backend: "docker",
        fields: { image: "chart:image" },
        locked: true,
      },
    ]);
    expect((await manager.getSessionProfile("session-one")).selected).toBe(
      "standard",
    );
  });

  it("warns when a renamed settings document still holds missing profiles", async () => {
    await writeFile(
      join(directory, "settings.yaml.imported"),
      "sandbox-manager:\n  profiles:\n    hosted:\n      backend: docker\n",
    );
    expect(
      missingImportedProfiles(join(directory, "settings.yaml.imported"), [
        "standard",
      ]),
    ).toEqual(["hosted"]);
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = directory;
    expect(dshHome()).toBe(directory);
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const backend = new FakeBackend();
      new SandboxManager(
        new Context(),
        { profiles: { standard: { backend: "docker" } }, stateDir: directory },
        { backends: { standard: backend }, gateway: gatewayFor(backend) },
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.DSH_HOME;
      } else {
        process.env.DSH_HOME = previousHome;
      }
    }
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("sandbox profile(s) hosted are only in"),
    );
    write.mockRestore();
  });
});
