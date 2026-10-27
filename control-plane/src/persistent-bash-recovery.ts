/**
 * Retries the persistent `bash` tool once when its cached PTY is gone.
 *
 * The tool keeps the terminal session id in its own registry. A sandbox that
 * hibernates loses the PTY but not the control-plane process that owns that
 * registry, so the next call can find a session that has already exited. The
 * tool resets that stale session, but reports the exit instead of running the
 * command, which makes the following call start a fresh shell and succeed.
 *
 * This runs around the stock tool's dispatch rather than replacing its row:
 * the first shell-exited result is discarded after the tool has reset its
 * cache, and the same command is dispatched once more. Retrying shell exits
 * with a real exit code or signal is deliberately excluded: those can be the
 * command's own effect (for example `exit`), while the stderr-less no-status
 * result is the lost-session shape this recovery targets.
 *
 * @module @zhming0/dsh-yawn/persistent-bash-recovery
 */

import type { Context } from "@deepseek-ai/cordis";
import type {
  ToolDispatchExecution,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";

/**
 * The stock tool's reset text, paired with a shell exit that has neither an
 * exit code nor a signal. Matching both avoids retrying a command that chose
 * to exit the shell and reported a status.
 */
const LOST_SHELL_RESULT =
  /(?:^|\n)\[shell exited\]\nThe persistent bash shell was reset; /;

/** Errors the PTY service raises before a stale session can accept input. */
const LOST_SHELL_ERRORS = [
  /^unknown PTY session /,
  /^PTY session has exited$/,
] as const;

function isLostShellResult(result: ToolExecutionResult): boolean {
  if (result.isError) {
    return LOST_SHELL_ERRORS.some((pattern) =>
      pattern.test(result.error.message),
    );
  }
  return (
    typeof result.value === "string" && LOST_SHELL_RESULT.test(result.value)
  );
}

/**
 * Dispatch one persistent bash call, retrying the stock tool's lost-shell
 * result once. The stock tool resets its terminal cache before returning that
 * result, so the retry naturally opens a fresh shell.
 */
export async function retryLostPersistentBash(
  exec: ToolDispatchExecution,
  next: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  const first = await next();
  if (
    exec.name !== "bash" ||
    exec.signal.aborted ||
    !isLostShellResult(first)
  ) {
    return first;
  }
  return next();
}

export const name = "persistent-bash-recovery";

/** Wrap every tool dispatch with the lost-shell retry. */
export function apply(ctx: Context): void {
  ctx.on("tools/execute", (exec, next) => retryLostPersistentBash(exec, next));
}
