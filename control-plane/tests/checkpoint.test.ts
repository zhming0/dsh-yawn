import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { artifactsDirectory } from "../src/artifacts.js";
import {
  CheckpointStore,
  parseArtifactsOutput,
  parseSaveOutput,
  RESTORE_ARTIFACTS_SCRIPT,
  RESTORE_SCRIPT,
  restoreEnvironment,
  SAVE_ARTIFACTS_SCRIPT,
  SAVE_SCRIPT,
  type GitCheckpoint,
} from "../src/checkpoint.js";
import { IdleSchedule } from "../src/manager/idle.js";
import { sleep } from "./fakes.js";

const execute = promisify(execFile);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const encode = (text: string) => new TextEncoder().encode(text);
const BUNDLE = encode("# v2 git bundle\nobjects");

/**
 * A minimal complete tar: a header block carrying the POSIX magic, closed by
 * the two zero blocks a real `tar -cf` writes.
 */
function tarBytes(): Uint8Array {
  const tar = new Uint8Array(2048);
  tar.set(encode("ustar"), 257);
  return tar;
}

describe("checkpoint", () => {
  it("reads the branch and commit lines the save script prints, then the bundle", () => {
    const output = new Uint8Array([
      ...encode(`feature\n${COMMIT}\n`),
      ...BUNDLE,
    ]);
    const saved = parseSaveOutput(output);
    expect(saved.checkpoint).toEqual({ commit: COMMIT, branch: "feature" });
    expect(new Uint8Array(saved.bundle)).toEqual(BUNDLE);
    const bare = parseSaveOutput(encode(`\n${COMMIT}\n`));
    expect(bare.checkpoint).toEqual({ commit: COMMIT });
    expect(bare.bundle.byteLength).toBe(0);
    expect(() => parseSaveOutput(encode("garbage"))).toThrow(
      /unexpected checkpoint output/,
    );
    expect(() => parseSaveOutput(encode("feature\nHEAD\n"))).toThrow(
      /unexpected checkpoint output/,
    );
    expect(() =>
      parseSaveOutput(encode(`feature\n${COMMIT}\nnot a bundle`)),
    ).toThrow(/unexpected checkpoint output/);
  });

  it("reads the artifacts flag and the tar after it", () => {
    const tar = tarBytes();
    expect(
      parseArtifactsOutput(new Uint8Array([...encode("1\n"), ...tar])),
    ).toEqual(tar);
    expect(parseArtifactsOutput(encode("0\n"))).toHaveLength(0);
    expect(() => parseArtifactsOutput(encode(""))).toThrow(
      /unexpected artifacts output/,
    );
    expect(() => parseArtifactsOutput(encode("2\n"))).toThrow(
      /unexpected artifacts output/,
    );
    expect(() =>
      parseArtifactsOutput(new Uint8Array([...encode("1\n"), 1, 2, 3])),
    ).toThrow(/unexpected artifacts output/);
    // A `1` with a buffer too short to hold a tar header is truncated, not a
    // tar with a missing magic.
    expect(() =>
      parseArtifactsOutput(
        new Uint8Array([...encode("1\n"), ...new Uint8Array(100)]),
      ),
    ).toThrow(/unexpected artifacts output/);
  });

  it("rejects a tar the output cap or the stream cut short", () => {
    const tar = tarBytes();
    const withFlag = (bytes: Uint8Array) =>
      new Uint8Array([...encode("1\n"), ...bytes]);
    // Cut inside the header: the closing zero blocks never arrive.
    expect(() => parseArtifactsOutput(withFlag(tar.slice(0, 1024)))).toThrow(
      /unexpected artifacts output/,
    );
    // Cut one byte short of a block boundary.
    expect(() =>
      parseArtifactsOutput(withFlag(tar.slice(0, tar.length - 1))),
    ).toThrow(/unexpected artifacts output/);
    // Whole blocks, but the archive never closed.
    const unclosed = tarBytes();
    unclosed.set(encode("x"), unclosed.length - 1);
    expect(() => parseArtifactsOutput(withFlag(unclosed))).toThrow(
      /unexpected artifacts output/,
    );
  });

  it("hands the restore script everything it reads", () => {
    const env = restoreEnvironment(
      { commit: COMMIT, branch: "feature" },
      BUNDLE,
    );
    expect(env).toEqual({
      DSH_YAWN_CHECKPOINT_COMMIT: COMMIT,
      DSH_YAWN_CHECKPOINT_BRANCH: "feature",
      DSH_YAWN_CHECKPOINT_HAS_BUNDLE: "1",
    });
    expect(
      restoreEnvironment({ commit: COMMIT }, new Uint8Array()),
    ).toMatchObject({
      DSH_YAWN_CHECKPOINT_BRANCH: "",
      DSH_YAWN_CHECKPOINT_HAS_BUNDLE: "0",
    });
    for (const name of Object.keys(env)) {
      expect(RESTORE_SCRIPT).toContain(`$${name}`);
    }
  });
});

