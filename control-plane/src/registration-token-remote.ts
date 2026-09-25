import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

import type { RegistrationTokenView } from "./registration-token.js";

/**
 * Browser surface for the control plane's tunnel credential. Unlike broker
 * secrets, these values flow host→browser: an operator configuring a runner
 * this control plane does not start needs to read the current token.
 * The namespace map declaration lives in remote-contributions.ts.
 */
export interface RegistrationTokenRemote {
  getRegistrationToken(): Promise<RemoteResult<RegistrationTokenView>>;
  rotateRegistrationToken(): Promise<RemoteResult<RegistrationTokenView>>;
  retireRegistrationToken(): Promise<RemoteResult<RegistrationTokenView>>;
}

const viewSchema: TypertSchema<RegistrationTokenView> = {
  parse(value: unknown): RegistrationTokenView {
    const view = value as Partial<RegistrationTokenView> | null;
    if (
      typeof view !== "object" ||
      view === null ||
      typeof view.current !== "string" ||
      !Array.isArray(view.retiring) ||
      view.retiring.some((token) => typeof token !== "string")
    ) {
      throw new TypeError("expected a runner token view");
    }
    return view as RegistrationTokenView;
  },
};

function describe(method: string): InvocationDescriptor {
  const id = `@zhming0/dsh-yawn#sandboxManager/${method}`;
  return {
    id,
    service: "sandboxManager",
    namespace: "sandboxManager",
    method,
    invocation: { kind: "direct" },
    parameters: [],
    result: {
      mode: "strict",
      typeSymbol: `${id}:result`,
      create: () => viewSchema,
    },
  };
}

export const registrationTokenDescriptors: InvocationDescriptor[] = [
  describe("getRegistrationToken"),
  describe("rotateRegistrationToken"),
  describe("retireRegistrationToken"),
];
