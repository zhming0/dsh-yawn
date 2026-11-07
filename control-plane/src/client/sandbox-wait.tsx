import { useEffect, useState } from "react";

import { StateDot } from "@deepseek-ai/dsh-client-ui-primitives";
// Type-only imports for the declaration merges that define the
// `conversation.input.dock` slot key and the session standard props.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

import type {
  SandboxPhase,
  SandboxStatusView,
} from "../sandbox-status-remote.js";

import { sandboxPhaseText } from "./sandbox-phase.js";

export interface SandboxWaitActions {
  getSandboxStatus: (sessionId: string) => Promise<SandboxStatusView>;
}

type SandboxWaitProps = PropsRuntime<"conversation.input.dock"> &
  SandboxWaitActions;

const POLL_MS = 1_000;

/**
 * One line above the composer while the first turn waits for its sandbox. The
 * host's status reports the phase; this only follows it, stops once the
 * runner is ready, and shows nothing outside that wait.
 */
export function SandboxWait({
  sessionId: id,
  useSession,
  getSandboxStatus,
}: SandboxWaitProps) {
  const sessionId = String(id);
  const running = useSession((s) => s.running);
  const [phase, setPhase] = useState<SandboxPhase>();

  useEffect(() => {
    setPhase(undefined);
    if (!running) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      getSandboxStatus(sessionId).then(
        (view) => {
          if (cancelled) {
            return;
          }
          setPhase(view.phase);
          // Keep asking until the host reports a running sandbox whose
          // phase is gone. An empty answer before provisioning starts is not
          // the end of the wait yet.
          if (view.phase !== undefined || view.sandbox?.state !== "running") {
            timer = setTimeout(check, POLL_MS);
          }
        },
        () => {
          // A status read is a courtesy; a failed one hides the line rather
          // than claiming the sandbox is ready.
          if (!cancelled) {
            setPhase(undefined);
          }
        },
      );
    };
    check();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [sessionId, running, getSandboxStatus]);

  if (phase === undefined) {
    return null;
  }
  return (
    <div
      role="status"
      data-testid="dsh-yawn-sandbox-wait"
      style={{
        width: "100%",
        maxWidth: "var(--dsh-composer-card-max-width)",
        margin: "0 auto",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 20px 6px",
        fontSize: 12,
        color: "var(--dsw-alias-label-secondary)",
      }}
    >
      <StateDot state="ongoing" />
      {sandboxPhaseText(phase)}
    </div>
  );
}
