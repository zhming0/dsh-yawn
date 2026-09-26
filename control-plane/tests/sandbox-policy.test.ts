import { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";

import { SandboxPolicy } from "../src/sandbox-policy.js";

describe("SandboxPolicy", () => {
  function makeService(workspace = "/workspace/repository") {
    const ctx = new Context();
    const sandboxManager = { workspace };
    ctx.provide("sandboxManager", sandboxManager);
    const service = new SandboxPolicy(ctx);
    return { service, sandboxManager };
  }

  it("reports the sandbox workspace as the workspace root", () => {
    const { service } = makeService();
    expect(service.workspaceRoot).toBe("/workspace/repository");
  });

  it("follows the sandbox manager if its workspace changes", () => {
    const { service, sandboxManager } = makeService();
    sandboxManager.workspace = "/srv/work";
    expect(service.workspaceRoot).toBe("/srv/work");
  });

  it("resolves every session to the sandbox workspace, not its host cwd", () => {
    const { service } = makeService();
    const session = {
      id: "session-one",
      header: { cwd: "/home/host/.dsh/workspaces/repo" },
    } as unknown as Session;
    expect(service.resolve({ session })).toEqual({
      mode: "danger-full-access",
      workspaceRoot: "/workspace/repository",
      sessionId: "session-one",
    });
    expect(service.resolve()).toEqual({
      mode: "danger-full-access",
      workspaceRoot: "/workspace/repository",
    });
  });

  /**
   * dsh's persistent shell and PTC runtime wrap their command in the host's
   * `landlock-run` launcher unless this service answers full access. The
   * sandbox cannot run that launcher, so a confined answer breaks the command
   * instead of confining it.
   */
  it("answers full access, even for an explicitly requested mode", () => {
    const { service } = makeService();
    expect(service.defaultMode).toBe("danger-full-access");
    expect(service.resolve({ mode: "read-only" })).toMatchObject({
      mode: "danger-full-access",
    });
  });

  it("never reports a per-session override", () => {
    const { service } = makeService();
    const session = { id: "session-one" } as unknown as Session;
    expect(service.overrideOf(session)).toBeUndefined();
  });
});
