import type { RunnerClient } from "../../core/runner-client.js";
import type {
  SandboxHostFacts,
  SandboxLiveFacts,
  SandboxPhase,
  SandboxStatusView,
} from "../sandbox-status-remote.js";
import type { SessionStore } from "../../core/state-store.js";
import {
  provisionsFromImage,
  type SandboxProfile,
  type SessionRecord,
} from "../../core/types.js";

/** Bound on the machine's own account of itself; the tab is a glance, not a wait. */
const LIVE_FACTS_TIMEOUT_MS = 5_000;

export interface SandboxStatusDependencies {
  store: SessionStore;
  /** The profiles as they stand now; a settings change can replace the map. */
  profiles: () => Record<string, SandboxProfile>;
  /**
   * The attached runner of one session, or undefined when it has none. This is
   * a read: the caller supplies a lookup that cannot provision or wake.
   */
  runnerFor: (sessionId: string) => RunnerClient | undefined;
  /**
   * Whether the session has an open turn. A provisioning wait is only visible
   * while one is live, so a parked sandbox never claims to be starting.
   */
  turnLive: (sessionId: string) => boolean;
  /** The configured preview domain; undefined when previews are disabled. */
  previewDomain?: string;
  /**
   * The host name serving one sandbox's previews, or undefined when previews
   * are disabled. The port segment is the placeholder the tab swaps for the
   * server's real port.
   */
  previewHost?: (sandboxId: string) => string | undefined;
}

/**
 * The wait a first turn spends before its runner can serve it: no record yet
 * means the sandbox is being created, a record without an attached runner
 * means it is being connected and set up. Outside a live turn nothing is
 * starting, so there is no phase to show.
 */
export function sandboxPhase(
  record: SessionRecord | undefined,
  turnLive: boolean,
  runnerReady: boolean,
): SandboxPhase | undefined {
  if (!turnLive) {
    return undefined;
  }
  if (record === undefined) {
    return "starting";
  }
  return runnerReady ? undefined : "setup";
}

/**
 * What the Sandbox tab shows about one session's sandbox: the host's own
 * record, plus the machine's account of itself when a runner is attached.
 *
 * Reading a status is deliberately inert. It never provisions, wakes, or marks
 * a session active, which is why it holds a store, a profile map, and a
 * read-only runner lookup — and no lifecycle engine. A hibernated or
 * checkpointed sandbox therefore reports what the host knows and stops there,
 * instead of paying to boot a machine so it can describe itself.
 */
export class SandboxStatus {
  constructor(private readonly deps: SandboxStatusDependencies) {}

  async view(sessionId: string): Promise<SandboxStatusView> {
    // The preview domain is a fact about the host, not the sandbox: the tab
    // needs it to explain what is missing even before anything exists.
    const previewDomain =
      this.deps.previewDomain === undefined
        ? {}
        : { previewDomain: this.deps.previewDomain };
    const record = this.deps.store.get(sessionId);
    // Only a running sandbox can have an attached runner, and asking for one
    // never wakes anything.
    const client =
      record?.state === "running" ? this.deps.runnerFor(sessionId) : undefined;
    const phase = sandboxPhase(
      record,
      this.deps.turnLive(sessionId),
      client !== undefined,
    );
    const view: SandboxStatusView = {
      ...previewDomain,
      ...(phase === undefined ? {} : { phase }),
    };
    if (record === undefined) {
      return view;
    }
    view.sandbox = this.hostFacts(record);
    if (client !== undefined) {
      const live = await this.liveFacts(client);
      if (live !== undefined) {
        view.live = live;
      }
    }
    return view;
  }

  /**
   * The record's own fields, shaped for the browser. Only a live or parked
   * sandbox has a handle to name, and only a parked one has a deadline.
   */
  private hostFacts(record: SessionRecord): SandboxHostFacts {
    const facts: SandboxHostFacts = {
      backend: record.backend,
      profile: record.profile,
      state: record.state,
      repositoryUrl: record.repositoryUrl,
      startedAt: record.createdAt,
    };
    const profile = this.deps.profiles()[record.profile];
    // A removed profile keeps its sessions readable; the image goes with it.
    if (profile !== undefined && provisionsFromImage(profile)) {
      facts.image = profile.image;
    }
    if (record.state !== "checkpointed") {
      facts.sandboxId = record.sandboxId;
    }
    if (record.state !== "running") {
      facts.expiresAt = record.expiresAt;
    }
    if (facts.sandboxId !== undefined) {
      // The host name stays valid across a hibernate and wake, so offer it
      // for every sandbox that still exists; the tab's caption covers the rest.
      const preview = this.deps.previewHost?.(facts.sandboxId);
      if (preview !== undefined) {
        facts.previewHost = preview;
      }
    }
    return facts;
  }

  /** The attached runner's own account of the machine, if it has one. */
  private async liveFacts(
    client: RunnerClient,
  ): Promise<SandboxLiveFacts | undefined> {
    try {
      const status = await client.sandboxStatus({
        timeoutMs: LIVE_FACTS_TIMEOUT_MS,
      });
      return {
        hostname: status.hostname,
        osName: status.osName,
        kernelVersion: status.kernelVersion,
        architecture: status.architecture,
        cpuCount: status.cpuCount,
        memoryTotalBytes: Number(status.memoryTotalBytes),
        workspaceDiskUsedBytes: Number(status.workspaceDiskUsedBytes),
        workspaceDiskTotalBytes: Number(status.workspaceDiskTotalBytes),
        filesystemDiskUsedBytes: Number(status.filesystemDiskUsedBytes),
        filesystemDiskTotalBytes: Number(status.filesystemDiskTotalBytes),
        uptimeSeconds: Number(status.uptimeSeconds),
        listeningPorts: status.listeningPorts.map(Number),
      };
    } catch {
      // A runner that stopped answering is not an error to report here: the
      // tab shows the host facts and the next turn replaces the runner.
      return undefined;
    }
  }
}
