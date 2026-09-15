import {
  credentialRef,
  isCredentialRefName,
  type CredentialRef,
} from "@deepseek-ai/dsh-credentials";

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
 * Resolve the API token for one Buildkite profile: the credential reference
 * named by `tokenEnv`, answered by the host credential service (process
 * environment, then the managed `$DSH_HOME/.credentials.yaml`), or the
 * process environment alone when no service is mounted.
 *
 * The token must never reach a runner. Storing it under a reference keeps it
 * in the host-side credential document, which is never pushed into a sandbox;
 * the broker store, which is, is not involved.
 */
export async function resolveBuildkiteToken(
  profile: BuildkiteProfile,
  credentials: CredentialResolver | undefined,
): Promise<string> {
  if (credentials !== undefined && isCredentialRefName(profile.tokenEnv)) {
    const resolved = await credentials.resolve(credentialRef(profile.tokenEnv));
    if (resolved !== undefined) {
      return resolved.value;
    }
  }
  const ambient = process.env[profile.tokenEnv];
  if (ambient !== undefined && ambient.trim() !== "") {
    return ambient.trim();
  }
  throw new Error(
    `profile ${profile.name} needs a Buildkite API token in ${profile.tokenEnv}, or stored under that name in the host credential document`,
  );
}
