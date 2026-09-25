import type { CoreV1Api, CustomObjectsApi } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import {
  KasBackend,
  REGISTRATION_TOKEN_SECRET,
  testing as kasTesting,
} from "../src/backends/kas.js";

describe("kubernetes backend", () => {
  it("derives stable claim names", () => {
    expect(kasTesting.claimNameFor("session one")).toMatch(
      /^dsh-[a-f0-9]{20}$/,
    );
  });

  it("can retry a Kubernetes wake after expiry was already cleared", async () => {
    const patches: Array<{ plural: string; body: unknown }> = [];
    const api = {
      async getNamespacedCustomObject(request: { plural: string }) {
        return request.plural === "sandboxclaims"
          ? {
              spec: {},
              status: { sandbox: { name: "sandbox-one" } },
            }
          : {
              status: {
                conditions: [{ type: "Ready", status: "True" }],
              },
            };
      },
      async patchNamespacedCustomObject(request: {
        plural: string;
        body: unknown;
      }) {
        patches.push(request);
        return {};
      },
    } as unknown as CustomObjectsApi;
    const backend = new KasBackend(
      { namespace: "test", warmPool: "test" },
      api,
    );

    const result = await backend.wake({
      claimName: "claim-one",
      sandboxId: "sandbox-one",
    });

    expect(result).toEqual({
      sandboxId: "sandbox-one",
      reference: { claimName: "claim-one", sandboxId: "sandbox-one" },
    });
    expect(patches).toEqual([
      {
        group: "agents.x-k8s.io",
        version: "v1beta1",
        namespace: "test",
        plural: "sandboxes",
        name: "sandbox-one",
        body: [{ op: "add", path: "/spec/operatingMode", value: "Running" }],
      },
    ]);
  });

  it("provisions a Kubernetes sandbox once its claim is assigned", async () => {
    const reads: string[] = [];
    const claims: Array<{ body: { spec: unknown } }> = [];
    const api = {
      async createNamespacedCustomObject(request: { body: { spec: unknown } }) {
        claims.push(request);
        return {};
      },
      async getNamespacedCustomObject(request: { plural: string }) {
        reads.push(request.plural);
        return request.plural === "sandboxclaims"
          ? {
              status: {
                sandbox: { name: "sandbox-one" },
                conditions: [{ type: "Ready", status: "True" }],
              },
            }
          : {
              status: {
                conditions: [{ type: "Ready", status: "True" }],
              },
            };
      },
    } as unknown as CustomObjectsApi;
    const backend = new KasBackend(
      { namespace: "test", warmPool: "dsh-large" },
      api,
    );

    const result = await backend.provision({
      sessionId: "session-one",
      repositoryUrl: "https://github.com/example/repo.git",
    });

    expect(result).toEqual({
      sandboxId: "sandbox-one",
      reference: {
        claimName: kasTesting.claimNameFor("session-one"),
        sandboxId: "sandbox-one",
      },
    });
    expect(reads).toEqual(["sandboxclaims", "sandboxes"]);
    expect(claims.map((claim) => claim.body.spec)).toEqual([
      { warmPoolRef: { name: "dsh-large" } },
    ]);
  });

  it("publishes the tunnel token into the namespace Secret", async () => {
    const patches: unknown[] = [];
    const core = {
      async patchNamespacedSecret(request: unknown) {
        patches.push(request);
        return {};
      },
    } as unknown as CoreV1Api;
    const backend = new KasBackend(
      { namespace: "test", warmPool: "test" },
      {} as unknown as CustomObjectsApi,
      core,
    );

    await backend.publishRegistrationToken("token-value");

    expect(patches).toEqual([
      {
        name: REGISTRATION_TOKEN_SECRET,
        namespace: "test",
        body: {
          metadata: { name: REGISTRATION_TOKEN_SECRET, namespace: "test" },
          stringData: { token: "token-value" },
        },
      },
    ]);
  });

  it("creates the Secret when nothing owns it yet", async () => {
    const created: unknown[] = [];
    const core = {
      async patchNamespacedSecret() {
        throw kubernetesError(404);
      },
      async createNamespacedSecret(request: unknown) {
        created.push(request);
        return {};
      },
    } as unknown as CoreV1Api;
    const backend = new KasBackend(
      { namespace: "test", warmPool: "test" },
      {} as unknown as CustomObjectsApi,
      core,
    );

    await backend.publishRegistrationToken("token-value");

    expect(created).toEqual([
      {
        namespace: "test",
        body: {
          metadata: {
            name: REGISTRATION_TOKEN_SECRET,
            namespace: "test",
          },
          stringData: { token: "token-value" },
          type: "Opaque",
        },
      },
    ]);
  });

  it("reports a create it is not allowed to make", async () => {
    const core = {
      async patchNamespacedSecret() {
        throw kubernetesError(404);
      },
      async createNamespacedSecret() {
        throw kubernetesError(403);
      },
    } as unknown as CoreV1Api;
    const backend = new KasBackend(
      { namespace: "test", warmPool: "test" },
      {} as unknown as CustomObjectsApi,
      core,
    );

    await expect(
      backend.publishRegistrationToken("token-value"),
    ).rejects.toThrow(
      `could not create Secret test/${REGISTRATION_TOKEN_SECRET}`,
    );
  });
});

/** The Kubernetes client rejects with an error carrying the HTTP status. */
function kubernetesError(code: number): Error {
  return Object.assign(new Error(`kubernetes status ${code}`), { code });
}
