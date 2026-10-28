import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import type {
  ShellExecutor,
  ShellExecRequest,
  ShellRunResult,
} from "@deepseek-ai/dsh-shell";

import type {
  ReviewDiff,
  ReviewFile,
  ReviewHunk,
  ReviewScope,
  ReviewView,
} from "./review-remote.js";

/** A view listing costs one git tree snapshot and one diff per branch. */
const VIEW_TIMEOUT_MS = 30_000;
/** One selected scope may hold a large patch, so it gets its own deadline. */
const DIFF_TIMEOUT_MS = 60_000;
const VIEW_OUTPUT_BYTES = 8 * 1024 * 1024;
const DIFF_OUTPUT_BYTES = 12 * 1024 * 1024;
/** Retained patch bytes; the script cuts here so the beginning survives, not a tail. */
const MAX_PATCH_BYTES = 8 * 1024 * 1024;
/** Branch scopes beyond this are omitted; the view reports the cut. */
const MAX_BRANCHES = 20;

const PATCH_MARKER = "__DSH_REVIEW_PATCH_7f3c__";
const TRUNCATED_MARKER = "__DSH_REVIEW_TRUNCATED_7f3c__";

/**
 * The view script. It prints one line per field; numstat is NUL-delimited and
 * base64-wrapped so a path can hold any byte. It runs at the sandbox workspace
 * root and never interpolates a caller string.
 */
export const VIEW_SCRIPT = `set -u
if ! root=$(git rev-parse --show-toplevel 2>/dev/null); then
  printf 'none\\n'
  exit 0
fi
printf 'root\\t%s\\n' "$root"
base_ref=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
if [ -n "$base_ref" ] && ! git rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null 2>&1; then
  base_ref=''
fi
base=''
if [ -n "$base_ref" ]; then
  base=$(git merge-base HEAD "$base_ref" 2>/dev/null || true)
fi
if [ -z "$base" ]; then
  base=$(git rev-parse HEAD 2>/dev/null || true)
fi
if [ -z "$base" ]; then
  printf 'none\\n'
  exit 0
fi
printf 'base\\t%s\\n' "$base"
printf 'baseLabel\\t%s\\n' "\${base_ref:-HEAD}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
gitdir=$(git rev-parse --git-dir 2>/dev/null || true)
if [ -n "$gitdir" ]; then
  cp "$gitdir/index" "$tmp/index" 2>/dev/null || true
fi
objects="$tmp/objects"
mkdir -p "$objects"
repo_objects=$(git rev-parse --git-path objects 2>/dev/null || true)
export GIT_OBJECT_DIRECTORY="$objects"
if [ -n "$repo_objects" ]; then
  export GIT_ALTERNATE_OBJECT_DIRECTORIES="$repo_objects"
fi
GIT_INDEX_FILE="$tmp/index" git add --all --ignore-errors . >/dev/null 2>&1 || true
tree=$(GIT_INDEX_FILE="$tmp/index" git write-tree 2>/dev/null || true)
if [ -n "$tree" ]; then
  numstat=$(git -c core.quotePath=false diff --numstat -z --no-renames "$base" "$tree" | base64 | tr -d '\\n')
  head=$(git rev-parse HEAD 2>/dev/null || true)
  printf 'worktree\\t%s\\t%s\\n' "$head" "$numstat"
fi
count=0
for ref in $(git for-each-ref --format='%(refname)' refs/heads); do
  count=$((count + 1))
  if [ "$count" -gt ${MAX_BRANCHES} ]; then
    printf 'truncated\\n'
    break
  fi
  mb=$(git merge-base "$base" "$ref" 2>/dev/null || true)
  [ -n "$mb" ] || continue
  ahead=$(git rev-list --count "$mb..$ref" 2>/dev/null || printf '0')
  [ "$ahead" -gt 0 ] || continue
  numstat=$(git -c core.quotePath=false diff --numstat -z --no-renames "$mb" "$ref" | base64 | tr -d '\\n')
  printf 'branch\\t%s\\t%s\\t%s\\n' "$ref" "$mb" "$numstat"
done
`;

/**
 * The comparison script for one scope. `SCOPE` arrives in the environment, so
 * a branch name is never pasted into shell syntax. The patch is capped at the
 * front on purpose: truncating the tail of a stream would keep the least useful
 * files.
 */
