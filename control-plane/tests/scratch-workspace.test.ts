import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  installScratchWorkspace,
  SCRATCH_WORKSPACE_TITLE,
} from "../src/scratch-workspace.js";
import { sleep } from "./fakes.js";

/** The stock method lives on the prototype, as on dsh's controller class. */
class FakeController {
  readonly deleted: string[] = [];

  delete(request: { workspaceId: string }): Promise<unknown> {
    this.deleted.push(request.workspaceId);
    return Promise.resolve({ deleted: true });
  }
}

class FakeRegistry {
  readonly workspaces = new Map<string, { path: string; title: string }>();

  async create(path: string, title?: string) {
    for (const workspace of this.workspaces.values()) {
      if (workspace.path === path) {
        return workspace;
      }
    }
    const workspace = { path, title: title ?? path };
    this.workspaces.set(`id-${this.workspaces.size}`, workspace);
    return workspace;
  }

  get(id: string) {
    return this.workspaces.get(id);
  }
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "dsh-yawn-scratch-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function mount(registry = new FakeRegistry()) {
  const path = join(directory, "scratch");
  const controller = new FakeController();
  const warnings: string[] = [];
  const ctx = new Context();
  ctx.provide("workspaceRegistry", registry);
  ctx.provide("workspaceController", controller);
  const fiber = ctx.plugin({
    apply: (scope: Context) => {
      installScratchWorkspace(scope, path, (message) => warnings.push(message));
    },
  });
  return { path, controller, registry, warnings, fiber };
}

it("registers the directory once the registry is up, keeping a renamed title", async () => {
  const registry = new FakeRegistry();
  const { path } = mount(registry);
  await sleep(10);

  expect((await stat(path)).isDirectory()).toBe(true);
  expect([...registry.workspaces.values()]).toEqual([
    { path, title: SCRATCH_WORKSPACE_TITLE },
  ]);

  // A later boot registers the same path again, which keeps its record.
  registry.workspaces.set("id-0", { path, title: "Notes" });
  mount(registry);
  await sleep(10);
  expect([...registry.workspaces.values()]).toEqual([{ path, title: "Notes" }]);
});

it("refuses to delete it and deletes any other Workspace", async () => {
  const { path, controller, registry, fiber } = mount();
  await sleep(10);
  await registry.create(join(directory, "other"), "other");

  const refused = await controller
    .delete({ workspaceId: "id-0" })
    .catch((error: unknown) => error);
  expect(remoteErrorOf(refused)?.message).toBe(
    "The Scratch workspace can't be deleted.",
  );
  expect(registry.get("id-0")?.path).toBe(path);

  await controller.delete({ workspaceId: "id-1" });
  expect(controller.deleted).toEqual(["id-1"]);

  // Disposal restores the stock method.
  await fiber.dispose();
  await controller.delete({ workspaceId: "id-0" });
  expect(controller.deleted).toEqual(["id-1", "id-0"]);
});

it("warns instead of failing when it cannot register", async () => {
  const registry = new FakeRegistry();
  registry.create = () => Promise.reject(new Error("registry is down"));
  const { warnings } = mount(registry);
  await sleep(10);

  expect(warnings).toEqual([
    expect.stringContaining("registry is down") as string,
  ]);
});
