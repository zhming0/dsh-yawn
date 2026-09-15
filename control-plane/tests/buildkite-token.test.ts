import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveBuildkiteToken,
  type CredentialResolver,
} from "../src/buildkite-token.js";
import { resolveConfig } from "../src/config.js";
import type { BuildkiteProfile } from "../src/types.js";

const TOKEN_ENV = "DSH_YAWN_TEST_BUILDKITE_TOKEN";

function profileOf(name: string): BuildkiteProfile {
  const config = resolveConfig({
    profiles: {
      [name]: {
        backend: "buildkite",
        organization: "acme",
        pipeline: "dsh-yawn",
        controlPlaneUrl: "wss://dsh.example.com/tunnel",
      },
    },
  });
  const profile = config.profiles[name];
  if (profile?.backend !== "buildkite") {
    throw new Error("expected a Buildkite profile");
  }
  return { ...profile, tokenEnv: TOKEN_ENV };
}

/** A credential service double holding one value per reference. */
function credentialsWith(values: Record<string, string>): CredentialResolver {
  return {
    async resolve(ref) {
      const value = values[String(ref)];
      return value === undefined ? undefined : { value };
    },
  };
}

describe("resolveBuildkiteToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("derives one credential name per profile", () => {
    expect(profileOf("hosted").tokenCredential).toBe(
      "DSH_YAWN_BUILDKITE_HOSTED_TOKEN",
    );
    expect(profileOf("second-org").tokenCredential).toBe(
      "DSH_YAWN_BUILDKITE_SECOND_ORG_TOKEN",
    );
  });

  it("honours a credential name the profile names explicitly", () => {
    const config = resolveConfig({
      profiles: {
        hosted: {
          backend: "buildkite",
          organization: "acme",
          pipeline: "dsh-yawn",
          controlPlaneUrl: "wss://dsh.example.com/tunnel",
          tokenCredential: "ACME_BUILDKITE_TOKEN",
        },
      },
    });
    const profile = config.profiles.hosted;
    expect(profile?.backend === "buildkite" && profile.tokenCredential).toBe(
      "ACME_BUILDKITE_TOKEN",
    );
  });

  it("prefers the profile's stored credential over the environment", async () => {
    vi.stubEnv(TOKEN_ENV, "from-environment");
    await expect(
      resolveBuildkiteToken(
        profileOf("hosted"),
        credentialsWith({
          DSH_YAWN_BUILDKITE_HOSTED_TOKEN: "from-credential-document",
        }),
      ),
    ).resolves.toBe("from-credential-document");
  });

  it("falls back to the environment when the credential holds nothing", async () => {
    vi.stubEnv(TOKEN_ENV, "from-environment");
    await expect(
      resolveBuildkiteToken(profileOf("hosted"), credentialsWith({})),
    ).resolves.toBe("from-environment");
  });

  it("falls back to the environment when no service is mounted", async () => {
    vi.stubEnv(TOKEN_ENV, "from-environment");
    await expect(
      resolveBuildkiteToken(profileOf("hosted"), undefined),
    ).resolves.toBe("from-environment");
  });

  it("names the credential and the environment when neither holds a token", async () => {
    vi.stubEnv(TOKEN_ENV, "");
    await expect(
      resolveBuildkiteToken(profileOf("hosted"), credentialsWith({})),
    ).rejects.toThrow(
      /needs a Buildkite API token: enter one on the Sandboxes page \(stored as DSH_YAWN_BUILDKITE_HOSTED_TOKEN\) or set DSH_YAWN_TEST_BUILDKITE_TOKEN/,
    );
  });
});
