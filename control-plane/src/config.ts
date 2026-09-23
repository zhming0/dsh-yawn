import { homedir } from "node:os";
import { join } from "node:path";

import z from "@deepseek-ai/schemastery";
import type { Volatile } from "@deepseek-ai/cosmokit";
import { parse as parseYaml } from "yaml";

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
      secretKey?: string;
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
  tunnel: { port: number; bind: string };
  preview: { domain: string | undefined; port: number; bind: string };
}

/**
 * The settings that can change while the host runs: sandbox profiles and the
 * idle and expiry timers. Everything else in {@link Config} shapes the boot
 * (state directories, the tunnel listener) and is read once.
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
          secretKey: z.string(),
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
 * The `sandboxManager` section of the deployment document: the runtime slice
 * alone — profiles, the default profile, and the two timers. Startup settings
 * stay in the profile patch, where the deployment's own values already are.
 *
 * The top-level key is part of the chart-to-image contract: people run an
 * image tag that is not the chart's, so a document may carry sections this
 * image does not know yet, and they are ignored. It stays specific to this
 * package; other plugins own their own settings.
 */
const deploymentSettingsSchema = z.object(runtimeFields());

/**
 * Parse one deployment settings document. A malformed document fails the row
 * loudly: it is operator configuration, and a silent fallback to no profiles
 * would look like the sandbox feature vanished.
 *
 * @param raw - The document text, or undefined when there is none.
 * @param source - What to name the document in errors, usually its path.
 */
