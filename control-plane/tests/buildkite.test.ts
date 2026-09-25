import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BuildkiteBackend,
  testing as buildkiteTesting,
} from "../src/backends/buildkite.js";
import { resolveBuildkiteToken } from "../src/buildkite-token.js";
import { resolveConfig } from "../src/config.js";
import { testing as managerTesting } from "../src/manager/profile-registry.js";
import { DEFAULT_RUNNER_IMAGE } from "../src/runner-image.js";
import { SandboxNotFoundError } from "../src/types.js";

const API_ROOT = "https://api.buildkite.com/v2/organizations/acme";
const PIPELINE_URL = `${API_ROOT}/pipelines/dsh-yawn`;
const SECRET_URL = `${API_ROOT}/clusters/cluster-uuid/secrets`;
const PIPELINE = { id: "pipeline-uuid", cluster_id: "cluster-uuid" };
const SECRET = { id: "secret-uuid", key: "DSH_YAWN_REGISTRATION_TOKEN" };

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A fake Buildkite API: each request pops the next scripted response. */
function fakeApi(responses: Array<{ status?: number; body?: unknown }>): {
  calls: Call[];
  fetch: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({
      method: init?.method ?? "GET",
      url,
      headers: init?.headers as Record<string, string>,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) as unknown }
        : {}),
    });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error(`unexpected request ${init?.method} ${url}`);
    }
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch: fetchImpl };
}

function backendWith(
  api: { fetch: typeof fetch },
  secretKey?: string,
): BuildkiteBackend {
  return new BuildkiteBackend(
    {
      organization: "acme",
      pipeline: "dsh-yawn",
      image: "ghcr.io/zhming0/dsh-yawn-runner:test",
      controlPlaneUrl: "wss://dsh.example.com/tunnel",
      readyTimeoutMs: 60_000,
      token: async () => "bkua_test",
      registrationToken: () => "registration-token",
      ...(secretKey === undefined ? {} : { secretKey }),
    },
    api.fetch,
  );
}

