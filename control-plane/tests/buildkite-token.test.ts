import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveBuildkiteToken,
  type CredentialResolver,
} from "../src/buildkite-token.js";
import { resolveConfig } from "../src/config.js";
import type { BuildkiteProfile } from "../src/types.js";

const TOKEN_ENV = "DSH_YAWN_TEST_BUILDKITE_TOKEN";

function testProfile(): BuildkiteProfile {
  const config = resolveConfig({
    profiles: {
      hosted: {
        backend: "buildkite",
        organization: "acme",
        pipeline: "dsh-yawn",
        controlPlaneUrl: "wss://dsh.example.com/tunnel",
      },
    },
  });
  const profile = config.profiles.hosted;
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

  it("prefers the host credential service over the environment", async () => {
    vi.stubEnv(TOKEN_ENV, "from-environment");
    await expect(
      resolveBuildkiteToken(
        testProfile(),
        credentialsWith({ [TOKEN_ENV]: "from-credential-document" }),
      ),
    ).resolves.toBe("from-credential-document");
  });

  it("falls back to the environment when the service holds nothing", async () => {
    vi.stubEnv(TOKEN_ENV, "from-environment");
    await expect(
      resolveBuildkiteToken(testProfile(), credentialsWith({})),
    ).resolves.toBe("from-environment");
  });

  it("falls back to the environment when no service is mounted", async () => {
    vi.stubEnv(TOKEN_ENV, "from-environment");
    await expect(resolveBuildkiteToken(testProfile(), undefined)).resolves.toBe(
      "from-environment",
    );
  });

  it("names both sources when neither holds a token", async () => {
    vi.stubEnv(TOKEN_ENV, "");
    await expect(
      resolveBuildkiteToken(testProfile(), credentialsWith({})),
    ).rejects.toThrow(
      new RegExp(`needs a Buildkite API token in ${TOKEN_ENV}`),
    );
  });
});
