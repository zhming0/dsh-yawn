/**
 * The host credential seam for an in-process plugin that talks to a Git host.
 *
 * dsh's generic `ctx.credentials` is a reference resolver for host providers;
 * this deployment's sandbox secrets live in the credential broker, which has
 * global and Workspace scopes. A plugin such as the PR panel asks this service
 * for the credential of one host and optional repository, and gets the same
 * Git credential the broker would resolve for that scope, without reading the
 * broker file or importing this package.
 *
 * The service is optional for the client. Cordis has no optional `inject`, so
 * a generic consumer must look it up per call with `ctx.get("forgeCredentials")`
 * (or this module's `getForgeCredentials`) and never put it in a required
 * `inject`; a host without this bundle must still load the consumer.
 *
 * @module @zhming0/dsh-yawn/forge-credentials
 */

import type { Context } from "@deepseek-ai/cordis";

/** What one plugin request names: a Git host, and optionally one repository. */
export interface ForgeCredentialRequest {
  /** Host as Git sends it, such as `github.com` or `git.example.com:8443`. */
  host: string;
  /** Repository URL; its Workspace secret overrides the global one when present. */
  repositoryUrl?: string;
}

/** One resolved credential. `password` is the token for token-based hosts. */
export interface ForgeCredential {
  username: string;
  password: string;
}

/** The service surface a plugin consumes. */
export interface ForgeCredentials {
  resolve(
    request: ForgeCredentialRequest,
  ): Promise<ForgeCredential | undefined>;
}

/**
 * Read the optional service without requiring it at load time.
 * @param ctx - any plugin context.
 * @returns the service, or undefined on a host without this bundle.
 */
export function getForgeCredentials(
  ctx: Context,
): ForgeCredentials | undefined {
  return ctx.get("forgeCredentials") as ForgeCredentials | undefined;
}

export const name = "sandbox-forge-credentials";
export const inject = ["sandboxManager"];

/**
 * Register the broker-backed credential source.
 * @param ctx - plugin context; `sandboxManager` owns the broker.
 */
export function apply(ctx: Context): void {
  ctx.provide("forgeCredentials", {
    async resolve(
      request: ForgeCredentialRequest,
    ): Promise<ForgeCredential | undefined> {
      const credential = await ctx.sandboxManager.gitCredential(
        request.host,
        request.repositoryUrl,
      );
      return credential === undefined
        ? undefined
        : { username: credential.username, password: credential.password };
    },
  });
}
