import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import z from "@deepseek-ai/schemastery";
import type { Volatile } from "@deepseek-ai/cosmokit";

import { DEFAULT_RUNNER_IMAGE } from "./runner-image.js";
import type { SandboxProfile } from "./types.js";

// Queue wait is the unknown here: a hosted queue dispatches in seconds, a
// self-hosted one may be busy.
export const DEFAULT_BUILDKITE_READY_TIMEOUT_MS = 10 * 60_000;

/** A profile as written in the settings file: a backend plus its settings. */
export type ProfileConfig =
  | {
      backend: "docker";
      image?: string;
      binary?: string;
      controlPlaneUrl?: string;
    }
  | {
      backend: "kas";
      namespace?: string;
      warmPool?: string;
      readyTimeoutMs?: number;
      kubeconfig?: string;
    }
  | {
      backend: "buildkite";
      organization: string;
      pipeline: string;
      controlPlaneUrl: string;
      image?: string;
      readyTimeoutMs?: number;
    };

/**
 * One runtime setting as it can arrive: a volatile reference when the Loader
 * mounted the row (the settings form edits those live), a plain value in
 * tests and static overlays.
 */
export type RuntimeSetting<T> = Volatile<T | undefined> | T | undefined;

/** Read the current value of one runtime setting, whatever form it takes. */
interface VolatileReader<T> {
  get(): T | undefined;
}

export function readSetting<T>(value: RuntimeSetting<T>): T | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function"
  ) {
    // The snapshot type is structural; the reference owns the value's type.
    return (value as VolatileReader<T>).get();
  }
  return value as T | undefined;
}

export interface Config {
  /**
   * Named sandbox profiles a session can choose from before its first prompt.
   * An empty map is allowed: the host boots and serves sessions, but no
   * sandbox can be provisioned until a profile is added. Volatile: the Web
   * Sandboxes page edits these live through the settings form.
   */
  profiles?: RuntimeSetting<Record<string, ProfileConfig>>;
  /** Profile used when the session did not pick one. Defaults to the first. */
  defaultProfile?: RuntimeSetting<string>;
  stateDir?: string;
  repository?: string;
  revision?: string;
  workspace?: string;
  idleMs?: RuntimeSetting<number>;
  expiresAfterMs?: RuntimeSetting<number>;
  registrationToken?: string;
  tunnel?: {
    port?: number;
    bind?: string;
  };
  /**
   * Previews: each sandbox port is served at its own origin,
   * `<sandboxId>-p<port>.<domain>`. Without a domain the preview listener
   * does not start and the Preview tab explains what is missing.
   */
  preview?: {
    /** A bare host, no scheme, such as `sandbox.example.com`. */
    domain?: string;
    port?: number;
    bind?: string;
  };
}

export interface ResolvedConfig {
  profiles: Record<string, SandboxProfile>;
  /**
   * Undefined when no profile is configured. Provisioning then fails with a
   * message naming the missing settings instead of the host failing to boot.
   */
  defaultProfile: string | undefined;
  stateDir: string;
  repository?: string;
  revision: string;
  workspace: string;
  idleMs: number;
  expiresAfterMs: number;
  registrationToken?: string;
  tunnel: { port: number; bind: string };
  preview: { domain: string | undefined; port: number; bind: string };
}

/**
 * The settings that can change while the host runs: sandbox profiles and the
 * idle and expiry timers. Everything else in {@link Config} shapes the boot
 * (state directories, the tunnel listener, the registration token) and is
 * read once.
 */
export type RuntimeConfig = Pick<
  Config,
  "profiles" | "defaultProfile" | "idleMs" | "expiresAfterMs"
>;

/** {@link ResolvedConfig} minus the boot-only fields. */
export interface ResolvedRuntime {
  profiles: Record<string, SandboxProfile>;
  /**
   * Undefined when no profile is configured. Provisioning then fails with a
   * message naming the missing settings instead of the host failing to boot.
   */
  defaultProfile: string | undefined;
  idleMs: number;
  expiresAfterMs: number;
}

/**
 * The fields of the runtime slice, built fresh for each schema so the row
 * schema and the settings namespace schema can never share a schema instance
 * or disagree about a default.
 */
