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
      { namespace: "test", warmPool: "test", registrationToken: "token-value" },
      api,
      secretsAccepted(),
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
      {
        namespace: "test",
        warmPool: "dsh-large",
        registrationToken: "token-value",
      },
      api,
      secretsAccepted(),
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

  it("stores the tunnel token in the namespace Secret as a merge patch", async () => {
    const patches: unknown[] = [];
    const contentTypes: string[] = [];
    const core = {
      async patchNamespacedSecret(
        request: unknown,
        options: { middleware: Array<{ pre(request: unknown): unknown }> },
      ) {
        patches.push(request);
        // Run the header middleware the backend passed, as the client would.
        for (const middleware of options.middleware) {
          middleware.pre({
            setHeaderParam: (key: string, value: string) => {
              if (key === "Content-Type") {
                contentTypes.push(value);
              }
            },
          });
        }
        return {};
      },
    } as unknown as CoreV1Api;
    const backend = new KasBackend(
      { namespace: "test", warmPool: "test", registrationToken: "token-value" },
      {} as unknown as CustomObjectsApi,
      core,
    );

    await backend.storeRegistrationToken();

    expect(patches).toEqual([
      {
        name: REGISTRATION_TOKEN_SECRET,
        namespace: "test",
        body: { stringData: { token: "token-value" } },
      },
    ]);
    // The API server rejects an object body sent as a JSON Patch.
    expect(contentTypes).toEqual(["application/merge-patch+json"]);
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
      { namespace: "test", warmPool: "test", registrationToken: "token-value" },
      {} as unknown as CustomObjectsApi,
      core,
    );

    await backend.storeRegistrationToken();

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

  it("fails a claim with the reason the Secret write failed, then retries", async () => {
    let allowed = false;
    const core = {
      async patchNamespacedSecret() {
        if (!allowed) {
          throw kubernetesError(403);
        }
        return {};
      },
    } as unknown as CoreV1Api;
    const claims: unknown[] = [];
    const api = {
      async createNamespacedCustomObject(request: unknown) {
        claims.push(request);
        return {};
      },
      async getNamespacedCustomObject(request: { plural: string }) {
        return request.plural === "sandboxclaims"
          ? {
              status: {
                sandbox: { name: "sandbox-one" },
                conditions: [{ type: "Ready", status: "True" }],
              },
            }
          : { status: { conditions: [{ type: "Ready", status: "True" }] } };
      },
    } as unknown as CustomObjectsApi;
    const backend = new KasBackend(
      { namespace: "test", warmPool: "test", registrationToken: "token-value" },
      api,
      core,
    );
    const spec = {
      sessionId: "session-one",
      repositoryUrl: "https://github.com/example/repo.git",
    };

    // A warm pod could not read the token, so no claim is made at all.
    await expect(backend.provision(spec)).rejects.toThrow(
      `could not store the runner token in Secret test/${REGISTRATION_TOKEN_SECRET}: kubernetes status 403`,
    );
    expect(claims).toEqual([]);

    allowed = true;
    await expect(backend.provision(spec)).resolves.toMatchObject({
      sandboxId: "sandbox-one",
    });
    expect(claims).toHaveLength(1);
  });
});

/** A core API that accepts every Secret patch. */
function secretsAccepted(): CoreV1Api {
  return {
    async patchNamespacedSecret() {
      return {};
    },
  } as unknown as CoreV1Api;
}

/** The Kubernetes client rejects with an error carrying the HTTP status. */
function kubernetesError(code: number): Error {
  return Object.assign(new Error(`kubernetes status ${code}`), { code });
}