export const DIFF_SCRIPT = `set -u
scope=\${SCOPE:?}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ "$scope" = worktree ]; then
  base_ref=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  if [ -n "$base_ref" ] && ! git rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null 2>&1; then
    base_ref=''
  fi
  base=''
  if [ -n "$base_ref" ]; then
    base=$(git merge-base HEAD "$base_ref" 2>/dev/null || true)
  fi
  if [ -z "$base" ]; then
    base=$(git rev-parse HEAD 2>/dev/null || exit 3)
  fi
  gitdir=$(git rev-parse --git-dir 2>/dev/null || true)
  if [ -n "$gitdir" ]; then
    cp "$gitdir/index" "$tmp/index" 2>/dev/null || true
  fi
  objects="$tmp/objects"
  mkdir -p "$objects"
  repo_objects=$(git rev-parse --git-path objects 2>/dev/null || true)
  export GIT_OBJECT_DIRECTORY="$objects"
  if [ -n "$repo_objects" ]; then
    export GIT_ALTERNATE_OBJECT_DIRECTORIES="$repo_objects"
  fi
  GIT_INDEX_FILE="$tmp/index" git add --all --ignore-errors . >/dev/null 2>&1 || true
  tree=$(GIT_INDEX_FILE="$tmp/index" git write-tree 2>/dev/null || exit 4)
  left="$base"
  right="$tree"
else
  git rev-parse --verify --quiet "$scope^{commit}" >/dev/null 2>&1 || exit 5
  base_ref=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  if [ -n "$base_ref" ] && ! git rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null 2>&1; then
    base_ref=''
  fi
  base=''
  if [ -n "$base_ref" ]; then
    base=$(git merge-base HEAD "$base_ref" 2>/dev/null || true)
  fi
  if [ -z "$base" ]; then
    base=$(git rev-parse HEAD 2>/dev/null || exit 3)
  fi
  left=$(git merge-base "$base" "$scope" 2>/dev/null || exit 6)
  right="$scope"
fi
git -c core.quotePath=false diff --numstat -z --no-renames "$left" "$right" | base64 | tr -d '\\n'
printf '\\n${PATCH_MARKER}\\n'
patch="$tmp/patch"
git -c core.quotePath=false diff -p --no-color --no-ext-diff --unified=3 --no-renames "$left" "$right" > "$patch" || exit 7
size=$(wc -c < "$patch" | tr -d ' ')
if [ "$size" -gt ${MAX_PATCH_BYTES} ]; then
  head -c ${MAX_PATCH_BYTES} "$patch"
  printf '\\n${TRUNCATED_MARKER}\\n'
else
  cat "$patch"
fi
`;

interface ReviewShell {
  agents: Context["agents"];
  shell: ShellExecutor;
  agent: Agent;
}

interface NumstatEntry {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
}

/**
 * Run one review script as the session's agent. The shell service resolves its
 * workdir and runner client from the agent boundary, the same way a tool call
 * does, so a hibernated sandbox wakes for the read.
 */
async function runReviewShell(
  deps: ReviewShell,
  command: string,
  options: {
    timeoutMs: number;
    stdoutMaxBytes: number;
    env?: Record<string, string>;
  },
): Promise<ShellRunResult> {
  return deps.agents.withInitiator(deps.agent, async () => {
    const request: ShellExecRequest = {
      command,
      timeoutMs: options.timeoutMs,
      stdoutMaxBytes: options.stdoutMaxBytes,
      ...(options.env === undefined ? {} : { env: options.env }),
    };
    const execution = await deps.shell.execute(deps.shell.resolve(request));
    return execution.result();
  });
}

function failed(what: string, run: ShellRunResult): Error {
  if (run.timedOut) {
    return new Error(`review ${what} timed out`);
  }
  if (run.aborted) {
    return new Error(`review ${what} was cancelled`);
  }
  const stderr = run.stderr.text.trim();
  const code = run.exitCode === null ? "" : ` (exit ${String(run.exitCode)})`;
  return new Error(
    `review ${what} failed${code}${stderr === "" ? "" : `: ${stderr}`}`,
  );
}

function assertScope(scope: string): void {
  if (scope === "worktree") {
    return;
  }
  if (
    !scope.startsWith("refs/heads/") ||
    scope.length === "refs/heads/".length ||
    /[\0\r\n]/.test(scope)
  ) {
    throw new Error("review: invalid scope");
  }
}

