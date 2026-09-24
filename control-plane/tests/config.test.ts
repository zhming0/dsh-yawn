import { describe, expect, it } from "vitest";

import {
  configSchema,
  readSetting,
  resolveBootConfig,
  resolveConfig,
} from "../src/config.js";
import { DEFAULT_RUNNER_IMAGE } from "../src/runner-image.js";

describe("sandbox provider settings", () => {
  it("resolves each sandbox profile with its own backend settings", () => {
    const single = resolveConfig({
      profiles: { standard: { backend: "kas" } },
    });
    expect(single.defaultProfile).toBe("standard");
    expect(single.profiles).toEqual({
      standard: {
        name: "standard",
        backend: "kas",
        namespace: "dsh-yawn",
        warmPool: "dsh-yawn-universal",
        readyTimeoutMs: 180_000,
      },
    });

    const explicit = resolveConfig({
      defaultProfile: "large",
      tunnel: { port: 9000 },
      profiles: {
        standard: { backend: "kas", namespace: "team-a" },
        large: { backend: "kas", warmPool: "dsh-large" },
        local: { backend: "docker", image: "runner:dev" },
        remote: {
          backend: "docker",
          controlPlaneUrl: "ws://10.0.0.1:8081/tunnel",
        },
      },
    });
    expect(explicit.defaultProfile).toBe("large");
    expect(explicit.profiles).toEqual({
      standard: {
        name: "standard",
        backend: "kas",
        namespace: "team-a",
        warmPool: "dsh-yawn-universal",
        readyTimeoutMs: 180_000,
      },
      large: {
        name: "large",
        backend: "kas",
        namespace: "dsh-yawn",
        warmPool: "dsh-large",
        readyTimeoutMs: 180_000,
      },
      local: {
        name: "local",
        backend: "docker",
        image: "runner:dev",
        controlPlaneUrl: "ws://host.docker.internal:9000/tunnel",
      },
      remote: {
        name: "remote",
        backend: "docker",
        image: DEFAULT_RUNNER_IMAGE,
        controlPlaneUrl: "ws://10.0.0.1:8081/tunnel",
      },
    });

    expect(() =>
      resolveConfig({
        defaultProfile: "missing",
        profiles: { standard: { backend: "docker" } },
      }),
    ).toThrow("defaultProfile missing is not a configured profile");

    // A host with no sandbox profile still resolves and boots; the first
    // prompt explains what to add instead of the process failing at startup.
    // A leftover defaultProfile does not turn that into a boot error.
    //
    // Boot also survives settings-form writes the schema accepts but the host
    // cannot apply: since dsh 0.1.7 those persist into the profile patch the
    // Loader reads, so the strict resolver throwing would kill the row on the
    // next restart. The boot face degrades instead, one warning per piece.
    const degraded = resolveBootConfig({
      defaultProfile: "missing",
      profiles: {
        standard: { backend: "docker" },
        broken: {
          backend: "docker",
          controlPlaneUrl: "not a WebSocket URL",
        },
      },
      idleMs: -1,
    });
    expect(degraded.warnings).toEqual([
      expect.stringContaining("ignoring sandbox profile broken"),
      "defaultProfile missing names no configured profile; using standard",
      "idleMs -1 must be positive; using 600000",
    ]);
    expect(Object.keys(degraded.config.profiles)).toEqual(["standard"]);
    expect(degraded.config.defaultProfile).toBe("standard");
    expect(degraded.config.idleMs).toBe(600000);
    for (const config of [
      { profiles: {} },
      {},
      { profiles: {}, defaultProfile: "standard" },
    ]) {
      // The schema hands back a volatile reference for the runtime fields;
      // readSetting is the value the host and the tests both see.
      expect(readSetting(configSchema(config).profiles)).toEqual({});
      const empty = resolveConfig(config);
      expect(empty.profiles).toEqual({});
      expect(empty.defaultProfile).toBeUndefined();
    }

    expect(() =>
      resolveConfig({
        profiles: {
          old: { backend: "docker", controlPlaneUrl: "tcp://10.0.0.1:8081" },
        },
      }),
    ).toThrow("profile old: controlPlaneUrl must be a ws:// or wss:// URL");
  });

  it("takes a bare preview domain and refuses anything else", () => {
    const profiles = { standard: { backend: "docker" as const } };
    // No domain: previews are off and the listener does not start.
    expect(resolveConfig({ profiles }).preview).toEqual({
      domain: undefined,
      port: 8082,
      bind: "0.0.0.0",
    });
    expect(
      resolveConfig({ preview: { domain: "  " }, profiles }).preview,
    ).toEqual({ domain: undefined, port: 8082, bind: "0.0.0.0" });

    // A configured domain is normalized once, here: both sides match the
    // lowercased, trimmed spelling against the Host header.
    expect(
      resolveConfig({
        preview: {
          domain: " Sandbox.Example.COM ",
          port: 9000,
          bind: "127.0.0.1",
        },
        profiles,
      }).preview,
    ).toEqual({ domain: "sandbox.example.com", port: 9000, bind: "127.0.0.1" });

    // A scheme, a path, a wildcard, or an empty label would build host names
    // no browser ever sends, so boot fails rather than never matching.
    for (const domain of [
      "https://sandbox.example.com",
      "sandbox.example.com/previews",
      "*.example.com",
      "a..b",
      "sandbox example.com",
    ]) {
      expect(() => resolveConfig({ preview: { domain }, profiles })).toThrow(
        "must be a bare host",
      );
    }
  });
});