/**
 * The scripts against real git: a bare "origin", a clone standing in for the
 * sandbox workspace, and a second clone standing in for its replacement. The
 * bundle travels between them through memory, as it does through the host.
 */
describe("checkpoint scripts", () => {
  let directory: string;
  let origin: string;
  let work: string;
  let replacement: string;

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execute("git", args, { cwd });
    return stdout;
  }

  async function save(cwd: string): Promise<GitCheckpoint> {
    const { stdout } = await execute("/bin/bash", ["-c", SAVE_SCRIPT], {
      cwd,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseSaveOutput(stdout);
  }

  async function saveArtifacts(cwd: string): Promise<Uint8Array> {
    const { stdout } = await execute(
      "/bin/bash",
      ["-c", SAVE_ARTIFACTS_SCRIPT],
      {
        cwd,
        env: {
          ...process.env,
          DSH_YAWN_ARTIFACTS_DIR: artifactsDirectory(cwd),
        },
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return parseArtifactsOutput(stdout);
  }

  function runScript(
    cwd: string,
    label: string,
    script: string,
    env: Record<string, string>,
    stdin: Uint8Array,
  ): Promise<unknown> {
    const child = execFile("/bin/bash", ["-c", script], {
      cwd,
      env: { ...process.env, ...env },
    });
    const done = new Promise((resolve, reject) => {
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve(undefined)
          : reject(new Error(`${label} exited ${code}: ${stderr}`)),
      );
    });
    child.stdin?.end(stdin);
    return done;
  }

  function restore(cwd: string, saved: GitCheckpoint): Promise<unknown> {
    return runScript(
      cwd,
      "restore",
      RESTORE_SCRIPT,
      restoreEnvironment(saved.checkpoint, saved.bundle),
      saved.bundle,
    );
  }

  async function status(cwd: string): Promise<string[]> {
    const output = await git(cwd, "status", "--porcelain");
    return output.split("\n").filter(Boolean).sort();
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-checkpoint-"));
    origin = join(directory, "origin.git");
    work = join(directory, "work");
    replacement = join(directory, "replacement");
    await git(directory, "init", "-q", "--bare", "-b", "main", origin);
    await git(directory, "clone", "-q", origin, work);
    await git(work, "config", "user.name", "test");
    await git(work, "config", "user.email", "test@localhost");
    await writeFile(join(work, "README.md"), "hello\n");
    await writeFile(join(work, ".gitignore"), "ignored.txt\n");
    await git(work, "add", "-A");
    await git(work, "commit", "-q", "-m", "init");
    await git(work, "push", "-q", "origin", "HEAD:main");
    // A clone of a populated repository has origin/HEAD; this one was cloned
    // while origin was still empty.
    await git(work, "remote", "set-head", "origin", "--auto");
    await git(work, "checkout", "-q", "-b", "feature");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips unpushed commits and every non-ignored change, staged or not", async () => {
    await writeFile(join(work, "lib.ts"), "export const lib = 1;\n");
    await git(work, "add", "lib.ts");
    await git(work, "commit", "-q", "-m", "add lib");
    const local = (await git(work, "rev-parse", "HEAD")).trim();
    await writeFile(join(work, "README.md"), "hello\nchanged\n");
    await writeFile(join(work, "new.ts"), "export {};\n");
    await writeFile(join(work, "ignored.txt"), "not tracked\n");
    await writeFile(join(work, ".env"), "LOCAL_SETTING=1\n");

    const saved = await save(work);
    expect(saved.checkpoint.branch).toBe("feature");
    expect(saved.checkpoint.commit).not.toBe(local);
    expect(saved.bundle.byteLength).toBeGreaterThan(0);
    // Nothing reached the remote.
    expect(await git(origin, "branch", "--list")).toBe("* main\n");

    await git(directory, "clone", "-q", origin, replacement);
    await restore(replacement, saved);

    expect(
      (await git(replacement, "symbolic-ref", "--short", "HEAD")).trim(),
    ).toBe("feature");
    expect((await git(replacement, "rev-parse", "HEAD")).trim()).toBe(local);
    expect(await status(replacement)).toEqual([
      " M README.md",
      "?? .env",
      "?? new.ts",
    ]);
  });

  it("needs no bundle for a clean detached HEAD the remote already has", async () => {
    await git(work, "checkout", "-q", "--detach", "main");
    const saved = await save(work);
    expect(saved.checkpoint).toEqual({
      commit: (await git(work, "rev-parse", "HEAD")).trim(),
    });
    expect(saved.bundle.byteLength).toBe(0);

    await git(directory, "clone", "-q", origin, replacement);
    await restore(replacement, saved);
    await expect(
      git(replacement, "symbolic-ref", "--quiet", "HEAD"),
    ).rejects.toThrow();
    expect(await status(replacement)).toEqual([]);
  });

  it("falls back to a self-contained bundle without origin/HEAD", async () => {
    await git(work, "remote", "set-head", "origin", "--delete");
    await writeFile(join(work, "new.ts"), "export {};\n");
    const saved = await save(work);
    expect(saved.bundle.byteLength).toBeGreaterThan(0);

    await git(directory, "clone", "-q", origin, replacement);
    await restore(replacement, saved);
    expect(await status(replacement)).toEqual(["?? new.ts"]);
  });

  it("does not stack a second checkpoint commit when a save is retried", async () => {
    await writeFile(join(work, "README.md"), "hello\nchanged\n");
    const first = await save(work);
    await writeFile(join(work, "later.ts"), "export {};\n");
    const second = await save(work);

    expect(second.checkpoint.commit).not.toBe(first.checkpoint.commit);
    expect((await git(work, "rev-list", "--count", "HEAD")).trim()).toBe("2");

    await git(directory, "clone", "-q", origin, replacement);
    await restore(replacement, second);
    expect(await status(replacement)).toEqual([" M README.md", "?? later.ts"]);
  });

  it("refuses to restore a commit the bundle did not bring", async () => {
    await git(directory, "clone", "-q", origin, replacement);
    await expect(
      restore(replacement, {
        checkpoint: { commit: COMMIT, branch: "feature" },
        bundle: new Uint8Array(),
      }),
    ).rejects.toThrow(/restore exited 1/);
    expect(
      (await git(replacement, "symbolic-ref", "--short", "HEAD")).trim(),
    ).toBe("main");
    expect(await status(replacement)).toEqual([]);
  });

  it("carries the artifacts folder into the replacement sandbox", async () => {
    const artifacts = artifactsDirectory(work);
    await mkdir(join(artifacts, "runs"), { recursive: true });
    await writeFile(join(artifacts, "shot.png"), "png-bytes\n");
    await writeFile(join(artifacts, "runs", "log.txt"), "run log\n");

    const tar = await saveArtifacts(work);
    expect(tar.byteLength).toBeGreaterThan(0);

    // A second workspace under its own parent, so its artifacts folder is a
    // different directory from the one the save read.
    const target = join(directory, "target");
    await mkdir(target);
    const targetWorkspace = join(target, "repository");
    await git(directory, "clone", "-q", origin, targetWorkspace);
    const targetArtifacts = artifactsDirectory(targetWorkspace);
    await runScript(
      targetWorkspace,
      "artifacts restore",
      RESTORE_ARTIFACTS_SCRIPT,
      { DSH_YAWN_ARTIFACTS_DIR: targetArtifacts },
      tar,
    );

    expect(await readFile(join(targetArtifacts, "shot.png"), "utf8")).toBe(
      "png-bytes\n",
    );
    expect(
      await readFile(join(targetArtifacts, "runs", "log.txt"), "utf8"),
    ).toBe("run log\n");
  });

  it("reports nothing to carry when the artifacts folder is missing or empty", async () => {
    expect(await saveArtifacts(work)).toHaveLength(0);
    await mkdir(artifactsDirectory(work), { recursive: true });
    expect(await saveArtifacts(work)).toHaveLength(0);
  });
});

describe("checkpoint store", () => {
  it("removes a stale artifacts tar when a later save writes none", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-checkpoint-store-"));
    try {
      const store = new CheckpointStore(join(directory, "checkpoints"));
      const tar = tarBytes();
      await store.save("session-one", BUNDLE, tar);
      expect(
        new Uint8Array((await store.loadArtifacts("session-one")) ?? []),
      ).toEqual(tar);

      // A crash between the save and the record write leaves the record
      // running, so the next save runs with the first attempt's files still
      // on disk. An empty artifacts folder must not leave the old tar behind:
      // a restore would unpack it while the notice says the folder survived.
      await store.save("session-one", BUNDLE, new Uint8Array());
      expect(await store.loadArtifacts("session-one")).toBeUndefined();

      // A non-empty save still writes the tar.
      await store.save("session-one", BUNDLE, tar);
      expect(
        new Uint8Array((await store.loadArtifacts("session-one")) ?? []),
      ).toEqual(tar);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("idle schedule", () => {
  it("warns and re-arms when a suspend attempt fails", async () => {
    const warnings: string[] = [];
    let attempts = 0;
    const idle = new IdleSchedule({
      idleMs: 5,
      ready: async () => {},
      hibernate: async () => {
        attempts += 1;
        throw new Error("bundle too large");
      },
      warn: (message) => warnings.push(message),
    });
    idle.schedule("session-one");
    await sleep(40);
    idle.dispose();
    expect(attempts).toBeGreaterThan(1);
    expect(warnings[0]).toMatch(
      /could not suspend session-one.*bundle too large/,
    );
  });
});
