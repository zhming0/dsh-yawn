import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Type-only import for the declaration merge that defines the
// `conversation.view` slot key and the session standard props.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

import type {
  ReviewDiff,
  ReviewFile,
  ReviewHunk,
  ReviewScope,
  ReviewView,
} from "../review-remote.js";

export interface ReviewActions {
  getReview: (sessionId: string) => Promise<ReviewView>;
  getReviewDiff: (sessionId: string, scope: string) => Promise<ReviewDiff>;
}

type ReviewTabProps = PropsRuntime<"conversation.view"> & ReviewActions;

const captionColor = "var(--dsw-alias-label-tertiary)";
const secondaryColor = "var(--dsw-alias-label-secondary)";
const borderColor = "var(--dsw-alias-border-l1)";
const codeFont = "var(--dsw-font-markdown-code-block-small)";
/** A file expanded on open is capped so a huge first file does not paint by itself. */
const AUTO_EXPAND_LINES = 500;

const buttonStyle = {
  border: `1px solid ${borderColor}`,
  borderRadius: 6,
  background: "transparent",
  color: secondaryColor,
  cursor: "pointer",
  padding: "2px 8px",
  font: "inherit",
  fontSize: 12,
} as const;

const selectStyle = {
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
  border: `1px solid ${borderColor}`,
  borderRadius: 6,
  padding: "4px 8px",
  font: "inherit",
  maxWidth: 520,
} as const;

const tableStyle = {
  borderCollapse: "collapse",
  width: "100%",
  font: codeFont,
  fontSize: 12,
  lineHeight: 1.5,
} as const;

const numberCellStyle = {
  width: 1,
  padding: "0 8px",
  textAlign: "right",
  verticalAlign: "top",
  color: captionColor,
  userSelect: "none",
  whiteSpace: "nowrap",
} as const;

const signCellStyle = {
  width: 1,
  padding: "0 6px 0 0",
  verticalAlign: "top",
  userSelect: "none",
  whiteSpace: "nowrap",
} as const;

const codeCellStyle = {
  padding: 0,
  verticalAlign: "top",
  whiteSpace: "pre",
} as const;

/**
 * The Review view: one diff at a time for the session's working tree or one of
 * its branches. The list only carries counts; the comparison is fetched when a
 * scope is selected, and only expanded files render their hunks.
 */
