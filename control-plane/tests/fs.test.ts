import { Code, ConnectError } from "@connectrpc/connect";
import { Context } from "@deepseek-ai/cordis";
import { FsTargetKey, FsVersion, type FsTarget } from "@deepseek-ai/dsh-fs";
import { parsePatch } from "@deepseek-ai/dsh-fs-patch";
import { describe, expect, it } from "vitest";

import SandboxFileSystem from "../src/fs.js";
import { FileType } from "../src/gen/dsh/yawn/v1/runner_pb.js";
import type { RunnerClient } from "../src/runner-client.js";

interface FakeFile {
  content: Uint8Array;
  version: string;
  mode: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A tiny in-memory runner: enough of the file RPCs for the sandbox provider. */
function fakeRunner(files: Map<string, FakeFile>) {
  let nextVersion = 1;
  const writes: { path: string; mode: number }[] = [];
  const deletes: string[] = [];
  const client = {
    async readFile({ path, maxBytes }: { path: string; maxBytes: bigint }) {
      const file = files.get(path);
      if (file === undefined) {
        throw new ConnectError("not found", Code.NotFound);
      }
      if (BigInt(file.content.byteLength) > maxBytes) {
        throw new ConnectError("too large", Code.ResourceExhausted);
      }
      return { content: file.content };
    },
    async stat({ path }: { path: string }) {
      const file = files.get(path);
      return file === undefined
        ? { exists: false }
        : {
            exists: true,
            type: FileType.REGULAR,
            size: BigInt(file.content.byteLength),
            version: file.version,
            mode: file.mode,
          };
    },
    async writeFile({
      path,
      content,
      guard,
      mode,
    }: {
      path: string;
      content: Uint8Array;
      guard: { case?: string; value?: unknown };
      mode: number;
    }) {
      const existing = files.get(path);
      if (guard.case === "createIfAbsent" && existing !== undefined) {
        throw new ConnectError("file exists", Code.AlreadyExists);
      }
      if (
        guard.case === "expectedVersion" &&
        (existing === undefined || existing.version !== guard.value)
      ) {
        throw new ConnectError("version mismatch", Code.FailedPrecondition);
      }
      const before = existing?.content;
      const file = {
        content,
        version: `v${nextVersion++}`,
        mode: mode === 0 ? (existing?.mode ?? 0o644) : mode,
      };
      files.set(path, file);
      writes.push({ path, mode: file.mode });
      return {
        created: existing === undefined,
        hadBefore: before !== undefined,
        before: before ?? new Uint8Array(),
        version: file.version,
      };
    },
    async deleteFile({
      path,
      expectedVersion,
    }: {
      path: string;
      expectedVersion: string;
    }) {
      const file = files.get(path);
      if (file === undefined) {
        throw new ConnectError("not found", Code.NotFound);
      }
      if (expectedVersion !== "" && file.version !== expectedVersion) {
        throw new ConnectError("version mismatch", Code.FailedPrecondition);
      }
      files.delete(path);
      deletes.push(path);
      return {};
    },
  } as unknown as RunnerClient;
  return { client, files, writes, deletes };
}

function makeFileSystem(files: Map<string, FakeFile>) {
  const runner = fakeRunner(files);
  const ctx = new Context();
  ctx.provide("sandboxManager", {
    workspace: "/workspace/repository",
    clientForCurrentAgent: async () => runner.client,
    rootSessionIdForCurrentAgent: () => "session-one",
  });
  ctx.provide("agents", {
    requireInitiator: () => ({ session: { header: { cwd: "/anchor" } } }),
  });
  return { fs: new SandboxFileSystem(ctx), ...runner };
}

function target(path: string): FsTarget {
  return { targetKey: FsTargetKey(path), displayPath: path };
}

describe("SandboxFileSystem mutations", () => {
  it("applies a patch to LF-normalized text and restores CRLF", async () => {
    const files = new Map<string, FakeFile>([
      [
        "/workspace/repository/a.txt",
        {
          content: encoder.encode("hello\r\nworld\r\n"),
          version: "v0",
          mode: 0o644,
        },
      ],
    ]);
    const { fs, writes } = makeFileSystem(files);
    const operations = parsePatch(
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-hello\n+hi\n*** End Patch",
    );
    const operation = operations[0];
    if (operation?.kind !== "update") {
      throw new Error("expected an update operation");
    }

    const result = await fs.patchText(
      target("/workspace/repository/a.txt"),
      operation.hunks,
    );

    expect(result.before).toBe("hello\nworld\n");
    expect(result.after).toBe("hi\nworld\n");
    expect(
      decoder.decode(files.get("/workspace/repository/a.txt")?.content),
    ).toBe("hi\r\nworld\r\n");
    expect(writes).toEqual([
      { path: "/workspace/repository/a.txt", mode: 0o644 },
    ]);
  });

  it("deletes a file under its expected version and returns the basis", async () => {
    const files = new Map<string, FakeFile>([
      [
        "/workspace/repository/a.txt",
        { content: encoder.encode("hello\n"), version: "v7", mode: 0o644 },
      ],
    ]);
    const { fs, deletes } = makeFileSystem(files);

    const result = await fs.deleteFile(target("/workspace/repository/a.txt"), {
      version: FsVersion("v7"),
    });

    expect(result.before).toBe("hello\n");
    expect(deletes).toEqual(["/workspace/repository/a.txt"]);
    expect(files.has("/workspace/repository/a.txt")).toBe(false);
  });

  it("moves a file with its source mode and removes the source", async () => {
    const files = new Map<string, FakeFile>([
      [
        "/workspace/repository/a.sh",
        { content: encoder.encode("#!/bin/sh\n"), version: "v1", mode: 0o755 },
      ],
    ]);
    const { fs, deletes, writes } = makeFileSystem(files);

    const result = await fs.moveFile(
      target("/workspace/repository/a.sh"),
      target("/workspace/repository/b.sh"),
      {},
    );

    expect(result.sourceDeleted).toBe(true);
    expect(result.sourceBefore).toBe("#!/bin/sh\n");
    expect(result.destination.operation).toBe("create");
    expect(writes).toEqual([
      { path: "/workspace/repository/b.sh", mode: 0o755 },
    ]);
    expect(files.get("/workspace/repository/b.sh")?.content).toEqual(
      encoder.encode("#!/bin/sh\n"),
    );
    expect(deletes).toEqual(["/workspace/repository/a.sh"]);
  });

  it("reports a retained source when the destination published but delete failed", async () => {
    const files = new Map<string, FakeFile>([
      [
        "/workspace/repository/a.txt",
        { content: encoder.encode("one\n"), version: "v1", mode: 0o644 },
      ],
    ]);
    const { fs, client } = makeFileSystem(files);
    client.deleteFile = async () => {
      throw new ConnectError("permission denied", Code.PermissionDenied);
    };

    const result = await fs.moveFile(
      target("/workspace/repository/a.txt"),
      target("/workspace/repository/b.txt"),
      {},
    );

    expect(result.destination.operation).toBe("create");
    expect(result.sourceDeleted).toBe(false);
    if (result.sourceDeleted) {
      throw new Error("source should have been retained");
    }
    expect(result.sourceFailure).toEqual({
      code: "FS_PERMISSION_DENIED",
      message: 'cannot delete "/workspace/repository/a.txt": permission denied',
    });
  });
});
