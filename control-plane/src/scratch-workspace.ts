/**
 * The Scratch Workspace: one fixed host directory, `stateDir/scratch`, for
 * work that needs no repository. Each of its sessions still gets its own
 * sandbox, but nothing is cloned into it. It has no repository URL and so no
 * settings scope: its sessions get global secrets and instructions only. The
 * sandbox manager owns the path and what a session there means; this row only
 * keeps the Workspace in dsh's registry.
 *
 * It is always there to start a session in. The row registers it whenever the
 * Web workspace registry comes up, which also gives an installation that
 * predates it the Workspace on its next boot, and the controller refuses to
 * delete it. dsh's sidebar shows a Delete action on every Workspace and offers
 * no way to hide it for one, so the refusal is the message the delete dialog
 * shows. Renaming stays allowed: registering an existing path keeps its title.
 *
 * Both halves wait for Web-only services instead of injecting them, like the
 * other Web wrappers, so a headless profile still boots with this row.
 *
 * @module @zhming0/dsh-yawn/scratch-workspace
 */

import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { symbols, type Context } from "@deepseek-ai/cordis";
// Type-only: puts the optional `workspaceController` service on the Context.
import type {} from "@deepseek-ai/dsh-api-workspace-controller";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";

export const SCRATCH_WORKSPACE_TITLE = "Scratch";

/**
 * The Scratch Workspace's host directory, canonical so it compares equal to
 * the path the workspace registry stores and sessions record as their cwd.
 * `stateDir` must exist.
 */
export function scratchWorkspacePath(stateDir: string): string {
  return join(realpathSync(stateDir), "scratch");
}

/** The registry methods used here; dsh-workspace owns the full type. */
interface ScratchRegistry {
  create(path: string, title?: string): Promise<unknown>;
  get(id: string): { path: string } | undefined;
}

type DeleteWorkspace = (request: { workspaceId: string }) => Promise<unknown>;

export const name = "sandbox-scratch-workspace";

export function apply(ctx: Context): void {
  ctx.inject(["sandboxManager", "workspaceRegistry"], async (registryCtx) => {
    const path = registryCtx.sandboxManager.scratchWorkspace;
    const registry = registryCtx.get("workspaceRegistry") as ScratchRegistry;
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await registry.create(path, SCRATCH_WORKSPACE_TITLE);
    } catch (error) {
      registryCtx
        .logger("sandbox")
        .warn(
          `cannot register the Scratch workspace at ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  });

  ctx.inject(
    ["sandboxManager", "workspaceController", "workspaceRegistry"],
    (controllerCtx) => {
      const path = controllerCtx.sandboxManager.scratchWorkspace;
      const registry = controllerCtx.get(
        "workspaceRegistry",
      ) as ScratchRegistry;
      // The service is a cordis proxy; wrap the instance behind it, as an own
      // property, so the stock prototype and its remote markers stay intact.
      const controller =
        (Reflect.get(controllerCtx.workspaceController, symbols.original) as
          | object
          | undefined) ?? controllerCtx.workspaceController;
      const stock = Reflect.get(controller, "delete") as DeleteWorkspace;
      const guarded: DeleteWorkspace = async function (this: unknown, request) {
        if (registry.get(request.workspaceId)?.path === path) {
          throw new RemoteError(
            "gateway/bad-request",
            "The Scratch workspace can't be deleted.",
            {},
          );
        }
        return stock.call(this, request);
      };
      Object.defineProperty(controller, "delete", {
        configurable: true,
        writable: true,
        value: guarded,
      });
      controllerCtx.effect(() => () => {
        Reflect.deleteProperty(controller, "delete");
      });
    },
  );
}
