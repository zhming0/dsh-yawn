import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { artifactsDirectory } from "./artifacts.js";
import type { RunnerClient } from "./runner-client.js";

/**
 * Where a session's work went when its sandbox could not be kept. A backend
 * without hibernation (Buildkite) loses the whole machine on idle, so the
 * manager commits the working tree inside the sandbox, pulls the commits the
 * repository's remote does not have out as a git bundle, keeps that bundle on
 * the host, and unpacks it into the next sandbox. It also carries the
 * artifacts folder, which lives outside the checkout and so cannot ride the
 * bundle.
 */
export interface Checkpoint {
  /** HEAD when the sandbox was released, after the checkpoint commit if any. */
  commit: string;
  /** Branch the session had checked out, absent when HEAD was detached. */
  branch?: string;
  /**
   * The artifacts folder was left behind: it was over the transfer cap or its
   * save failed. The Git work still came out, and the restore notice tells the
   * model the folder did not.
   */
  artifactsDropped?: boolean;
}

/**
 * A bundle bigger than this fails the checkpoint and keeps the sandbox up. A
 * bundle holds only the commits the remote lacks, so ordinary sessions stay
 * far below it; the cap bounds host memory and disk for the pathological one.
 */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/**
 * An artifacts tar bigger than this is left behind instead of carried. The
 * checkpoint rests on the Git bundle, so oversized media must not hold the
 * sandbox, and the build behind it, open; the restore notice says the folder
 * did not come back.
 */
export const MAX_ARTIFACTS_BYTES = 64 * 1024 * 1024;

const COMMIT_MESSAGE = "dsh: checkpoint before the sandbox is released";

/**
 * Shared by both scripts: is HEAD the commit the save script makes? Matching
 * the fixed author and subject means the restore only ever undoes its own
 * commit, and a save retried after a failure does not stack a second one.
 */
const IS_CHECKPOINT_COMMIT = `is_checkpoint_commit() {
  [ "$(git log -1 --format='%ae %s' 2>/dev/null)" = "dsh@localhost ${COMMIT_MESSAGE}" ]
}`;

/**
 * Runs in the sandbox before it is released. Prints two lines, the current
 * branch (empty when detached) and the resulting HEAD, followed by the bundle
 * bytes. The bundle carries every commit between HEAD and its merge base with
 * the remote's default branch, which a fresh clone always has; it is empty
 * when HEAD is already on the remote. Without a usable `origin/HEAD` the
 * bundle is self-contained. The identity is fixed because the runner image
 * configures none.
 */
export const SAVE_SCRIPT = `set -eu
${IS_CHECKPOINT_COMMIT}
branch=$(git symbolic-ref --quiet --short HEAD || true)
if is_checkpoint_commit; then
  git reset -q HEAD~1
fi
git add --all
if ! git diff --cached --quiet; then
  git -c user.name=dsh -c user.email=dsh@localhost commit -q -m "${COMMIT_MESSAGE}"
fi
head=$(git rev-parse HEAD)
base=$(git merge-base HEAD origin/HEAD 2>/dev/null || true)
printf '%s\\n%s\\n' "$branch" "$head"
if [ -z "$base" ]; then
  git bundle create -q - HEAD
elif [ "$base" != "$head" ]; then
  git bundle create -q - "$base..HEAD"
fi
`;

/**
 * Runs in the sandbox after the Git save. Prints `1` and a tar of the
 * artifacts folder, or `0` when there is nothing to carry. The folder is
 * outside the checkout, so the bundle cannot reach it and this second stream
 * is what makes it survive the checkpoint.
 */
export const SAVE_ARTIFACTS_SCRIPT = `set -eu
artifacts="$DSH_YAWN_ARTIFACTS_DIR"
if [ -d "$artifacts" ] && [ -n "$(ls -A "$artifacts")" ]; then
  printf '1\\n'
  tar -C "$artifacts" -cf - .
else
  printf '0\\n'
fi
`;