const runtimeFields = () => ({
  profiles: z
    .dict(
      z.union([
        z.object({
          backend: z.const("docker").required(),
          image: z.string().default(DEFAULT_RUNNER_IMAGE),
          binary: z.string(),
          controlPlaneUrl: z.string(),
        }),
        z.object({
          backend: z.const("kas").required(),
          namespace: z.string().default("dsh-yawn"),
          warmPool: z.string().default("dsh-yawn-universal"),
          readyTimeoutMs: z.number().min(1).default(180_000),
          kubeconfig: z.string(),
        }),
        z.object({
          backend: z.const("buildkite").required(),
          organization: z.string().required(),
          pipeline: z.string().required(),
          controlPlaneUrl: z.string().required(),
          image: z.string().default(DEFAULT_RUNNER_IMAGE),
          readyTimeoutMs: z
            .number()
            .min(1)
            .default(DEFAULT_BUILDKITE_READY_TIMEOUT_MS),
        }),
      ]),
    )
    .default({}),
  defaultProfile: z.string(),
  idleMs: z
    .number()
    .min(1)
    .default(10 * 60_000),
  expiresAfterMs: z
    .number()
    .min(1)
    .default(7 * 24 * 60 * 60_000),
});

/**
 * The schema cordis validates the row config against. The runtime slice is
 * volatile, so the settings service projects exactly those fields as this
 * row's live form and edits reach the running host through the Loader's
 * volatile update. Every default here must stay in sync with resolveConfig,
 * which applies the same defaults at runtime.
 */
const volatileRuntimeFields = () => {
  const fields = runtimeFields();
  return {
    profiles: fields.profiles.volatile(),
    defaultProfile: fields.defaultProfile.volatile(),
    idleMs: fields.idleMs.volatile(),
    expiresAfterMs: fields.expiresAfterMs.volatile(),
  };
};

// The volatile field wrappers widen the schema's inferred output past what
// the annotation can express, so the assembled schema is asserted onto the
// Config shape the rest of the package reads.
export const configSchema = z.object({
  ...volatileRuntimeFields(),
  stateDir: z.string(),
  repository: z.string(),
  revision: z.string().default(""),
  workspace: z.string().default("/workspace/repository"),
  registrationToken: z.string(),
  tunnel: z.object({
    port: z.natural().min(1).max(65_535).default(8081),
    bind: z.string().default("0.0.0.0"),
  }),
  preview: z.object({
    domain: z.string(),
    port: z.natural().min(1).max(65_535).default(8082),
    bind: z.string().default("0.0.0.0"),
  }),
});

/**
 * Apply every default and check the runtime slice holds together. A
 * configuration with no profiles is valid: the host comes up without a
 * backend, and the first prompt explains what to add.
 */
