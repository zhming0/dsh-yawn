import {
  credentialRef,
  isCredentialRefName,
  type CredentialRef,
} from "@deepseek-ai/dsh-credentials";

import type { RuntimeConfig } from "./config.js";
import type { BuildkiteProfile } from "./types.js";

/**
 * The slice of the host credential service this package consumes. The real
 * provider is resolved per request through the process environment and the
 * managed credential document in that priority, exactly as every other
 * credential reference in the harness is.
 */
export interface CredentialResolver {
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>;
}

/**
 * Resolve the API token for one Buildkite profile: first the credential
 * reference the profile stores it under — entered on the Sandboxes page, and
 * answered by the host credential service from the process environment and
 * the managed `$DSH_HOME/.credentials.yaml` — then the ambient environment
 * variable named by `tokenEnv` as the deployment's fallback.
 *
 * The token must never reach a runner. Both sources are host-side; the broker
 * store, which is pushed into sandboxes, is not involved.
 */
export async function resolveBuildkiteToken(
  profile: BuildkiteProfile,
  credentials: CredentialResolver | undefined,
): Promise<string> {
  if (
    credentials !== undefined &&
    isCredentialRefName(profile.tokenCredential)
  ) {
    const resolved = await credentials.resolve(
      credentialRef(profile.tokenCredential),
    );
    if (resolved !== undefined) {
      return resolved.value;
    }
  }
  const ambient = process.env[profile.tokenEnv];
  if (ambient !== undefined && ambient.trim() !== "") {
    return ambient.trim();
  }
  throw new Error(
    `profile ${profile.name} needs a Buildkite API token: enter one on the Sandboxes page (stored as ${profile.tokenCredential}) or set ${profile.tokenEnv}`,
  );
}

/**
 * Refuse a profile whose explicit `tokenCredential` is not a reference the
 * credential seam can address, at write time rather than by silently falling
 * back to the environment.
 */
export function assertBuildkiteTokenCredentials(config: RuntimeConfig): void {
  for (const [name, profile] of Object.entries(config.profiles ?? {})) {
    if (
      profile.backend === "buildkite" &&
      profile.tokenCredential !== undefined &&
      !isCredentialRefName(profile.tokenCredential)
    ) {
      throw new Error(
        `profile ${name}: tokenCredential ${profile.tokenCredential} is not a credential reference (a POSIX-style name such as ACME_BUILDKITE_TOKEN)`,
      );
    }
  }
}
