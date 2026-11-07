import { resolveConfig } from "./sandbox/config.js";
import SandboxManager from "./sandbox/manager/index.js";

/**
 * The control-plane entry. `SandboxManager` — the bundle row this package
 * inserts — lives in sandbox/manager/sandbox-manager.ts; this file only
 * re-exports the package surface. Config types and settings resolution live in
 * sandbox/config.ts.
 */
export { BuildkiteBackend } from "./sandbox/backends/buildkite.js";
export { DockerBackend } from "./sandbox/backends/docker.js";
export { KasBackend } from "./sandbox/backends/kas.js";
export {
  CredentialBroker,
  normalizeRepositoryUrl,
} from "./credentials/broker.js";
export type {
  ForgeCredential,
  ForgeCredentialRequest,
  ForgeCredentials,
} from "./credentials/forge-credentials.js";
export type { Config, ProfileConfig } from "./sandbox/config.js";
export type { ManagerDependencies } from "./sandbox/manager/index.js";
export { SandboxManager };
export default SandboxManager;
export { TunnelServer } from "./core/tunnel.js";
export type { RunnerGateway } from "./core/tunnel.js";
export { SandboxNotFoundError } from "./core/types.js";
export type { SandboxBackend } from "./core/types.js";

/** Internals the test suite reaches into. */
export const testing = { resolveConfig };
