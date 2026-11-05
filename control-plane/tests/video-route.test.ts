import { AsyncLocalStorage } from "node:async_hooks";

import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  FsError,
  FsTargetKey,
  FsVersion,
  type FsTarget,
} from "@deepseek-ai/dsh-fs";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { describe, expect, it } from "vitest";

import { videoRoute } from "../src/video-route.js";
import { parseByteRange, videoMediaType } from "../src/video-media.js";

const PATH = "/workspace/repository/clip.mp4";

/** A sandbox file and the agent-bound calls the route makes against it. */
function makeWorld(content = "0123456789") {
  const storage = new AsyncLocalStorage<Agent>();
  const bytes = new TextEncoder().encode(content);
  const reads: { offset: number; length: number; as: string | null }[] = [];
  const fs = {
    resolve: async (path: string) => {
      if (storage.getStore() === undefined) {
        throw new Error("no initiator");
      }
      if (path.includes("missing")) {
        throw new FsError("missing", "FS_NOT_FOUND");
      }
      return {
        targetKey: FsTargetKey(path),
        displayPath: path,
      };
    },
    stat: async (target: FsTarget) => {
      if (target.displayPath.includes("folder")) {
        return { type: "directory" as const, version: FsVersion("v1") };
      }
      return {
        type: "file" as const,
        version: FsVersion("v1"),
        size: bytes.byteLength,
      };
    },
    readByteRange: async (
      _target: FsTarget,
      range: { offset: number; length: number },
    ) => {
      reads.push({
        ...range,
        as: storage.getStore()?.id ?? null,
      });
      return bytes.slice(range.offset, range.offset + range.length);
    },
  };
  const agents = {
    withInitiator: <T>(agent: Agent, operation: () => T): T =>
      storage.run(agent, operation),
  };
  const resolved: string[] = [];
  const sessionController = {
    resolveAgent: async (sessionId: SessionId) => {
      resolved.push(String(sessionId));
      if (String(sessionId) === "session-gone") {
        return {
          error: new RemoteError("session/not-found", "gone", { sessionId }),
        };
      }
      return { agent: { id: String(sessionId) } as unknown as Agent };
    },
  };
  const handler = videoRoute({ fs, agents, sessionController });
  return { handler, reads, resolved };
}

/** One request to the route; the session is omitted only when `session` is null. */
function request(
  init: RequestInit = {},
  path = PATH,
  session: string | null = "session-one",
): Request {
  const url = new URL("https://dsh.example.test/api/yawn-video");
  url.searchParams.set("path", path);
  if (session !== null) {
    url.searchParams.set("dsh-yawn-session", session);
  }
  return new Request(url, init);
}

describe("videoRoute", () => {
  it("streams the whole file as the session's agent", async () => {
    const { handler, reads } = makeWorld();

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("0123456789");
    expect(reads).toEqual([{ offset: 0, length: 10, as: "session-one" }]);
  });

  it("answers a Range request with 206 and that slice", async () => {
    const { handler, reads } = makeWorld();

    const response = await handler(
      request({ headers: { Range: "bytes=2-5" } }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(await response.text()).toBe("2345");
    expect(reads).toEqual([{ offset: 2, length: 4, as: "session-one" }]);
  });

  it("answers an open-ended and a suffix range", async () => {
    const { handler } = makeWorld();

    const open = await handler(request({ headers: { Range: "bytes=7-" } }));
    expect(open.status).toBe(206);
    expect(await open.text()).toBe("789");

    const suffix = await handler(request({ headers: { Range: "bytes=-3" } }));
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await suffix.text()).toBe("789");
  });

  it("refuses a range outside the file with 416", async () => {
    const { handler, reads } = makeWorld();

    const response = await handler(
      request({ headers: { Range: "bytes=20-30" } }),
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes */10");
    expect(reads).toEqual([]);
  });

  it("answers HEAD without a body", async () => {
    const { handler } = makeWorld();

    const response = await handler(request({ method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.body).toBeNull();
  });

  it("answers a ranged HEAD with 206 and no body", async () => {
    const { handler } = makeWorld();

    const response = await handler(
      request({ method: "HEAD", headers: { Range: "bytes=2-5" } }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.body).toBeNull();
  });

  it("serves an empty file as a zero-length response", async () => {
    const { handler, reads } = makeWorld("");

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("0");
    expect(await response.text()).toBe("");
    expect(reads).toEqual([]);
  });

  it("streams a large file in bounded reads", async () => {
    const content = "x".repeat(2 * 1024 * 1024 + 5);
    const { handler, reads } = makeWorld(content);

    const response = await handler(request());

    expect(await response.text()).toHaveLength(content.length);
    expect(reads.map((read) => read.length)).toEqual([
      1024 * 1024,
      1024 * 1024,
      5,
    ]);
  });

  it("rejects an absolute path and a missing session", async () => {
    const { handler, reads } = makeWorld();

    const relative = await handler(request({}, "clip.mp4"));
    expect(relative.status).toBe(400);
    expect(await relative.text()).toBe("absolute path required");

    const anonymous = await handler(request({}, PATH, null));
    expect(anonymous.status).toBe(400);
    expect(await anonymous.text()).toBe("missing session");

    expect(reads).toEqual([]);
  });

  it("does not read as an unknown session", async () => {
    const { handler, resolved, reads } = makeWorld();

    const response = await handler(request({}, PATH, "session-gone"));

    expect(response.status).toBe(404);
    expect(resolved).toEqual(["session-gone"]);
    expect(reads).toEqual([]);
  });

  it("refuses a directory and maps a missing file", async () => {
    const { handler } = makeWorld();

    const directory = await handler(
      request({}, "/workspace/repository/folder"),
    );
    expect(directory.status).toBe(403);

    const missing = await handler(
      request({}, "/workspace/repository/missing.mp4"),
    );
    expect(missing.status).toBe(404);
  });
});

describe("parseByteRange", () => {
  it("reads bounded, open-ended, and suffix ranges", () => {
    expect(parseByteRange("bytes=0-9", 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseByteRange("bytes=5-100", 10)).toEqual({ start: 5, end: 9 });
    expect(parseByteRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
    expect(parseByteRange("bytes=-100", 10)).toEqual({ start: 0, end: 9 });
  });

  it("treats a missing header as the whole file", () => {
    expect(parseByteRange(null, 10)).toBeUndefined();
  });

  it("rejects malformed, multiple, and empty-file ranges", () => {
    for (const header of [
      "bytes=20-30",
      "bytes=5-4",
      "bytes=-0",
      "bytes=0-1,4-5",
      "items=0-1",
      "bytes=",
    ]) {
      expect(parseByteRange(header, 10)).toBe("invalid");
    }
    expect(parseByteRange("bytes=0-", 0)).toBe("invalid");
  });
});

describe("videoMediaType", () => {
  it("maps the claimed suffixes and ignores everything else", () => {
    expect(videoMediaType("/a/clip.MP4")).toBe("video/mp4");
    expect(videoMediaType("C:\\a\\clip.webm")).toBe("video/webm");
    expect(videoMediaType("/a/clip.mov")).toBe("video/quicktime");
    expect(videoMediaType("/a/clip.ogv")).toBe("video/ogg");
    expect(videoMediaType("/a/clip.mkv")).toBeUndefined();
    expect(videoMediaType("/a/clip")).toBeUndefined();
  });
});
