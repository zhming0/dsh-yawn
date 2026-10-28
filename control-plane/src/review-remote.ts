import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

/** One reviewable scope: the working tree or one branch with commits ahead of its base. */
export interface ReviewScope {
  /** `worktree`, or the full branch ref the client passes back to `getReviewDiff`. */
  id: string;
  kind: "worktree" | "branch";
  /** Display label: `Working tree`, or the branch name without its `refs/heads/`. */
  label: string;
  /** Base commit the scope is compared against. */
  base: string;
  /** Human-readable base name, such as `origin/main`. */
  baseLabel: string;
  /** The commit the scope points at: the working tree's HEAD, or the branch commit. */
  head: string;
  files: number;
  added: number;
  deleted: number;
}

/** The scopes one session can review right now. */
export interface ReviewView {
  kind: "git" | "no-repository" | "no-sandbox";
  baseLabel: string;
  scopes: ReviewScope[];
  /** Scope the client opens first; empty when there is nothing to review. */
  defaultScope: string;
  /** Some branches were omitted from the scope list. */
  truncated: boolean;
}

/** One unified-diff hunk, with line numbers and prefixed lines. */
export interface ReviewHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Hunk body lines, each prefixed with `+`, `-`, or a space. */
  lines: string[];
}

/** One changed file in a scope comparison. */
export interface ReviewFile {
  path: string;
  added: number;
  deleted: number;
  /** Git reported the file as binary; `hunks` is empty. */
  binary: boolean;
  /** The patch was cut before this file's comparison was complete. */
  truncated: boolean;
  /** Whether the file existed before the change. */
  before: boolean;
  /** Whether the file exists after the change. */
  after: boolean;
  hunks: ReviewHunk[];
}

/** The comparison for one selected scope. */
export interface ReviewDiff {
  scope: string;
  files: ReviewFile[];
  /** The patch was capped; later files may carry `truncated` and no hunks. */
  truncated: boolean;
}

/** The browser-facing methods added to the `sandboxManager` namespace. */
export interface ReviewRemote {
  getReview(sessionId: string): Promise<RemoteResult<ReviewView>>;
  getReviewDiff(
    sessionId: string,
    scope: string,
  ): Promise<RemoteResult<ReviewDiff>>;
}

const stringSchema: TypertSchema<string> = {
  parse(value: unknown): string {
    if (typeof value !== "string") {
      throw new TypeError("expected a string");
    }
    return value;
  },
};

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`expected ${what}`);
  }
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  what: string,
): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new TypeError(`expected ${what}.${key}`);
  }
  return field;
}

function booleanField(
  value: Record<string, unknown>,
  key: string,
  what: string,
): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw new TypeError(`expected ${what}.${key}`);
  }
  return field;
}

function countField(
  value: Record<string, unknown>,
  key: string,
  what: string,
): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new TypeError(`expected ${what}.${key}`);
  }
  return field;
}

function arrayField(
  value: Record<string, unknown>,
  key: string,
  what: string,
): unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) {
    throw new TypeError(`expected ${what}.${key}`);
  }
  return field;
}

function parseHunk(value: unknown, what: string): ReviewHunk {
  const hunk = record(value, what);
  const lines = arrayField(hunk, "lines", what);
  for (const line of lines) {
    if (typeof line !== "string") {
      throw new TypeError(`expected ${what}.lines`);
    }
  }
  return {
    oldStart: countField(hunk, "oldStart", what),
    oldLines: countField(hunk, "oldLines", what),
    newStart: countField(hunk, "newStart", what),
    newLines: countField(hunk, "newLines", what),
    lines: lines as string[],
  };
}

function parseFile(value: unknown, what: string): ReviewFile {
  const file = record(value, what);
  const hunks = arrayField(file, "hunks", what).map((hunk, index) =>
    parseHunk(hunk, `${what}.hunks[${String(index)}]`),
  );
  return {
    path: stringField(file, "path", what),
    added: countField(file, "added", what),
    deleted: countField(file, "deleted", what),
    binary: booleanField(file, "binary", what),
    truncated: booleanField(file, "truncated", what),
    before: booleanField(file, "before", what),
    after: booleanField(file, "after", what),
    hunks,
  };
}

function parseScope(value: unknown, what: string): ReviewScope {
  const scope = record(value, what);
  const kind = stringField(scope, "kind", what);
  if (kind !== "worktree" && kind !== "branch") {
    throw new TypeError(`expected ${what}.kind`);
  }
  return {
    id: stringField(scope, "id", what),
    kind,
    label: stringField(scope, "label", what),
    base: stringField(scope, "base", what),
    baseLabel: stringField(scope, "baseLabel", what),
    head: stringField(scope, "head", what),
    files: countField(scope, "files", what),
    added: countField(scope, "added", what),
    deleted: countField(scope, "deleted", what),
  };
}

const viewSchema: TypertSchema<ReviewView> = {
  parse(value: unknown): ReviewView {
    const view = record(value, "a review view");
    const kind = stringField(view, "kind", "review view");
    if (kind !== "git" && kind !== "no-repository" && kind !== "no-sandbox") {
      throw new TypeError("expected review view.kind");
    }
    return {
      kind,
      baseLabel: stringField(view, "baseLabel", "review view"),
      scopes: arrayField(view, "scopes", "review view").map((scope, index) =>
        parseScope(scope, `review view.scopes[${String(index)}]`),
      ),
      defaultScope: stringField(view, "defaultScope", "review view"),
      truncated: booleanField(view, "truncated", "review view"),
    };
  },
};

const diffSchema: TypertSchema<ReviewDiff> = {
  parse(value: unknown): ReviewDiff {
    const diff = record(value, "a review diff");
    return {
      scope: stringField(diff, "scope", "review diff"),
      files: arrayField(diff, "files", "review diff").map((file, index) =>
        parseFile(file, `review diff.files[${String(index)}]`),
      ),
      truncated: booleanField(diff, "truncated", "review diff"),
    };
  },
};

/** The two methods this package adds to the existing `sandboxManager` namespace. */
export const reviewDescriptors: InvocationDescriptor[] = [
  {
    id: "@zhming0/dsh-yawn#sandboxManager/getReview",
    service: "sandboxManager",
    namespace: "sandboxManager",
    method: "getReview",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "sessionId",
        wire: "sessionId",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: "@zhming0/dsh-yawn#sandboxManager/getReview:sessionId",
          create: () => stringSchema,
        },
      },
    ],
    result: {
      mode: "strict",
      typeSymbol: "@zhming0/dsh-yawn#sandboxManager/getReview:result",
      create: () => viewSchema,
    },
  },
  {
    id: "@zhming0/dsh-yawn#sandboxManager/getReviewDiff",
    service: "sandboxManager",
    namespace: "sandboxManager",
    method: "getReviewDiff",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "sessionId",
        wire: "sessionId",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol:
            "@zhming0/dsh-yawn#sandboxManager/getReviewDiff:sessionId",
          create: () => stringSchema,
        },
      },
      {
        name: "scope",
        wire: "scope",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: "@zhming0/dsh-yawn#sandboxManager/getReviewDiff:scope",
          create: () => stringSchema,
        },
      },
    ],
    result: {
      mode: "strict",
      typeSymbol: "@zhming0/dsh-yawn#sandboxManager/getReviewDiff:result",
      create: () => diffSchema,
    },
  },
];
