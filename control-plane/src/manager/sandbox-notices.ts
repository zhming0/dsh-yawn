import type { Context } from "@deepseek-ai/cordis";
import { YAWN_MESSAGE_SOURCE } from "../message-source.js";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import type { Checkpoint } from "../checkpoint.js";
import { hasRepository, type RunningRecord } from "../types.js";
import type { LifecycleHooks } from "./sandbox-lifecycle.js";

/** One sandbox notice: the model-facing text and its one-line transcript account. */
interface SandboxNotice {
  text: string;
  summary: string;
}

/**
 * The one-turn notes the model sees when ensureRunning brought its session
 * back in an environment it did not last see: a checkpoint restore, a wake
 * that built a new machine, or a wake that reused the old one. The environment
 * section carries the rule — the artifacts folder survives every sleep, and a
 * rebuilt machine runs the repository's setup again — so a note states what
 * happened this time, names `.agents/setup` as the thing that put the
 * repository's tools back, and only a restore that had to leave the folder
 * behind names an exception to that rule.
 */
const RESTORE_NOTICE: SandboxNotice = {
  text: "This sandbox was recreated. Your Git changes and commits are back. The repository's setup (`.agents/setup`) ran before the restore, so re-run project steps if your restored changes affect them. Anything you installed yourself, ignored files, and everything else outside the repository are gone. Previously staged changes are now unstaged.",
  summary: "Sandbox restored from a checkpoint",
};
const RESTORE_NOTICE_ARTIFACTS_DROPPED = (
  artifacts: string,
): SandboxNotice => ({
  text: `This sandbox was recreated. Your Git changes and commits are back, but the artifacts folder could not be brought back, so the files in ${artifacts} are gone. The repository's setup (\`.agents/setup\`) ran before the restore, so re-run project steps if your restored changes affect them. Anything you installed yourself, ignored files, and everything else outside the repository are gone. Previously staged changes are now unstaged.`,
  summary: "Sandbox restored from a checkpoint without artifacts",
});
const WAKE_NOTICE: SandboxNotice = {
  text: "This sandbox was suspended and woke on a newly created machine. Files under /workspace survived, including your home directory, but running processes, /tmp, and anything you installed yourself outside /workspace are gone. The repository's setup (`.agents/setup`) ran again on this machine; re-create anything else you need before continuing.",
  summary: "Sandbox woke from hibernation",
};
const WAKE_NOTICE_KEPT_FILESYSTEM: SandboxNotice = {
  ...WAKE_NOTICE,
  text: "This sandbox was suspended and woke on the same machine. Its files are intact, but the processes that were running before the suspension are gone. Restart what you need before continuing.",
};

/**
 * The Scratch Workspace's variants: no repository, so no setup hook and no Git
 * work. A restore brings back only the artifacts folder, as the environment
 * section already told the model.
 */
const NO_REPOSITORY_RESTORE_NOTICE = (artifacts: string): SandboxNotice => ({
  text: `This sandbox was recreated on a new machine. The files in ${artifacts} are back. The rest of your working directory, anything you installed yourself, and everything else outside the artifacts folder are gone.`,
  summary: "Sandbox restored from a checkpoint",
});
const NO_REPOSITORY_RESTORE_NOTICE_ARTIFACTS_DROPPED = (
  artifacts: string,
): SandboxNotice => ({
  text: `This sandbox was recreated on a new machine, and the artifacts folder could not be brought back, so the files in ${artifacts} are gone. Your working directory, anything you installed yourself, and everything else are gone too.`,
  summary: "Sandbox restored from a checkpoint without artifacts",
});
const NO_REPOSITORY_WAKE_NOTICE: SandboxNotice = {
  ...WAKE_NOTICE,
  text: "This sandbox was suspended and woke on a newly created machine. Files under /workspace survived, including your home directory, but running processes, /tmp, and anything you installed yourself outside /workspace are gone. Re-create anything else you need before continuing.",
};

export interface SandboxNoticesDependencies {
  /** The root session whose sandbox an agent's work shares. */
  rootSessionId(agent: Agent): string;
  /** The session's artifacts folder, for the notice that had to drop it. */
  artifactsDirectory(): string;
}

/**
 * The notices a turn carries when its sandbox came back from somewhere else.
 * The lifecycle hooks queue a note under the root session; the pre-step
 * listener rides it onto the next step's prompt as a user message from this
 * provider. A restore and each kind of wake have their own wording, because
 * what the model finds missing differs.
 */
export class SandboxNotices implements LifecycleHooks {
  private readonly pending = new Map<string, SandboxNotice>();

  constructor(
    private readonly ctx: Context,
    private readonly deps: SandboxNoticesDependencies,
  ) {}

  /**
   * Register the pre-step listener. Install it after the listeners that call
   * ensureRunning, so next() has performed the restore or wake before the
   * notice is read and prepended.
   */
  install(): void {
    this.ctx.on("agent/pre-step", async ({ agent }, next) => {
      const decision = await next();
      if (decision.kind === "reject" || decision.messages.length === 0) {
        return decision;
      }
      const notice = this.take(agent);
      if (notice === undefined) {
        return decision;
      }
      return {
        kind: "enter" as const,
        messages: [noticeMessage(notice), ...decision.messages],
      };
    });
  }

  /**
   * A checkpoint restore completed; the next prompt says what survived,
   * including whether the artifacts folder had to be left behind.
   */
  async afterRestore({
    sessionId,
    record,
    checkpoint,
  }: {
    sessionId: string;
    record: RunningRecord;
    checkpoint: Checkpoint;
  }): Promise<void> {
    const artifacts = this.deps.artifactsDirectory();
    const dropped = checkpoint.artifactsDropped === true;
    let notice: SandboxNotice;
    if (hasRepository(record)) {
      notice = dropped
        ? RESTORE_NOTICE_ARTIFACTS_DROPPED(artifacts)
        : RESTORE_NOTICE;
    } else {
      notice = dropped
        ? NO_REPOSITORY_RESTORE_NOTICE_ARTIFACTS_DROPPED(artifacts)
        : NO_REPOSITORY_RESTORE_NOTICE(artifacts);
    }
    this.pending.set(sessionId, notice);
  }

  /** A hibernated sandbox woke; its backend says what the machine kept. */
  async afterWake({
    sessionId,
    record,
    keepsFilesystem,
  }: {
    sessionId: string;
    record: RunningRecord;
    keepsFilesystem: boolean;
  }): Promise<void> {
    let notice = WAKE_NOTICE_KEPT_FILESYSTEM;
    if (!keepsFilesystem) {
      notice = hasRepository(record) ? WAKE_NOTICE : NO_REPOSITORY_WAKE_NOTICE;
    }
    this.pending.set(sessionId, notice);
  }

  /**
   * The note for this turn's prompt, keyed by root session; reading it
   * consumes it, so the notice rides exactly one step.
   */
  private take(agent: Agent): SandboxNotice | undefined {
    const sessionId = this.deps.rootSessionId(agent);
    const notice = this.pending.get(sessionId);
    if (notice !== undefined) {
      this.pending.delete(sessionId);
    }
    return notice;
  }
}

function noticeMessage(notice: SandboxNotice) {
  return createUserMessage({
    content: [{ type: "text" as const, text: notice.text }],
    source: {
      kind: YAWN_MESSAGE_SOURCE,
      form: "notice" as const,
      summary: notice.summary,
    },
  });
}