export function parseDeploymentSettings(
  raw: string | undefined,
  source = "the deployment settings",
): RuntimeConfig {
  if (raw === undefined || raw.trim() === "") {
    return {};
  }
  let value: unknown;
  try {
    value = parseYaml(raw);
  } catch (error) {
    throw new Error(`${source} is not valid YAML: ${messageOf(error)}`, {
      cause: error,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be a YAML mapping`);
  }
  const section = Reflect.get(value, "sandboxManager") as unknown;
  if (section === undefined) {
    return {};
  }
  if (
    typeof section !== "object" ||
    section === null ||
    Array.isArray(section)
  ) {
    throw new Error(
      `${source}'s sandboxManager section must be a YAML mapping`,
    );
  }
  try {
    return deploymentSettingsSchema(section);
  } catch (error) {
    throw new Error(
      `${source} does not match the sandbox-manager settings: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

/**
 * One runtime slice with the deployment settings as the base. The deployment
 * owns its profile names: a page entry with the same name is ignored, because
 * the page shows those profiles as locked. Profiles the deployment does not
 * name are additions, and the page's scalars win over the deployment's.
 */
function withDeploymentBase(
  config: RuntimeConfig,
  base: RuntimeConfig,
): {
  profiles: Record<string, ProfileConfig>;
  defaultProfile: string | undefined;
  idleMs: number | undefined;
  expiresAfterMs: number | undefined;
} {
  const profiles = { ...(readSetting(base.profiles) ?? {}) };
  for (const [name, profile] of Object.entries(
    readSetting(config.profiles) ?? {},
  )) {
    profiles[name] ??= profile;
  }
  return {
    profiles,
    defaultProfile:
      readSetting(config.defaultProfile) ?? readSetting(base.defaultProfile),
    idleMs: readSetting(config.idleMs) ?? readSetting(base.idleMs),
    expiresAfterMs:
      readSetting(config.expiresAfterMs) ?? readSetting(base.expiresAfterMs),
  };
}

/**
 * Apply every default and check the runtime slice holds together. A
 * configuration with no profiles is valid: the host comes up without a
 * backend, and the first prompt explains what to add.
 */
export function resolveRuntime(
  config: RuntimeConfig,
  tunnelPort: number,
  base: RuntimeConfig = {},
): ResolvedRuntime {
  const raw = withDeploymentBase(config, base);
  const profiles = Object.fromEntries(
    Object.entries(raw.profiles).map(([name, profile]) => [
      name,
      resolveProfile(name, profile, tunnelPort),
    ]),
  );
  const configured = Object.keys(profiles);
  // With no profiles there is nothing for defaultProfile to select, so a
  // leftover name is ignored rather than stopping the host from booting; the
  // first prompt reports the missing profile instead.
  const defaultProfile =
    configured.length === 0 ? undefined : (raw.defaultProfile ?? configured[0]);
  if (defaultProfile !== undefined && profiles[defaultProfile] === undefined) {
    throw new Error(
      `defaultProfile ${defaultProfile} is not a configured profile`,
    );
  }
  const resolved: ResolvedRuntime = {
    profiles,
    defaultProfile,
    idleMs: raw.idleMs ?? 10 * 60_000,
    expiresAfterMs: raw.expiresAfterMs ?? 7 * 24 * 60 * 60_000,
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
export function resolveConfig(
  config: Config,
  base: RuntimeConfig = {},
): ResolvedConfig {
  const tunnelPort = config.tunnel?.port ?? 8081;
  return assembleConfig(config, resolveRuntime(config, tunnelPort, base));
}

/**
 * The boot face of {@link resolveConfig}. Since dsh 0.1.7, settings-form
 * writes persist into the profile's own `cordis.patch.yml` — the same file
 * the Loader reads at boot — and the form validates against the row schema
 * alone, so a semantically bad but schema-valid value (a `defaultProfile`
 * naming no profile, a `controlPlaneUrl` that is not a WebSocket URL) can be
 * saved. The boot resolver degrades that slice instead of throwing; see
 * {@link resolveDegradingRuntime}. Boot-authored fields (state directories,
 * the tunnel, the preview domain) stay strict — an image that ships them
 * broken must fail loudly.
 */
export function resolveBootConfig(
  config: Config,
  base: RuntimeConfig = {},
): {
  config: ResolvedConfig;
  warnings: string[];
} {
  const { runtime, warnings } = resolveDegradingRuntime(
    config,
    config.tunnel?.port ?? 8081,
    base,
  );
  return { config: assembleConfig(config, runtime), warnings };
}

/**
 * Resolve the runtime slice piece by piece: a broken profile drops with one
 * warning, a `defaultProfile` naming no remaining profile falls back to the
 * first, and an out-of-range timer restores its default. Boot and the
 * running host both read through this, so a value that survives a restart
 * also applies live -- only the pieces that cannot work are ignored. The
 * deployment settings sit beneath the row config, so the chart's profiles
 * still apply when the Web page has never written anything.
 */
export function resolveDegradingRuntime(
  config: RuntimeConfig,
  tunnelPort: number,
  base: RuntimeConfig = {},
): { runtime: ResolvedRuntime; warnings: string[] } {
  const warnings: string[] = [];

  const raw = withDeploymentBase(config, base);
  const profiles: Record<string, SandboxProfile> = {};
  for (const [name, profile] of Object.entries(raw.profiles)) {
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
  let defaultProfile =
    configured.length === 0 ? undefined : (raw.defaultProfile ?? configured[0]);
  if (defaultProfile !== undefined && profiles[defaultProfile] === undefined) {
    warnings.push(
      `defaultProfile ${raw.defaultProfile} names no configured profile; using ${configured[0]}`,
    );
    defaultProfile = configured[0];
  }

  const runtime: ResolvedRuntime = {
    profiles,
    defaultProfile,
    idleMs: bootTimer(raw.idleMs, "idleMs", 10 * 60_000, warnings),
    expiresAfterMs: bootTimer(
      raw.expiresAfterMs,
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
  value: number | undefined,
  key: "idleMs" | "expiresAfterMs",
  fallback: number,
  warnings: string[],
): number {
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
      ...(profile.secretKey === undefined
        ? {}
        : { secretKey: profile.secretKey }),
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