/** List the scopes one session can review now. */
export async function runReviewView(deps: ReviewShell): Promise<ReviewView> {
  const run = await runReviewShell(deps, VIEW_SCRIPT, {
    timeoutMs: VIEW_TIMEOUT_MS,
    stdoutMaxBytes: VIEW_OUTPUT_BYTES,
  });
  if (run.timedOut || run.aborted || run.exitCode !== 0) {
    throw failed("view", run);
  }
  return parseReviewView(run.stdout.text, run.stdout.truncated);
}

/** Compare one selected scope against its base. */
export async function runReviewDiff(
  deps: ReviewShell,
  scope: string,
): Promise<ReviewDiff> {
  assertScope(scope);
  const run = await runReviewShell(deps, DIFF_SCRIPT, {
    timeoutMs: DIFF_TIMEOUT_MS,
    stdoutMaxBytes: DIFF_OUTPUT_BYTES,
    env: { SCOPE: scope },
  });
  if (run.timedOut || run.aborted || run.exitCode !== 0) {
    throw failed("diff", run);
  }
  return parseReviewDiff(scope, run.stdout.text, run.stdout.truncated);
}

/** Parse the view script's line protocol. Exported for tests. */
export function parseReviewView(
  stdout: string,
  outputTruncated: boolean,
): ReviewView {
  let root = "";
  let base = "";
  let baseLabel = "HEAD";
  let worktree: { head: string; numstat: string } | undefined;
  const branches: Array<{
    ref: string;
    base: string;
    numstat: string;
  }> = [];
  let truncated = outputTruncated;

  for (const line of stdout.split("\n")) {
    if (line === "" || line === "none") {
      continue;
    }
    const fields = line.split("\t");
    const tag = fields[0];
    if (tag === "root") {
      root = fields[1] ?? "";
    } else if (tag === "base") {
      base = fields[1] ?? "";
    } else if (tag === "baseLabel") {
      baseLabel = fields[1] ?? "HEAD";
    } else if (tag === "worktree") {
      worktree = { head: fields[1] ?? "", numstat: fields[2] ?? "" };
    } else if (tag === "branch") {
      branches.push({
        ref: fields[1] ?? "",
        base: fields[2] ?? "",
        numstat: fields[3] ?? "",
      });
    } else if (tag === "truncated") {
      truncated = true;
    }
  }

  if (root === "" || base === "") {
    return {
      kind: "no-repository",
      baseLabel: "",
      scopes: [],
      defaultScope: "",
      truncated: false,
    };
  }

  const scopes: ReviewScope[] = [];
  if (worktree !== undefined) {
    const files = parseNumstat(worktree.numstat);
    if (files.length > 0) {
      const totals = totalsOf(files);
      scopes.push({
        id: "worktree",
        kind: "worktree",
        label: "Working tree",
        base,
        baseLabel,
        head: worktree.head,
        files: files.length,
        added: totals.added,
        deleted: totals.deleted,
      });
    }
  }
  for (const branch of branches) {
    const files = parseNumstat(branch.numstat);
    if (files.length === 0) {
      continue;
    }
    const totals = totalsOf(files);
    scopes.push({
      id: branch.ref,
      kind: "branch",
      label: branch.ref.replace(/^refs\/heads\//, ""),
      base: branch.base,
      baseLabel,
      head: branch.ref,
      files: files.length,
      added: totals.added,
      deleted: totals.deleted,
    });
  }

  return {
    kind: "git",
    baseLabel,
    scopes,
    defaultScope: scopes[0]?.id ?? "",
    truncated,
  };
}

/** Parse the comparison script's numstat + patch payload. Exported for tests. */
export function parseReviewDiff(
  scope: string,
  stdout: string,
  outputTruncated: boolean,
): ReviewDiff {
  const marker = `\n${PATCH_MARKER}\n`;
  const markerAt = stdout.indexOf(marker);
  const numstatText = markerAt === -1 ? stdout : stdout.slice(0, markerAt);
  let patch = markerAt === -1 ? "" : stdout.slice(markerAt + marker.length);
  let truncated = outputTruncated || markerAt === -1;

  const cut = `\n${TRUNCATED_MARKER}\n`;
  if (patch.endsWith(cut)) {
    patch = patch.slice(0, -cut.length);
    truncated = true;
  }

  const entries = parseNumstat(numstatText);
  const sections = splitSections(patch);
  const byPath = new Map(sections.map((section) => [section.path, section]));
  const lastSection = sections.at(-1)?.path;

  const files: ReviewFile[] = entries.map((entry) => {
    const section = byPath.get(entry.path);
    if (section === undefined) {
      return {
        path: entry.path,
        added: entry.added,
        deleted: entry.deleted,
        binary: entry.binary,
        truncated,
        before: true,
        after: true,
        hunks: [],
      };
    }
    const binary = entry.binary || sectionBinary(section.lines);
    const before = !section.lines.some((line) =>
      line.startsWith("new file mode"),
    );
    const after = !section.lines.some((line) =>
      line.startsWith("deleted file mode"),
    );
    return {
      path: entry.path,
      added: entry.added,
      deleted: entry.deleted,
      binary,
      truncated: truncated && section.path === lastSection,
      before,
      after,
      hunks: binary ? [] : parseHunks(section.lines),
    };
  });

  return { scope, files, truncated };
}

function totalsOf(entries: NumstatEntry[]): {
  added: number;
  deleted: number;
} {
  let added = 0;
  let deleted = 0;
  for (const entry of entries) {
    added += entry.added;
    deleted += entry.deleted;
  }
  return { added, deleted };
}

function parseNumstat(encoded: string): NumstatEntry[] {
  if (encoded === "") {
    return [];
  }
  const entries: NumstatEntry[] = [];
  const text = Buffer.from(encoded, "base64").toString("utf8");
  for (const record of text.split("\0")) {
    if (record === "") {
      continue;
    }
    const first = record.indexOf("\t");
    const second = first === -1 ? -1 : record.indexOf("\t", first + 1);
    if (first === -1 || second === -1) {
      continue;
    }
    const addedText = record.slice(0, first);
    const deletedText = record.slice(first + 1, second);
    const path = record.slice(second + 1);
    if (path === "") {
      continue;
    }
    const binary = addedText === "-" || deletedText === "-";
    entries.push({
      path,
      added: binary ? 0 : numberOrZero(addedText),
      deleted: binary ? 0 : numberOrZero(deletedText),
      binary,
    });
  }
  return entries;
}

function numberOrZero(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

interface PatchSection {
  path: string;
  lines: string[];
}

function splitSections(patch: string): PatchSection[] {
  const sections: PatchSection[] = [];
  let current: string[] | undefined;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = [line];
      sections.push({ path: "", lines: current });
    } else if (current !== undefined) {
      current.push(line);
    }
  }
  for (const section of sections) {
    section.path = sectionPath(section.lines);
  }
  return sections.filter((section) => section.path !== "");
}