/**
 * Runs in the new sandbox after the Git restore, with the tar on stdin. The
 * folder was outside the checkout, so the fresh machine does not have it yet.
 */
export const RESTORE_ARTIFACTS_SCRIPT = `set -eu
mkdir -p "$DSH_YAWN_ARTIFACTS_DIR"
tar -x -C "$DSH_YAWN_ARTIFACTS_DIR"
`;

/**
 * Runs in the new sandbox after setup, with the bundle on stdin. Unpacks the
 * commits, puts the session back on its own branch (or a detached HEAD) at
 * the checkpoint, and turns the checkpoint commit back into uncommitted
 * changes. A commit the bundle did not bring and the clone does not have
 * stops the script before it moves anything.
 */
export const RESTORE_SCRIPT = `set -eu
${IS_CHECKPOINT_COMMIT}
if [ "$DSH_YAWN_CHECKPOINT_HAS_BUNDLE" = 1 ]; then
  git bundle unbundle - >/dev/null
fi
git cat-file -e "$DSH_YAWN_CHECKPOINT_COMMIT^{commit}"
if [ -n "$DSH_YAWN_CHECKPOINT_BRANCH" ]; then
  git checkout -q -B "$DSH_YAWN_CHECKPOINT_BRANCH" "$DSH_YAWN_CHECKPOINT_COMMIT"
  git branch -q --set-upstream-to="origin/$DSH_YAWN_CHECKPOINT_BRANCH" 2>/dev/null || true
else
  git checkout -q --detach "$DSH_YAWN_CHECKPOINT_COMMIT"
fi
if is_checkpoint_commit; then
  git reset -q HEAD~1
fi
`;

/** The Git half of a checkpoint: what the first save script prints. */
export interface GitCheckpoint {
  checkpoint: Checkpoint;
  /** Git bundle bytes; empty when the remote already has the commit. */
  bundle: Uint8Array;
}

export interface SavedCheckpoint extends GitCheckpoint {
  /** Tar of the artifacts folder; empty when there was nothing or it was dropped. */
  artifacts: Uint8Array;
  /**
   * Why the folder was left behind, when it was. The checkpoint still
   * succeeds; the host warning carries this so a failure can be told from a
   * folder that was simply over the cap.
   */
  artifactsError?: string;
}

const BUNDLE_HEADER = /^# v\d+ git bundle\n/;

export function parseSaveOutput(output: Uint8Array): GitCheckpoint {
  const buffer = Buffer.from(
    output.buffer,
    output.byteOffset,
    output.byteLength,
  );
  const first = buffer.indexOf("\n");
  const second = first === -1 ? -1 : buffer.indexOf("\n", first + 1);
  const branch = second === -1 ? "" : buffer.subarray(0, first).toString();
  const commit =
    second === -1 ? "" : buffer.subarray(first + 1, second).toString();
  const bundle = second === -1 ? buffer : buffer.subarray(second + 1);
  if (
    !/^[0-9a-f]{40}$/.test(commit) ||
    (bundle.length > 0 &&
      !BUNDLE_HEADER.test(bundle.subarray(0, 32).toString("latin1")))
  ) {
    throw new Error(
      `unexpected checkpoint output: ${JSON.stringify(buffer.subarray(0, 120).toString("latin1"))}`,
    );
  }
  return {
    checkpoint: { commit, ...(branch === "" ? {} : { branch }) },
    bundle,
  };
}

/** Offset of the POSIX tar magic in a tar header. */
const TAR_MAGIC_OFFSET = 257;
/** A tar is a whole number of these, closed by two zero blocks. */
const TAR_BLOCK_BYTES = 512;
const TAR_END_BLOCKS = 2;

/**
 * The artifacts save script's output: a `0` line when the folder was empty,
 * or a `1` line followed by a tar. A stream cut short or replaced by something
 * else is rejected here, because a tar that fails to unpack would fail the
 * restore every time the session is woken.
 */