export function ReviewTab({
  sessionId,
  useSession,
  getReview,
  getReviewDiff,
}: ReviewTabProps) {
  const id = String(sessionId);
  const running = useSession((session) => session.running);
  const [view, setView] = useState<ReviewView>();
  const [viewError, setViewError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<string>();
  const [diff, setDiff] = useState<ReviewDiff>();
  const [diffError, setDiffError] = useState<string>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [refresh, setRefresh] = useState(0);
  const [viewVersion, setViewVersion] = useState(0);
  const cache = useRef(new Map<string, ReviewDiff>());
  const actions = useRef({ getReview, getReviewDiff });
  actions.current = { getReview, getReviewDiff };
  const viewGeneration = useRef(0);
  const diffGeneration = useRef(0);

  const loadView = useCallback(async () => {
    const generation = ++viewGeneration.current;
    diffGeneration.current += 1;
    setLoading(true);
    setViewError(undefined);
    try {
      const next = await actions.current.getReview(id);
      if (generation !== viewGeneration.current) {
        return;
      }
      cache.current.clear();
      setView(next);
      setViewVersion((value) => value + 1);
      setScope((previous) => {
        if (
          previous !== undefined &&
          next.scopes.some((candidate) => candidate.id === previous)
        ) {
          return previous;
        }
        return next.defaultScope === "" ? undefined : next.defaultScope;
      });
    } catch (reason) {
      if (generation === viewGeneration.current) {
        setViewError(describe(reason));
      }
    } finally {
      if (generation === viewGeneration.current) {
        setLoading(false);
      }
    }
  }, [id]);

  const loadDiff = useCallback(
    async (target: string) => {
      const generation = ++diffGeneration.current;
      const cached = cache.current.get(target);
      if (cached !== undefined) {
        setDiff(cached);
        setDiffError(undefined);
        setDiffLoading(false);
        setExpanded(new Set(firstSmallFile(cached)));
        return;
      }
      setDiff(undefined);
      setDiffLoading(true);
      setDiffError(undefined);
      try {
        const next = await actions.current.getReviewDiff(id, target);
        if (generation !== diffGeneration.current) {
          return;
        }
        cache.current.set(target, next);
        setDiff(next);
        setExpanded(new Set(firstSmallFile(next)));
      } catch (reason) {
        if (generation === diffGeneration.current) {
          setDiffError(describe(reason));
        }
      } finally {
        if (generation === diffGeneration.current) {
          setDiffLoading(false);
        }
      }
    },
    [id],
  );

  useEffect(() => {
    void loadView();
  }, [loadView, running, refresh]);

  useEffect(() => {
    if (scope === undefined) {
      diffGeneration.current += 1;
      setDiff(undefined);
      setDiffError(undefined);
      setDiffLoading(false);
      setExpanded(new Set());
      return;
    }
    void loadDiff(scope);
  }, [loadDiff, scope, viewVersion]);

  const onRefresh = useCallback(() => {
    cache.current.clear();
    setDiff(undefined);
    setRefresh((value) => value + 1);
  }, []);

  const toggle = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const selected = useMemo(
    () => view?.scopes.find((candidate) => candidate.id === scope),
    [scope, view],
  );

  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        color: "var(--dsw-alias-label-primary)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 16px",
          borderBottom: `1px solid ${borderColor}`,
          flex: "none",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Review</h2>
        {view?.kind === "git" && view.baseLabel !== "" && (
          <span style={{ fontSize: 12, color: captionColor }}>
            vs {view.baseLabel}
          </span>
        )}
        {selected !== undefined && (
          <>
            <span style={{ fontSize: 12, color: secondaryColor }}>
              {selected.label}
            </span>
            <span style={{ fontSize: 12, color: captionColor }}>
              {selected.files} {selected.files === 1 ? "file" : "files"} · +
              {selected.added} −{selected.deleted}
            </span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {loading && (
          <span style={{ fontSize: 12, color: captionColor }}>Loading…</span>
        )}
        <button type="button" style={buttonStyle} onClick={onRefresh}>
          Refresh
        </button>
      </header>

      {viewError !== undefined ? (
        <Message text={viewError} tone="error" />
      ) : view === undefined ? (
        <Message text="Loading changes…" />
      ) : view.kind === "no-sandbox" ? (
        <Message
          text={
            running === true
              ? "The sandbox is starting. Review will be available when the turn finishes."
              : "This session has no sandbox yet. Send a prompt first; Review reads the workspace inside it."
          }
        />
      ) : view.kind === "no-repository" ? (
        <Message text="This workspace is not a git repository. Review needs one." />
      ) : view.scopes.length === 0 ? (
        <Message text="No changes in this workspace." />
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {view.scopes.length > 1 && (
            <div
              style={{
                padding: "10px 16px",
                borderBottom: `1px solid ${borderColor}`,
                flex: "none",
              }}
            >
              <select
                aria-label="Review scope"
                value={scope ?? ""}
                style={selectStyle}
                onChange={(event) => {
                  setScope(
                    event.target.value === "" ? undefined : event.target.value,
                  );
                }}
              >
                {view.scopes.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {scopeLabel(candidate)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: "auto",
              padding: "0 16px 24px",
            }}
          >
            {view.truncated && (
              <p style={{ color: captionColor, fontSize: 12 }}>
                Some review scopes were omitted; the list is truncated.
              </p>
            )}
            {diffError !== undefined ? (
              <Message text={diffError} tone="error" />
            ) : diffLoading ? (
              <Message text="Loading comparison…" />
            ) : diff === undefined ? (
              <Message text="Choose a scope to review." />
            ) : diff.truncated ? (
              <p style={{ color: captionColor, fontSize: 12 }}>
                The comparison was truncated; later files may show no diff.
              </p>
            ) : null}

            {diff?.files.map((file) => (
              <FileSection
                key={file.path}
                file={file}
                open={expanded.has(file.path)}
                onToggle={toggle}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function scopeLabel(scope: ReviewScope): string {
  return `${scope.label} · ${String(scope.files)} ${
    scope.files === 1 ? "file" : "files"
  } · +${String(scope.added)} −${String(scope.deleted)}`;
}

function firstSmallFile(diff: ReviewDiff): string[] {
  const small = diff.files.find(
    (file) =>
      !file.binary && !file.truncated && lineCount(file) <= AUTO_EXPAND_LINES,
  );
  return small === undefined ? [] : [small.path];
}

function lineCount(file: ReviewFile): number {
  return file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
}

function FileSection({
  file,
  open,
  onToggle,
}: {
  file: ReviewFile;
  open: boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <section
      style={{
        borderBottom: `1px solid ${borderColor}`,
        padding: "6px 0",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          onToggle(file.path);
        }}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          padding: "4px 0",
          border: "none",
          background: "transparent",
          color: "inherit",
          font: "inherit",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span style={{ color: captionColor, width: 12 }}>
          {open ? "▾" : "▸"}
        </span>
        <span
          style={{
            fontFamily: "var(--dsw-font-markdown-code-font-family)",
            fontSize: 13,
            overflowWrap: "anywhere",
          }}
        >
          {file.path}
        </span>
        <span
          style={{ fontSize: 12, color: captionColor, whiteSpace: "nowrap" }}
        >
          {file.before ? "" : "new · "}
          {file.after ? "" : "deleted · "}
          {file.binary
            ? "binary"
            : file.truncated && file.hunks.length === 0
              ? "diff unavailable"
              : `+${String(file.added)} −${String(file.deleted)}${
                  file.truncated ? " · truncated" : ""
                }`}
        </span>
      </button>
      {open && !file.binary && file.hunks.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          {file.hunks.map((hunk, index) => (
            <HunkTable key={index} hunk={hunk} />
          ))}
        </div>
      )}
    </section>
  );
}

interface DiffRow {
  kind: "add" | "del" | "context";
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

const HunkTable = ({ hunk }: { hunk: ReviewHunk }) => {
  const rows = useMemo(() => buildRows(hunk), [hunk]);
  return (
    <div style={{ margin: "4px 0 8px" }}>
      <div
        style={{
          fontSize: 11,
          color: captionColor,
          padding: "2px 0",
          fontFamily: "var(--dsw-font-markdown-code-font-family)",
        }}
      >
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      <table style={tableStyle}>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={index}
              style={{
                background:
                  row.kind === "add"
                    ? "var(--dsw-alias-code-diff-added)"
                    : row.kind === "del"
                      ? "var(--dsw-alias-code-diff-deleted)"
                      : "transparent",
              }}
            >
              <td style={numberCellStyle}>{row.oldNumber ?? ""}</td>
              <td style={numberCellStyle}>{row.newNumber ?? ""}</td>
              <td
                style={{
                  ...signCellStyle,
                  color:
                    row.kind === "add"
                      ? "var(--dsw-alias-state-success-primary)"
                      : row.kind === "del"
                        ? "var(--dsw-alias-state-error-primary)"
                        : secondaryColor,
                }}
              >
                {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
              </td>
              <td style={codeCellStyle}>
                <span
                  style={{
                    color:
                      row.kind === "add"
                        ? "var(--dsw-alias-state-success-primary)"
                        : row.kind === "del"
                          ? "var(--dsw-alias-state-error-primary)"
                          : secondaryColor,
                  }}
                >
                  {row.text === "" ? "\u00a0" : row.text}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

function buildRows(hunk: ReviewHunk): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNumber = hunk.oldStart;
  let newNumber = hunk.newStart;
  for (const line of hunk.lines) {
    const prefix = line[0] ?? " ";
    const text = line.slice(1);
    if (prefix === "-") {
      rows.push({
        kind: "del",
        oldNumber,
        newNumber: null,
        text,
      });
      oldNumber += 1;
    } else if (prefix === "+") {
      rows.push({
        kind: "add",
        oldNumber: null,
        newNumber,
        text,
      });
      newNumber += 1;
    } else {
      rows.push({
        kind: "context",
        oldNumber,
        newNumber,
        text,
      });
      oldNumber += 1;
      newNumber += 1;
    }
  }
  return rows;
}

function Message({
  text,
  tone = "muted",
}: {
  text: string;
  tone?: "muted" | "error";
}) {
  return (
    <p
      style={{
        margin: 0,
        padding: "16px",
        color:
          tone === "error"
            ? "var(--dsw-alias-state-error-primary)"
            : captionColor,
        fontSize: 13,
      }}
    >
      {text}
    </p>
  );
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