function sectionPath(lines: string[]): string {
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const path = stripPrefix(line.slice(4));
      if (path !== "") {
        return path;
      }
    }
  }
  for (const line of lines) {
    if (line.startsWith("--- ")) {
      const path = stripPrefix(line.slice(4));
      if (path !== "") {
        return path;
      }
    }
  }
  const header = lines[0];
  if (header === undefined || !header.startsWith("diff --git a/")) {
    return "";
  }
  const rest = header.slice("diff --git a/".length);
  const middle = rest.indexOf(" b/");
  return middle === -1 ? "" : rest.slice(0, middle);
}

function stripPrefix(path: string): string {
  // Git appends a tab to a header path containing a space, so the header is
  // unambiguous; compare the path itself, not that terminator.
  const candidate = path.endsWith("\t") ? path.slice(0, -1) : path;
  if (candidate === "/dev/null") {
    return "";
  }
  if (candidate.startsWith("a/") || candidate.startsWith("b/")) {
    return candidate.slice(2);
  }
  return candidate;
}

function sectionBinary(lines: string[]): boolean {
  return lines.some((line) => line.startsWith("Binary files "));
}

function parseHunks(lines: string[]): ReviewHunk[] {
  const hunks: ReviewHunk[] = [];
  let current: ReviewHunk | undefined;
  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      const header = parseHunkHeader(line);
      current = header === undefined ? undefined : { ...header, lines: [] };
      if (current !== undefined) {
        hunks.push(current);
      }
      continue;
    }
    if (current === undefined || line.startsWith("\\")) {
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      current.lines.push(line);
    }
  }
  return hunks;
}

function parseHunkHeader(
  line: string,
):
  | Pick<ReviewHunk, "oldStart" | "oldLines" | "newStart" | "newLines">
  | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (match === null) {
    return undefined;
  }
  return {
    oldStart: Number(match[1] ?? "0"),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3] ?? "0"),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
}