export function parseArtifactsOutput(output: Uint8Array): Uint8Array {
  const buffer = Buffer.from(
    output.buffer,
    output.byteOffset,
    output.byteLength,
  );
  const first = buffer.indexOf("\n");
  const header = first === -1 ? "" : buffer.subarray(0, first).toString();
  if (header === "0") {
    return new Uint8Array();
  }
  const tar = buffer.subarray(first + 1);
  if (header !== "1" || !isCompleteTar(tar)) {
    throw new Error(
      `unexpected artifacts output: ${JSON.stringify(buffer.subarray(0, 120).toString("latin1"))}`,
    );
  }
  return new Uint8Array(tar);
}

/**
 * Whether the tar the save script wrote arrived whole: the POSIX magic in its
 * first header, whole 512-byte blocks, and the two zero blocks that close an
 * archive. Anything the output cap or a broken stream cut short fails here, so
 * it is left behind at save time instead of stored to fail the restore.
 */
function isCompleteTar(tar: Buffer): boolean {
  if (tar.length < TAR_BLOCK_BYTES * TAR_END_BLOCKS) {
    return false;
  }
  if (tar.length % TAR_BLOCK_BYTES !== 0) {
    return false;
  }
  if (
    tar.subarray(TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + 5).toString("latin1") !==
    "ustar"
  ) {
    return false;
  }
  const trailer = tar.subarray(tar.length - TAR_BLOCK_BYTES * TAR_END_BLOCKS);
  for (const byte of trailer) {
    if (byte !== 0) {
      return false;
    }
  }
  return true;
}

export function restoreEnvironment(
  checkpoint: Checkpoint,
  bundle: Uint8Array,
): Record<string, string> {
  return {
    DSH_YAWN_CHECKPOINT_COMMIT: checkpoint.commit,
    DSH_YAWN_CHECKPOINT_BRANCH: checkpoint.branch ?? "",
    DSH_YAWN_CHECKPOINT_HAS_BUNDLE: bundle.length > 0 ? "1" : "0",
  };
}

/**
 * Commit the session's working tree in the still-running sandbox and pull the
 * bundle and the artifacts folder out. A failed or oversized artifacts save
 * does not fail the checkpoint: the Git work is what must not be lost, so the
 * folder is left behind and recorded as dropped instead.
 */
export async function saveCheckpoint(
  client: RunnerClient,
  workspace: string,
): Promise<SavedCheckpoint> {
  const output = await runScript(client, workspace, SAVE_SCRIPT, {
    env: {},
    stdin: new Uint8Array(),
    stdoutMaxBytes: MAX_BUNDLE_BYTES,
  });
  const git = parseSaveOutput(output);
  const artifacts = await saveArtifacts(client, workspace);
  if ("error" in artifacts) {
    return {
      checkpoint: { ...git.checkpoint, artifactsDropped: true },
      bundle: git.bundle,
      artifacts: new Uint8Array(),
      artifactsError: artifacts.error,
    };
  }
  return { ...git, artifacts: artifacts.tar };
}