export function resolveRuntime(
  config: RuntimeConfig,
  tunnelPort: number,
): ResolvedRuntime {
  const rawProfiles = readSetting(config.profiles) ?? {};
  const rawDefaultProfile = readSetting(config.defaultProfile);
  const rawIdleMs = readSetting(config.idleMs);
  const rawExpiresAfterMs = readSetting(config.expiresAfterMs);
  const profiles = Object.fromEntries(
    Object.entries(rawProfiles).map(([name, profile]) => [
      name,
      resolveProfile(name, profile, tunnelPort),
    ]),
  );
  const configured = Object.keys(profiles);
  // With no profiles there is nothing for defaultProfile to select, so a
  // leftover name is ignored rather than stopping the host from booting; the
  // first prompt reports the missing profile instead.
  const defaultProfile =
    configured.length === 0 ? undefined : (rawDefaultProfile ?? configured[0]);
  if (defaultProfile !== undefined && profiles[defaultProfile] === undefined) {
    throw new Error(
      `defaultProfile ${defaultProfile} is not a configured profile`,
    );
  }
  const resolved: ResolvedRuntime = {
    profiles,
    defaultProfile,
    idleMs: rawIdleMs ?? 10 * 60_000,
    expiresAfterMs: rawExpiresAfterMs ?? 7 * 24 * 60 * 60_000,
  };
  for (const [name, value] of [
    ["idleMs", resolved.idleMs],
    ["expiresAfterMs", resolved.expiresAfterMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be positive`);
    }
  }
  return resolved;
}

/**
 * Apply every default and check the settings hold together. A configuration
 * with no profiles is valid: the host comes up without a backend, and the
 * first prompt explains what to add.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const tunnelPort = config.tunnel?.port ?? 8081;
  return assembleConfig(config, resolveRuntime(config, tunnelPort));
}

/**
 * The boot face of {@link resolveConfig}. Since dsh 0.1.7, settings-form
 * writes persist into the profile's own `cordis.patch.yml` — the same file
 * the Loader reads at boot — and the form validates against the row schema
 * alone, so a semantically bad but schema-valid value (a `defaultProfile`
 * naming no profile, a `controlPlaneUrl` that is not a WebSocket URL) can be
 * saved. This resolver degrades that slice instead of throwing: the bad
 * pieces drop with one warning each, the host still boots, and the operator
 * fixes the value in the form. Boot-authored fields (state directories, the
 * tunnel, the preview domain) stay strict — an image that ships them broken
 * must fail loudly.
 *
 * Every warning explains what was ignored, so a degraded boot is legible in
 * the control-plane log.
 */
/**
 * The boot face of {@link resolveConfig}. Since dsh 0.1.7, settings-form
 * writes persist into the profile's own `cordis.patch.yml` — the same file
 * the Loader reads at boot — and the form validates against the row schema
 * alone, so a semantically bad but schema-valid value (a `defaultProfile`
 * naming no profile, a `controlPlaneUrl` that is not a WebSocket URL) can be
 * saved. The boot resolver degrades that slice instead of throwing; see
 * {@link resolveDegradingRuntime}.
 */
export function resolveBootConfig(config: Config): {
  config: ResolvedConfig;
  warnings: string[];
} {
  const { runtime, warnings } = resolveDegradingRuntime(
    config,
    config.tunnel?.port ?? 8081,
  );
  return { config: assembleConfig(config, runtime), warnings };
}

/**
 * Resolve the runtime slice piece by piece: a broken profile drops with one
 * warning, a `defaultProfile` naming no remaining profile falls back to the
 * first, and an out-of-range timer restores its default. Boot and the
 * running host both read through this, so a value that survives a restart
 * also applies live -- only the pieces that cannot work are ignored.
 */
export function resolveDegradingRuntime(
  config: RuntimeConfig,
  tunnelPort: number,
): { runtime: ResolvedRuntime; warnings: string[] } {
  const warnings: string[] = [];

  const rawProfiles = readSetting(config.profiles) ?? {};
  const profiles: Record<string, SandboxProfile> = {};
  for (const [name, profile] of Object.entries(rawProfiles)) {
    try {
      profiles[name] = resolveProfile(name, profile, tunnelPort);
    } catch (error) {
      warnings.push(
        `ignoring sandbox profile ${name}, which the host cannot apply: ${messageOf(error)}`,
      );
    }
  }

  const configured = Object.keys(profiles);
  // The unset case matches the strict resolver: the first configured profile
  // is the default, so a fresh installation with profiles picks one without
  // an explicit setting.
  const named = readSetting(config.defaultProfile);
  let defaultProfile =
    configured.length === 0 ? undefined : (named ?? configured[0]);
  if (defaultProfile !== undefined && profiles[defaultProfile] === undefined) {
    warnings.push(
      `defaultProfile ${named} names no configured profile; using ${configured[0]}`,
    );
    defaultProfile = configured[0];
  }

  const runtime: ResolvedRuntime = {
    profiles,
    defaultProfile,
    idleMs: bootTimer(config, "idleMs", 10 * 60_000, warnings),
    expiresAfterMs: bootTimer(
      config,
      "expiresAfterMs",
      7 * 24 * 60 * 60_000,
      warnings,
    ),
  };

  return { runtime, warnings };
}

function assembleConfig(
  config: Config,
  runtime: ResolvedRuntime,
): ResolvedConfig {
  const tunnelPort = config.tunnel?.port ?? 8081;
  const stateDir = config.stateDir ?? join(homedir(), ".dsh-yawn");
  const resolved: ResolvedConfig = {
    ...runtime,
    stateDir,
    ...(config.repository === undefined
      ? {}
      : { repository: config.repository }),
    revision: config.revision ?? "",
    workspace: config.workspace ?? "/workspace/repository",
    ...(config.registrationToken === undefined
      ? {}
      : { registrationToken: config.registrationToken }),
    tunnel: {
      port: tunnelPort,
      bind: config.tunnel?.bind ?? "0.0.0.0",
    },
    preview: {
      domain: checkPreviewDomain(config.preview?.domain),
      port: config.preview?.port ?? 8082,
      bind: config.preview?.bind ?? "0.0.0.0",
    },
  };
  if (!resolved.workspace.startsWith("/")) {
    throw new Error("workspace must be an absolute Linux path");
  }
  return resolved;
}

/**
 * The preview domain is baked into host names both sides match exactly, so a
 * scheme, a path, or an uppercase spelling must fail the boot rather than
 * silently never match. An empty or absent domain disables previews.
 */
function checkPreviewDomain(domain: string | undefined): string | undefined {
  if (domain === undefined || domain.trim() === "") {
    return undefined;
  }
  const lowered = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(lowered) || lowered.includes("..")) {
    throw new Error(
      `preview domain ${domain} must be a bare host, such as sandbox.example.com`,
    );
  }
  return lowered;
}

/** One timer with the degrading fallback: the schema rejects negatives at
 * the form, a hand-edited patch may still carry one, and resolution degrades
 * with a note instead of failing the whole slice. */
function bootTimer(
  config: RuntimeConfig,
  key: "idleMs" | "expiresAfterMs",
  fallback: number,
  warnings: string[],
): number {
  const value = readSetting(config[key]);
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    warnings.push(`${key} ${value} must be positive; using ${fallback}`);
    return fallback;
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveProfile(
  name: string,
  profile: ProfileConfig,
  tunnelPort: number,
): SandboxProfile {
  if (profile.backend === "docker") {
    return {
      name,
      backend: "docker",
      image: profile.image ?? DEFAULT_RUNNER_IMAGE,
      ...(profile.binary === undefined ? {} : { binary: profile.binary }),
      // host-gateway resolves the Docker host from inside a container on
      // every Docker platform, so runners reach the host tunnel by default.
      controlPlaneUrl: checkControlPlaneUrl(
        name,
        profile.controlPlaneUrl ??
          `ws://host.docker.internal:${tunnelPort}/tunnel`,
      ),
    };
  }
  if (profile.backend === "buildkite") {
    return {
      name,
      backend: "buildkite",
      organization: profile.organization,
      pipeline: profile.pipeline,
      image: profile.image ?? DEFAULT_RUNNER_IMAGE,
      controlPlaneUrl: checkControlPlaneUrl(name, profile.controlPlaneUrl),
      readyTimeoutMs:
        profile.readyTimeoutMs ?? DEFAULT_BUILDKITE_READY_TIMEOUT_MS,
    };
  }
  return {
    name,
    backend: "kas",
    namespace: profile.namespace ?? "dsh-yawn",
    warmPool: profile.warmPool ?? "dsh-yawn-universal",
    readyTimeoutMs: profile.readyTimeoutMs ?? 180_000,
    ...(profile.kubeconfig === undefined
      ? {}
      : { kubeconfig: profile.kubeconfig }),
  };
}

