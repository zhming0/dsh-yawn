import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

export interface SecretWorkspaceView {
  repositoryUrl: string;
  title: string;
  names: string[];
}

/** One name list per scope; values never appear in any view. */
export interface SecretSettingsView {
  global: string[];
  workspaces: SecretWorkspaceView[];
}

/**
 * Browser CRUD surface for broker secrets. Values flow browser→host only;
 * every method answers with the updated name lists, never a value.
 * The namespace map declaration lives in remote-contributions.ts.
 */
export interface SandboxSecretsRemote {
  getSecrets(): Promise<RemoteResult<SecretSettingsView>>;
  setGlobalSecret(
    name: string,
    value: string,
  ): Promise<RemoteResult<SecretSettingsView>>;
  setWorkspaceSecret(
    repositoryUrl: string,
    name: string,
    value: string,
  ): Promise<RemoteResult<SecretSettingsView>>;
  deleteGlobalSecret(name: string): Promise<RemoteResult<SecretSettingsView>>;
  deleteWorkspaceSecret(
    repositoryUrl: string,
    name: string,
  ): Promise<RemoteResult<SecretSettingsView>>;
}

const stringSchema: TypertSchema<string> = {
  parse(value: unknown): string {
    if (typeof value !== "string") {
      throw new TypeError("expected a string");
    }
    return value;
  },
};

const settingsSchema: TypertSchema<SecretSettingsView> = {
  parse(value: unknown): SecretSettingsView {
    if (
      typeof value !== "object" ||
      value === null ||
      !("global" in value) ||
      !Array.isArray(value.global) ||
      !("workspaces" in value) ||
      !Array.isArray(value.workspaces) ||
      // Array.isArray narrows to any[]; widen so the entry checks stay typed.
      (value.workspaces as unknown[]).some(
        (entry) =>
          typeof entry !== "object" ||
          entry === null ||
          !("repositoryUrl" in entry) ||
          typeof entry.repositoryUrl !== "string" ||
          !("title" in entry) ||
          typeof entry.title !== "string" ||
          !("names" in entry) ||
          !Array.isArray(entry.names) ||
          entry.names.some((name) => typeof name !== "string"),
      )
    ) {
      throw new TypeError("expected a secret settings view");
    }
    return value as SecretSettingsView;
  },
};

function describe(
  method: string,
  parameters: Array<{ name: string; schema: TypertSchema }>,
): InvocationDescriptor {
  const id = `@zhming0/dsh-yawn#sandboxManager/${method}`;
  return {
    id,
    // The gateway accepts one wire namespace per host service, so the secret
    // methods live in the manager's own namespace.
    service: "sandboxManager",
    namespace: "sandboxManager",
    method,
    invocation: { kind: "direct" },
    parameters: parameters.map(({ name, schema }) => ({
      name,
      wire: name,
      source: "json",
      codec: {
        mode: "strict",
        typeSymbol: `${id}:${name}`,
        create: () => schema,
      },
    })),
    result: {
      mode: "strict",
      typeSymbol: `${id}:result`,
      create: () => settingsSchema,
    },
  };
}

export const sandboxSecretsDescriptors: InvocationDescriptor[] = [
  describe("getSecrets", []),
  describe("setGlobalSecret", [
    { name: "name", schema: stringSchema },
    { name: "value", schema: stringSchema },
  ]),
  describe("setWorkspaceSecret", [
    { name: "repositoryUrl", schema: stringSchema },
    { name: "name", schema: stringSchema },
    { name: "value", schema: stringSchema },
  ]),
  describe("deleteGlobalSecret", [{ name: "name", schema: stringSchema }]),
  describe("deleteWorkspaceSecret", [
    { name: "repositoryUrl", schema: stringSchema },
    { name: "name", schema: stringSchema },
  ]),
];
