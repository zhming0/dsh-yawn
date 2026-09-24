import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

/** One profile as the Sandboxes page shows it. */
export interface SandboxProfileOptionView {
  name: string;
  backend: string;
  /** Scalar fields, for the summary and the profile form. */
  fields: Record<string, string>;
  /** The deployment configures it; the page cannot edit or remove it. */
  locked: boolean;
}

/**
 * The Sandboxes page's whole read model: the deployment's settings combined
 * with the page's own edits, so the page never merges the two itself.
 */
export interface SandboxSettingsView {
  profiles: SandboxProfileOptionView[];
  /** The effective default profile, deployment and page values considered. */
  defaultProfile?: string;
  idleMs: number;
  expiresAfterMs: number;
  /** Whether the page overrides each scalar; a reset returns to the base. */
  overridden: {
    defaultProfile: boolean;
    idleMs: boolean;
    expiresAfterMs: boolean;
  };
  /** The settings revision a write must carry. */
  revision: number;
  /** Whether the profile accepts settings-form writes. */
  writable: boolean;
}

/** The namespace map declaration lives in remote-contributions.ts. */
export interface SandboxSettingsRemote {
  getSandboxSettings(): Promise<RemoteResult<SandboxSettingsView>>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

const viewSchema: TypertSchema<SandboxSettingsView> = {
  parse(value: unknown): SandboxSettingsView {
    const view = value as Partial<SandboxSettingsView> | null;
    if (
      typeof view !== "object" ||
      view === null ||
      !Array.isArray(view.profiles) ||
      view.profiles.some(
        (profile) =>
          typeof profile !== "object" ||
          profile === null ||
          typeof profile.name !== "string" ||
          typeof profile.backend !== "string" ||
          !isStringRecord(profile.fields) ||
          typeof profile.locked !== "boolean",
      ) ||
      (view.defaultProfile !== undefined &&
        typeof view.defaultProfile !== "string") ||
      typeof view.idleMs !== "number" ||
      typeof view.expiresAfterMs !== "number" ||
      typeof view.overridden !== "object" ||
      view.overridden === null ||
      typeof view.overridden.defaultProfile !== "boolean" ||
      typeof view.overridden.idleMs !== "boolean" ||
      typeof view.overridden.expiresAfterMs !== "boolean" ||
      typeof view.revision !== "number" ||
      typeof view.writable !== "boolean"
    ) {
      throw new TypeError("expected sandbox settings");
    }
    return view as SandboxSettingsView;
  },
};

export const sandboxSettingsDescriptors: InvocationDescriptor[] = [
  {
    id: "@zhming0/dsh-yawn#sandboxManager/getSandboxSettings",
    service: "sandboxManager",
    namespace: "sandboxManager",
    method: "getSandboxSettings",
    invocation: { kind: "direct" },
    parameters: [],
    result: {
      mode: "strict",
      typeSymbol: "@zhming0/dsh-yawn#sandboxManager/getSandboxSettings:result",
      create: () => viewSchema,
    },
  },
];