/**
 * Runners open a WebSocket to the tunnel, so the URL they are handed must be
 * one. Catching a stale tcp:// or tls:// value here fails the host at boot
 * instead of leaving every runner unable to register.
 */
function checkControlPlaneUrl(
  profileName: string,
  controlPlaneUrl: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(controlPlaneUrl);
  } catch {
    throw new Error(
      `profile ${profileName}: controlPlaneUrl ${controlPlaneUrl} is not a URL`,
    );
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(
      `profile ${profileName}: controlPlaneUrl must be a ws:// or wss:// URL, such as wss://dsh.example.com/tunnel`,
    );
  }
  return controlPlaneUrl;
}

const TOKEN_ENV = "DSH_YAWN_REGISTRATION_TOKEN";

/**
 * The shared secret runners present when they dial the host tunnel. Accepts
 * a comma-separated list so a rotation can admit old and new tokens at once;
 * new sandboxes always receive the first entry.
 */
export function resolveRegistrationTokens(
  config: ResolvedConfig,
  profiles: SandboxProfile[],
): string[] {
  const configured = config.registrationToken ?? process.env[TOKEN_ENV];
  if (configured !== undefined) {
    const tokens = configured
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token !== "");
    if (tokens.length === 0) {
      throw new Error("the configured registration token is empty");
    }
    return tokens;
  }
  const remote = profiles.find((profile) => profile.backend !== "docker");
  if (remote !== undefined) {
    throw new Error(
      `the ${remote.backend} backend needs a registration token; set ${TOKEN_ENV} or the registrationToken config`,
    );
  }
  // Docker development runs host and runners on one machine, so the control plane
  // can mint its own token. Persisting it keeps sandboxes from an earlier
  // control-plane process registerable after a restart.
  const path = join(config.stateDir, "registration-token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing !== "") {
      return [existing];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return [token];
}
