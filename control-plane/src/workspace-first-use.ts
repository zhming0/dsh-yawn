import type { Context } from "@deepseek-ai/cordis";
// Type-only: puts the optional `workspaceController` service on the Context.
import type {} from "@deepseek-ai/dsh-api-workspace-controller";

/**
 * Keeps fresh installations off dsh's automatic default Workspace.
 *
 * dsh 0.1.7's Web client auto-creates a default Workspace on an empty
 * installation (`workspaces.initializeDefault`), placed under the host's
 * Documents directory, which the control-plane image does not have. This
 * product's Scratch Workspace takes its place: the sandbox manager registers
 * it at boot (scratch-workspace.ts), so an installation is never empty and the
 * client opens a blank session there instead. Answering `undefined` is the
 * controller's own "ineligible" outcome for the moment before that
 * registration lands: the client shows no error.
 *
 * The wait-not-inject shape matches the other optional-surface rows: a
 * headless profile without the Web bundle still boots with this row present.
 *
 * @module @zhming0/dsh-yawn/workspace-first-use
 */

export const name = "sandbox-workspace-first-use";

export function apply(ctx: Context): void {
  ctx.inject(["workspaceController"], (controllerCtx) => {
    const controller = controllerCtx.workspaceController;
    // An own property, like the workspace-files wrappers: the stock prototype
    // and its remote markers stay untouched, and disposal removes it.
    Object.defineProperty(controller, "initializeDefault", {
      configurable: true,
      writable: true,
      value: () => Promise.resolve(undefined),
    });
    controllerCtx.effect(() => () => {
      Reflect.deleteProperty(controller, "initializeDefault");
    });
  });
}