/** The artifacts tar, or the reason the folder could not be carried. */
async function saveArtifacts(
  client: RunnerClient,
  workspace: string,
): Promise<{ tar: Uint8Array } | { error: string }> {
  try {
    const output = await runScript(client, workspace, SAVE_ARTIFACTS_SCRIPT, {
      env: { DSH_YAWN_ARTIFACTS_DIR: artifactsDirectory(workspace) },
      stdin: new Uint8Array(),
      stdoutMaxBytes: MAX_ARTIFACTS_BYTES,
    });
    return { tar: parseArtifactsOutput(output) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Turn a fresh clone back into the session's tree, then put the artifacts
 * folder back into place.
 */
export async function restoreCheckpoint(
  client: RunnerClient,
  workspace: string,
  checkpoint: Checkpoint,
  bundle: Uint8Array,
  artifacts: Uint8Array,
): Promise<void> {
  await runScript(client, workspace, RESTORE_SCRIPT, {
    env: restoreEnvironment(checkpoint, bundle),
    stdin: bundle,
    stdoutMaxBytes: 4096,
  });
  if (artifacts.length > 0) {
    await runScript(client, workspace, RESTORE_ARTIFACTS_SCRIPT, {
      env: { DSH_YAWN_ARTIFACTS_DIR: artifactsDirectory(workspace) },
      stdin: artifacts,
      stdoutMaxBytes: 4096,
    });
  }
}

/**
 * One bundle and, when the session had one, one artifacts tar per
 * checkpointed session, next to the file index in the host's state directory.
 * Same trust domain as a hibernated sandbox's disk: whatever the working tree
 * or the artifacts folder held, ignored files aside, is in here.
 */
export class CheckpointStore {
  constructor(private readonly directory: string) {}

  async save(
    sessionId: string,
    bundle: Uint8Array,
    artifacts: Uint8Array,
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.write(this.bundlePath(sessionId), bundle);
    if (artifacts.length > 0) {
      await this.write(this.artifactsPath(sessionId), artifacts);
    } else {
      // A save retried after a crash runs while the record is still running,
      // so a previous tar can be on disk. Removing it keeps the pair matching
      // the record: otherwise the restore unpacks files from an older sandbox
      // while the notice says the folder came back.
      await rm(this.artifactsPath(sessionId), { force: true });
    }
  }

  async load(sessionId: string): Promise<Uint8Array | undefined> {
    return this.read(this.bundlePath(sessionId));
  }

  /** The artifacts tar, absent when the folder was empty or left behind. */
  async loadArtifacts(sessionId: string): Promise<Uint8Array | undefined> {
    return this.read(this.artifactsPath(sessionId));
  }

  async remove(sessionId: string): Promise<void> {
    await Promise.all([
      rm(this.bundlePath(sessionId), { force: true }),
      rm(this.artifactsPath(sessionId), { force: true }),
    ]);
  }

  private async read(path: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(path);
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async write(path: string, bytes: Uint8Array): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path);
  }

  private bundlePath(sessionId: string): string {
    return join(this.directory, `${encodeURIComponent(sessionId)}.bundle`);
  }

  private artifactsPath(sessionId: string): string {
    return join(
      this.directory,
      `${encodeURIComponent(sessionId)}.artifacts.tar`,
    );
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Run a bash script in the workspace and return its stdout. Plain `bash -c`,
 * not a login shell: profile output would land in the parsed stdout.
 */
async function runScript(
  client: RunnerClient,
  workspace: string,
  script: string,
  options: {
    env: Record<string, string>;
    stdin: Uint8Array;
    stdoutMaxBytes: number;
  },
): Promise<Uint8Array> {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let stdoutBytes = 0;
  let exited = false;
  const stream = client.exec({
    argv: ["/bin/bash", "-c", script],
    cwd: workspace,
    env: options.env,
    stdin: options.stdin,
  });
  for await (const { event } of stream) {
    if (event.case === "stdout") {
      stdoutBytes += event.value.byteLength;
      if (stdoutBytes > options.stdoutMaxBytes) {
        throw new Error(
          `checkpoint script output exceeds ${options.stdoutMaxBytes} bytes`,
        );
      }
      stdout.push(event.value);
    } else if (event.case === "stderr") {
      stderr.push(event.value);
    } else if (event.case === "exited") {
      exited = true;
      if (event.value.exitCode !== 0) {
        throw new Error(
          `checkpoint script failed with exit code ${event.value.exitCode}: ${Buffer.concat(stderr).toString().trim()}`,
        );
      }
    }
  }
  if (!exited) {
    throw new Error("checkpoint script ended without an exit status");
  }
  return Buffer.concat(stdout);
}
