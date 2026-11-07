import type { SandboxPhase } from "../sandbox-status-remote.js";

/** The one-line account of what a first turn is waiting for. */
export function sandboxPhaseText(phase: SandboxPhase): string {
  return phase === "starting" ? "Starting sandbox…" : "Running .agents/setup…";
}
