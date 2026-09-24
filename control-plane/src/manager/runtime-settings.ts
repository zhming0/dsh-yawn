import {
  resolveDegradingRuntime,
  type ResolvedRuntime,
  type RuntimeConfig,
} from "../config.js";

/**
 * The slice of sandbox-manager settings that can change while the host runs,
 * read through the row's volatile config. Every access re-resolves piece by
 * piece (see `resolveDegradingRuntime`), so a settings-form write applies to
 * the next armed countdown and the next hibernation without an event and
 * without a restart — and one broken piece, such as a profile with a bad
 * controlPlaneUrl, degrades alone instead of freezing the whole slice on its
 * last good values. Boot resolves through the same logic, so a running host
 * and a restart agree on what the current settings mean.
 */
export class RuntimeSettings {
  private lastGood: ResolvedRuntime;
  /** The warning set already reported for the current slice: a bad piece
   * warns once, not once per read, and a changed slice warns again. */
  private warnedSignature: string;

  constructor(
    initial: ResolvedRuntime,
    initialWarnings: readonly string[] = [],
    private readonly source: () => RuntimeConfig,
    private readonly tunnelPort: number,
    private readonly onWarnings: (warnings: string[]) => void = () => undefined,
    /** The deployment settings beneath the row config; see config.ts. */
    private readonly deployment: RuntimeConfig = {},
  ) {
    this.lastGood = initial;
    this.warnedSignature = initialWarnings.join("\n");
  }

  private current(): ResolvedRuntime {
    try {
      const { runtime, warnings } = resolveDegradingRuntime(
        this.source(),
        this.tunnelPort,
        this.deployment,
      );
      if (warnings.length === 0) {
        this.warnedSignature = "";
      } else {
        const signature = warnings.join("\n");
        if (signature !== this.warnedSignature) {
          this.warnedSignature = signature;
          this.onWarnings(warnings);
        }
      }
      this.lastGood = runtime;
    } catch (error) {
      // The degrading resolver does not throw by construction; if the source
      // itself explodes, keep the previous values and say so once.
      const message = `keeping the previous sandbox settings: ${error instanceof Error ? error.message : String(error)}`;
      if (this.warnedSignature !== message) {
        this.warnedSignature = message;
        this.onWarnings([message]);
      }
    }
    return this.lastGood;
  }

  get profiles(): ResolvedRuntime["profiles"] {
    return this.current().profiles;
  }

  get defaultProfile(): string | undefined {
    return this.current().defaultProfile;
  }

  get idleMs(): number {
    return this.current().idleMs;
  }

  get expiresAfterMs(): number {
    return this.current().expiresAfterMs;
  }
}