describe("Buildkite backend", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates one build per sandbox and waits for its job to start", async () => {
    vi.useFakeTimers();
    const api = fakeApi([
      { body: [] },
      { body: PIPELINE },
      { body: [] },
      { body: SECRET },
      { body: { number: 7, state: "scheduled", web_url: "https://bk/7" } },
      { body: { number: 7, state: "scheduled", web_url: "https://bk/7" } },
      { body: { number: 7, state: "running", web_url: "https://bk/7" } },
    ]);
    const backend = backendWith(api);

    const pending = backend.provision({
      sessionId: "session-one",
      repositoryUrl: "https://github.com/example/repo.git",
    });
    await vi.advanceTimersByTimeAsync(4_000);
    const handle = await pending;

    expect(handle.sandboxId).toMatch(/^dsh-[0-9a-f]{16}-[0-9a-f]{6}$/);
    expect(handle.reference).toEqual({
      buildNumber: 7,
      sandboxId: handle.sandboxId,
    });

    const [lookup, pipeline, listSecrets, createSecret, create, ...polls] =
      api.calls;
    expect(lookup?.method).toBe("GET");
    expect(lookup?.url).toBe(
      `${PIPELINE_URL}/builds?${new URLSearchParams([
        ["meta_data[dsh-session]", "session-one"],
        ["exclude_pipeline", "true"],
        ["exclude_jobs", "true"],
        ["state[]", "scheduled"],
        ["state[]", "running"],
      ])}`,
    );
    expect(pipeline?.url).toBe(PIPELINE_URL);
    expect(listSecrets?.url).toBe(`${SECRET_URL}?per_page=100&page=1`);
    expect(createSecret?.method).toBe("POST");
    expect(createSecret?.url).toBe(SECRET_URL);
    expect(createSecret?.body).toEqual({
      key: "DSH_YAWN_REGISTRATION_TOKEN",
      value: "registration-token",
      description: "dsh-yawn runner token for dsh-yawn",
      policy: "- pipeline_id: pipeline-uuid",
    });
    expect(create?.method).toBe("POST");
    expect(create?.url).toBe(`${PIPELINE_URL}/builds`);
    expect(create?.headers.authorization).toBe("Bearer bkua_test");
    // The token rides the cluster secret, never the build environment.
    expect(create?.body).toEqual({
      commit: "HEAD",
      branch: "main",
      message: `dsh sandbox ${handle.sandboxId}`,
      env: {
        DSH_YAWN_SANDBOX_ID: handle.sandboxId,
        DSH_YAWN_CONTROL_PLANE_URL: "wss://dsh.example.com/tunnel",
        DSH_YAWN_RUNNER_IMAGE: "ghcr.io/zhming0/dsh-yawn-runner:test",
      },
      meta_data: { "dsh-session": "session-one" },
    });
    expect(polls.map((call) => call.url)).toEqual([
      `${PIPELINE_URL}/builds/7?exclude_jobs=true&exclude_pipeline=true`,
      `${PIPELINE_URL}/builds/7?exclude_jobs=true&exclude_pipeline=true`,
    ]);
  });

  it("stores the token once and updates the same secret on rotation", async () => {
    const api = fakeApi([
      { body: PIPELINE },
      { body: [SECRET] },
      { body: SECRET },
      { body: SECRET },
    ]);
    const backend = backendWith(api);

    await backend.publishRegistrationToken("token-one");
    // The token did not change, so nothing else is sent.
    await backend.publishRegistrationToken("token-one");
    await backend.publishRegistrationToken("token-two");

    expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${PIPELINE_URL}`,
      `GET ${SECRET_URL}?per_page=100&page=1`,
      `PUT ${SECRET_URL}/secret-uuid/value`,
      `PUT ${SECRET_URL}/secret-uuid/value`,
    ]);
    expect(api.calls[2]?.body).toEqual({ value: "token-one" });
    expect(api.calls[3]?.body).toEqual({ value: "token-two" });
  });

  it("uses the profile's own secret key when a cluster is shared", async () => {
    const api = fakeApi([
      { body: PIPELINE },
      { body: [] },
      { body: { id: "secret-uuid", key: "DSH_YAWN_HOSTED_TOKEN" } },
    ]);

    await backendWith(api, "DSH_YAWN_HOSTED_TOKEN").publishRegistrationToken(
      "token-one",
    );

    expect(api.calls[2]?.body).toMatchObject({
      key: "DSH_YAWN_HOSTED_TOKEN",
    });
  });

  it("finds the secret on a later page of a busy cluster", async () => {
    const otherSecrets = Array.from({ length: 100 }, (_, index) => ({
      id: `other-${index}`,
      key: `OTHER_${index}`,
    }));
    const api = fakeApi([
      { body: PIPELINE },
      { body: otherSecrets },
      { body: [SECRET] },
      { body: SECRET },
    ]);

    await backendWith(api).publishRegistrationToken("token-one");

    expect(api.calls[2]?.url).toBe(`${SECRET_URL}?per_page=100&page=2`);
    expect(api.calls[3]).toMatchObject({
      method: "PUT",
      url: `${SECRET_URL}/secret-uuid/value`,
    });
  });

  it("creates the secret again when it disappeared", async () => {
    const api = fakeApi([
      { body: PIPELINE },
      { body: [SECRET] },
      { status: 404, body: { message: "Not Found" } },
      { body: PIPELINE },
      { body: [] },
      { body: SECRET },
    ]);

    await backendWith(api).publishRegistrationToken("token-one");

    expect(api.calls.at(-1)).toMatchObject({
      method: "POST",
      url: SECRET_URL,
    });
  });

  it("refuses to publish when the pipeline is not in a cluster", async () => {
    const api = fakeApi([{ body: { id: "pipeline-uuid", cluster_id: null } }]);

    await expect(
      backendWith(api).publishRegistrationToken("token-one"),
    ).rejects.toThrow("Buildkite pipeline dsh-yawn is not in a cluster");
  });

  it("adopts a live build created before the session was saved", async () => {
    const api = fakeApi([
      {
        body: [
          {
            number: 3,
            state: "running",
            web_url: "https://bk/3",
            env: {
              DSH_YAWN_SANDBOX_ID: "dsh-existing",
              DSH_YAWN_CONTROL_PLANE_URL: "wss://x/tunnel",
            },
          },
        ],
      },
    ]);

    const handle = await backendWith(api).provision({
      sessionId: "session-one",
      repositoryUrl: "https://github.com/example/repo.git",
    });

    expect(handle).toEqual({
      sandboxId: "dsh-existing",
      reference: { buildNumber: 3, sandboxId: "dsh-existing" },
    });
    expect(api.calls).toHaveLength(1);
  });

  it("cancels a build whose job never started", async () => {
    vi.useFakeTimers();
    const api = fakeApi([
      { body: [] },
      { body: PIPELINE },
      { body: [] },
      { body: SECRET },
      { body: { number: 9, state: "scheduled", web_url: "https://bk/9" } },
      { body: { number: 9, state: "scheduled", web_url: "https://bk/9" } },
      { status: 200, body: { number: 9, state: "canceling" } },
    ]);
    const backend = new BuildkiteBackend(
      {
        organization: "acme",
        pipeline: "dsh-yawn",
        image: "ghcr.io/zhming0/dsh-yawn-runner:test",
        controlPlaneUrl: "wss://dsh.example.com/tunnel",
        readyTimeoutMs: 2_000,
        token: async () => "bkua_test",
        registrationToken: () => "registration-token",
      },
      api.fetch,
    );

    const pending = backend.provision({
      sessionId: "session-one",
      repositoryUrl: "https://github.com/example/repo.git",
    });
    // Attach the handler before advancing so the rejection is never unhandled.
    const outcome = pending.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await outcome).toBe(
      "Buildkite build https://bk/9 did not start within 2000ms",
    );
    expect(api.calls.at(-1)).toMatchObject({
      method: "PUT",
      url: `${PIPELINE_URL}/builds/9/cancel`,
    });
  });

  it("reports a finished or missing build as lost so the manager replaces it", async () => {
    const finished = fakeApi([
      { body: { number: 4, state: "canceled", web_url: "https://bk/4" } },
    ]);
    await expect(
      backendWith(finished).wake({ buildNumber: 4, sandboxId: "dsh-a" }),
    ).rejects.toBeInstanceOf(SandboxNotFoundError);

    const missing = fakeApi([{ status: 404, body: { message: "Not Found" } }]);
    await expect(
      backendWith(missing).wake({ buildNumber: 5, sandboxId: "dsh-b" }),
    ).rejects.toBeInstanceOf(SandboxNotFoundError);

    const running = fakeApi([
      { body: { number: 6, state: "running", web_url: "https://bk/6" } },
    ]);
    expect(
      await backendWith(running).wake({ buildNumber: 6, sandboxId: "dsh-c" }),
    ).toEqual({
      sandboxId: "dsh-c",
      reference: { buildNumber: 6, sandboxId: "dsh-c" },
    });
  });

  it("treats only a running build as healthy and tolerates cancelling twice", async () => {
    const api = fakeApi([
      { body: { number: 8, state: "running", web_url: "https://bk/8" } },
      { body: { number: 8, state: "passed", web_url: "https://bk/8" } },
      { status: 422, body: { message: "Build is already finished" } },
      { status: 500, body: { message: "boom" } },
    ]);
    const backend = backendWith(api);
    const reference = { buildNumber: 8, sandboxId: "dsh-d" };

    expect(await backend.health(reference)).toBe(true);
    expect(await backend.health(reference)).toBe(false);
    await expect(backend.destroy(reference)).resolves.toBeUndefined();
    await expect(backend.destroy(reference)).rejects.toThrow("failed with 500");
    await expect(backend.hibernate()).rejects.toThrow("cannot be suspended");
  });

  it("derives a sandbox id from the session with a per-build suffix", () => {
    const first = buildkiteTesting.sandboxName("session-one");
    const second = buildkiteTesting.sandboxName("session-one");
    expect(first.slice(0, 21)).toBe(second.slice(0, 21));
    expect(first).not.toBe(second);
    expect(() =>
      buildkiteTesting.buildkiteReference({ claimName: "x" }),
    ).toThrow("invalid Buildkite sandbox reference");
  });

  it("resolves a Buildkite profile and requires its token per request", async () => {
    const config = resolveConfig({
      profiles: {
        hosted: {
          backend: "buildkite",
          organization: "acme",
          pipeline: "dsh-yawn",
          controlPlaneUrl: "wss://dsh.example.com/tunnel",
          secretKey: "DSH_YAWN_HOSTED_TOKEN",
        },
      },
    });
    expect(config.profiles).toEqual({
      hosted: {
        name: "hosted",
        backend: "buildkite",
        organization: "acme",
        pipeline: "dsh-yawn",
        image: DEFAULT_RUNNER_IMAGE,
        controlPlaneUrl: "wss://dsh.example.com/tunnel",
        readyTimeoutMs: 600_000,
        secretKey: "DSH_YAWN_HOSTED_TOKEN",
      },
    });

    vi.stubEnv("BUILDKITE_API_TOKEN", "");
    const hosted = config.profiles.hosted;
    if (hosted?.backend !== "buildkite") {
      throw new Error("expected a Buildkite profile");
    }
    // Resolution happens per request, not at construction: the backend is
    // built without a token, and a call fails with the setting to fix.
    const backend = managerTesting.createBackend(
      hosted,
      () => "registration-token",
    );
    expect(backend).toBeInstanceOf(BuildkiteBackend);
    expect(backend.capabilities).toEqual({ supportsHibernate: false });
    await expect(resolveBuildkiteToken(hosted, undefined)).rejects.toThrow(
      "needs a Buildkite API token: enter one in Settings → Sandboxes, or set BUILDKITE_API_TOKEN on the control plane",
    );

    vi.stubEnv("BUILDKITE_API_TOKEN", "bkua_test");
    await expect(resolveBuildkiteToken(hosted, undefined)).resolves.toBe(
      "bkua_test",
    );
    vi.unstubAllEnvs();
  });
});
