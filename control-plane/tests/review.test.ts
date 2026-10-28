import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DIFF_SCRIPT,
  parseReviewDiff,
  parseReviewView,
  VIEW_SCRIPT,
} from "../src/review.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repository with an origin/main base and a feature branch one commit ahead. */
function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-review-"));
  directories.push(directory);
  git(directory, "init", "-q", "-b", "main");
  git(directory, "config", "user.email", "review@example.com");
  git(directory, "config", "user.name", "Review Test");
  writeFileSync(join(directory, "a.txt"), "one\n");
  git(directory, "add", "-A");
  git(directory, "commit", "-qm", "base");
  git(directory, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(
    directory,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  git(directory, "checkout", "-q", "-b", "feature");
  writeFileSync(join(directory, "c.txt"), "feature\n");
  git(directory, "add", "-A");
  git(directory, "commit", "-qm", "feature");
  git(directory, "checkout", "-q", "main");
  return directory;
}

function run(
  cwd: string,
  script: string,
  env: Record<string, string> = {},
): string {
  return execFileSync("bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("review view", () => {
  it("lists the working tree and branches ahead of the base", () => {
    const directory = repository();
    writeFileSync(join(directory, "a.txt"), "one\ntwo\n");
    writeFileSync(join(directory, "b.txt"), "new\n");

    const view = parseReviewView(run(directory, VIEW_SCRIPT), false);

    expect(view.kind).toBe("git");
    expect(view.baseLabel).toBe("origin/main");
    expect(view.defaultScope).toBe("worktree");
    expect(view.scopes.map((scope) => scope.id)).toEqual([
      "worktree",
      "refs/heads/feature",
    ]);
    expect(view.scopes[0]).toMatchObject({
      kind: "worktree",
      label: "Working tree",
      files: 2,
      added: 2,
      deleted: 0,
    });
    expect(view.scopes[1]).toMatchObject({
      kind: "branch",
      label: "feature",
      files: 1,
      added: 1,
      deleted: 0,
    });
  });

  it("reports a workspace without git as no-repository", () => {
    const directory = mkdtempSync(join(tmpdir(), "dsh-review-"));
    directories.push(directory);

    const view = parseReviewView(run(directory, VIEW_SCRIPT), false);

    expect(view).toEqual({
      kind: "no-repository",
      baseLabel: "",
      scopes: [],
      defaultScope: "",
      truncated: false,
    });
  });
});

describe("review diff", () => {
  it("compares the working tree, including untracked files", () => {
    const directory = repository();
    writeFileSync(join(directory, "a.txt"), "one\ntwo\n");
    writeFileSync(join(directory, "b.txt"), "new\n");

    const diff = parseReviewDiff(
      "worktree",
      run(directory, DIFF_SCRIPT, { SCOPE: "worktree" }),
      false,
    );

    expect(diff.scope).toBe("worktree");
    expect(diff.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    const added = diff.files[0];
    expect(added?.hunks.flatMap((hunk) => hunk.lines)).toContain("+two");
    const created = diff.files[1];
    expect(created).toMatchObject({
      before: false,
      after: true,
      binary: false,
      truncated: false,
    });
    expect(created?.hunks[0]?.lines).toContain("+new");
  });

  it("compares a branch against its merge base", () => {
    const directory = repository();

    const diff = parseReviewDiff(
      "refs/heads/feature",
      run(directory, DIFF_SCRIPT, { SCOPE: "refs/heads/feature" }),
      false,
    );

    expect(diff.files.map((file) => file.path)).toEqual(["c.txt"]);
    expect(diff.files[0]?.hunks[0]?.lines).toContain("+feature");
  });

  it("keeps a path with spaces intact", () => {
    const directory = repository();
    writeFileSync(join(directory, "a b.txt"), "space\n");

    const diff = parseReviewDiff(
      "worktree",
      run(directory, DIFF_SCRIPT, { SCOPE: "worktree" }),
      false,
    );

    const file = diff.files.find((candidate) => candidate.path === "a b.txt");
    expect(file?.hunks[0]?.lines).toContain("+space");
  });

  it("marks binary files without hunks", () => {
    const directory = repository();
    writeFileSync(join(directory, "bin.dat"), Buffer.from([0, 1, 2, 3]));

    const diff = parseReviewDiff(
      "worktree",
      run(directory, DIFF_SCRIPT, { SCOPE: "worktree" }),
      false,
    );

    const binary = diff.files.find((file) => file.path === "bin.dat");
    expect(binary).toMatchObject({
      binary: true,
      hunks: [],
      before: false,
      after: true,
    });
  });

  it("marks a deleted file", () => {
    const directory = repository();
    unlinkSync(join(directory, "a.txt"));

    const diff = parseReviewDiff(
      "worktree",
      run(directory, DIFF_SCRIPT, { SCOPE: "worktree" }),
      false,
    );

    const deleted = diff.files.find((file) => file.path === "a.txt");
    expect(deleted).toMatchObject({
      before: true,
      after: false,
      binary: false,
    });
    expect(deleted?.hunks.flatMap((hunk) => hunk.lines)).toContain("-one");
  });
});
