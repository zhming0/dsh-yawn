import type {
  ToolDispatchExecution,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";

import { retryLostPersistentBash } from "../src/persistent-bash-recovery.js";

const SHELL_RESET_MESSAGE =
  "The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.";

function execution(name = "bash"): ToolDispatchExecution {
  return {
    name,
    signal: new AbortController().signal,
  } as ToolDispatchExecution;
}

function success(value: string): ToolExecutionResult {
  return {
    isError: false,
    value,
    content: [{ type: "text", text: value }],
  };
}

function failure(message: string): ToolExecutionResult {
  return {
    isError: true,
    error: { message },
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}

describe("persistent bash recovery", () => {
  it("retries a cached shell that exited without a status", async () => {
    const next = vi
      .fn<() => Promise<ToolExecutionResult>>()
      .mockResolvedValueOnce(success(`[shell exited]\n${SHELL_RESET_MESSAGE}`))
      .mockResolvedValueOnce(success("[Command finished with exit code 0]"));

    await expect(retryLostPersistentBash(execution(), next)).resolves.toEqual(
      success("[Command finished with exit code 0]"),
    );
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("retries when the cached session is missing", async () => {
    const next = vi
      .fn<() => Promise<ToolExecutionResult>>()
      .mockResolvedValueOnce(failure("unknown PTY session pty-1"))
      .mockResolvedValueOnce(success("[Command finished with exit code 0]"));

    await expect(retryLostPersistentBash(execution(), next)).resolves.toEqual(
      success("[Command finished with exit code 0]"),
    );
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("retries only once", async () => {
    const stale = success(`[shell exited]\n${SHELL_RESET_MESSAGE}`);
    const next = vi
      .fn<() => Promise<ToolExecutionResult>>()
      .mockResolvedValue(stale);

    await expect(retryLostPersistentBash(execution(), next)).resolves.toBe(
      stale,
    );
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("does not retry a shell exit with a status", async () => {
    const exited = success(`[shell exited: code 7]\n${SHELL_RESET_MESSAGE}`);
    const next = vi
      .fn<() => Promise<ToolExecutionResult>>()
      .mockResolvedValue(exited);

    await expect(retryLostPersistentBash(execution(), next)).resolves.toBe(
      exited,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not touch another tool", async () => {
    const first = success("[shell exited]\n" + SHELL_RESET_MESSAGE);
    const next = vi
      .fn<() => Promise<ToolExecutionResult>>()
      .mockResolvedValue(first);

    await expect(
      retryLostPersistentBash(execution("bash_other"), next),
    ).resolves.toBe(first);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not retry after cancellation", async () => {
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));
    const first = success(`[shell exited]\n${SHELL_RESET_MESSAGE}`);
    const next = vi
      .fn<() => Promise<ToolExecutionResult>>()
      .mockResolvedValue(first);

    await expect(
      retryLostPersistentBash({ ...execution(), signal: aborted.signal }, next),
    ).resolves.toBe(first);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
