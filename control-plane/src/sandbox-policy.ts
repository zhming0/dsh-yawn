/**
 * Sandbox stand-in for dsh's `sandboxPolicy` service.
 *
 * The stock `@deepseek-ai/dsh-sandbox-policy` describes the dsh host's own
 * file sandbox: a per-session mode switch, a host directory the agent may
 * write under, and a line in every model request that names that directory.
 * None of that holds here. Every file and shell operation already runs inside
 * the session's sandbox, the host cwd is a bookkeeping anchor the model never
 * sees, and no enabled row enforces or renders a mode.
 *
 * The service still has to exist: the Web file browser (`workspace-files`)
 * and the deliverables host half inject it and read `workspaceRoot`, and dsh
 * refuses to boot while a mounted row waits for a missing service. This
 * module answers those readers with the sandbox workspace and nothing else.
 *
 * It answers `danger-full-access` for every call. In dsh that mode means "run
 * the command as it is, with no extra file sandbox", and the container is
 * already the boundary, so there is nothing to add. Any other answer makes two
 * stock rows wrap the command in the dsh host's `landlock-run` launcher:
 * `dsh-terminal-bash`, the shell behind the `minimal` preset, and the PTC
 * runtime. The sandbox has no `landlock-run`, so the command fails with ENOENT
 * instead of running.
 *
 * @module @zhming0/dsh-yawn/sandbox-policy
 */

import { Context, Service } from "@deepseek-ai/cordis";
import type {
  SandboxExecutionPolicy,
  SandboxMode,
} from "@deepseek-ai/dsh-sandbox";
import type {
  SandboxPolicyRequest,
  SandboxPolicyService,
} from "@deepseek-ai/dsh-sandbox-policy";
import type { Session } from "@deepseek-ai/dsh-session";

/** The stock service's public surface, so the stand-in cannot drift from it. */
type SandboxPolicyContract = Pick<
  SandboxPolicyService,
  "defaultMode" | "workspaceRoot" | "resolve" | "overrideOf"
>;

/**
 * `ctx.sandboxPolicy` for sandbox-backed sessions. It reports the sandbox
 * workspace as the root and full access as the mode; the module note says why
 * the mode cannot be anything else.
 */
export class SandboxPolicy extends Service implements SandboxPolicyContract {
  static inject = ["sandboxManager"];

  /**
   * The container is the file boundary, and the runner lets the agent write
   * anywhere inside it, so there is no narrower mode to report.
   */
  readonly defaultMode: SandboxMode = "danger-full-access";

  constructor(ctx: Context) {
    super(ctx, "sandboxPolicy");
  }

  /** The sandbox workspace, in sandbox coordinates. */
  get workspaceRoot(): string {
    return this.ctx.sandboxManager.workspace;
  }

  /**
   * Ignore a requested mode and answer full access. Nothing here can enforce
   * a narrower one, and returning it would only get the command wrapped in a
   * launcher the sandbox does not have (see the module note).
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request;
    return {
      mode: this.defaultMode,
      workspaceRoot: this.workspaceRoot,
      ...(session === undefined ? {} : { sessionId: session.id }),
    };
  }

  /** Sessions carry no mode override here; there is no switch to record one. */
  overrideOf(_session: Session): SandboxMode | undefined {
    return undefined;
  }
}

export default SandboxPolicy;
