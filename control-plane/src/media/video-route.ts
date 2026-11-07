/**
 * Streams a video file from a session's sandbox to the browser preview.
 *
 * The right sidebar's document preview can render only the file types it
 * knows. A video needs a URL a `<video>` element can range-request, not a
 * complete byte array: a recording is often larger than the workspace-files
 * complete-file cap, and seeking must not download the whole file first. This
 * route answers `GET` and `HEAD` with one byte range at a time, reading each
 * window through `ctx.fs` as the agent of the session named in the query.
 *
 * dsh's `/api/file` route cannot carry this: it streams nothing, applies the
 * image limit, and an exact route cannot be registered twice. This route is
 * separate, authenticated by Connection like every other `/api` route, and
 * takes the same `dsh-yawn-session` hint the chat's image rewrite adds. The
 * hint is not a credential: the request is already authenticated, and it only
 * selects the sandbox whose file the operator can already browse.
 *
 * @module @zhming0/dsh-yawn/video-route
 */

import { isAbsolute } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { FileSystem, FsTarget } from "@deepseek-ai/dsh-fs";
import { FsError } from "@deepseek-ai/dsh-fs";
import { SessionId } from "@deepseek-ai/dsh-session";

import { MEDIA_SESSION_PARAM } from "./session-param.js";
import {
  parseByteRange,
  VIDEO_ROUTE,
  videoMediaType,
  type ByteRange,
} from "./video-media.js";

type RouteFs = Pick<FileSystem, "resolve" | "stat" | "readByteRange">;
type Initiators = Pick<Context["agents"], "withInitiator">;
type SessionResolver = Pick<Context["sessionController"], "resolveAgent">;

/** Bytes read from the runner per stream pull. */
const CHUNK_BYTES = 1024 * 1024;

export const name = "sandbox-video-route";

/**
 * Wait for the Web-only services instead of injecting them, so a headless
 * profile stays bootable without the route's browser partner.
 */
export function apply(ctx: Context): void {
  ctx.inject(["agents", "sessionController", "connection", "fs"], (scope) => {
    scope.effect(
      () =>
        scope.connection.fetch.register({
          path: VIDEO_ROUTE,
          methods: ["GET", "HEAD"],
          requestBody: "buffered",
          fetch: videoRoute({
            fs: scope.fs,
            agents: scope.agents,
            sessionController: scope.sessionController,
          }),
        }),
      "sandbox-video-route: route",
    );
  });
}

/** The services one video request needs. */
export interface VideoRouteServices {
  readonly fs: RouteFs;
  readonly agents: Initiators;
  readonly sessionController: SessionResolver;
}

/** One authenticated video request handler. */
export function videoRoute(
  services: VideoRouteServices,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (
      path === null ||
      path.length === 0 ||
      path.includes("\0") ||
      !isAbsolute(path)
    ) {
      return failure(request.method, 400, "absolute path required");
    }
    const sessionId = url.searchParams.get(MEDIA_SESSION_PARAM);
    if (sessionId === null || sessionId.length === 0) {
      return failure(request.method, 400, "missing session");
    }
    const resolved = await services.sessionController.resolveAgent(
      SessionId(sessionId),
    );
    if ("error" in resolved) {
      return failure(request.method, 404, "session not found");
    }
    return serve(services, resolved.agent, request, path);
  };
}

/** Resolve, bound, and stream one file for an already-resolved session agent. */
async function serve(
  services: VideoRouteServices,
  agent: Agent,
  request: Request,
  path: string,
): Promise<Response> {
  try {
    const target = await services.agents.withInitiator(agent, () =>
      services.fs.resolve(path, { signal: request.signal }),
    );
    const info = await services.agents.withInitiator(agent, () =>
      services.fs.stat(target, request.signal),
    );
    if (info === undefined) {
      return failure(request.method, 404, "not found");
    }
    if (info.type !== "file") {
      return failure(request.method, 403, "not a regular file");
    }
    if (info.size === undefined) {
      return failure(request.method, 500, "file size unavailable");
    }
    const size = info.size;
    const range = parseByteRange(request.headers.get("range"), size);
    if (range === "invalid") {
      return new Response(null, {
        status: 416,
        headers: {
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
          "Content-Range": `bytes */${size}`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, size - 1);
    const headers = videoHeaders(path, size, range, start, end);
    if (request.method === "HEAD" || size === 0) {
      return new Response(null, {
        status: range === undefined ? 200 : 206,
        headers,
      });
    }
    return new Response(
      readRange(services, agent, target, start, end, request.signal),
      { status: range === undefined ? 200 : 206, headers },
    );
  } catch (error) {
    const status = errorStatus(error);
    return failure(
      request.method,
      status,
      error instanceof Error ? error.message : "video read failed",
    );
  }
}

/** One ranged response's headers, including a length that matches the range. */
function videoHeaders(
  path: string,
  size: number,
  range: ByteRange | undefined,
  start: number,
  end: number,
): Headers {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Length": String(range === undefined ? size : end - start + 1),
    "Content-Type": videoMediaType(path) ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  if (range !== undefined) {
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  return headers;
}

/**
 * Pull the requested window in bounded chunks. Each pull runs as the session's
 * agent explicitly: the stream is consumed after the request dispatcher has
 * returned, so it cannot rely on the caller's async context.
 */
function readRange(
  services: VideoRouteServices,
  agent: Agent,
  target: FsTarget,
  start: number,
  end: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let offset = start;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset > end) {
        controller.close();
        return;
      }
      const length = Math.min(CHUNK_BYTES, end - offset + 1);
      try {
        const bytes = await services.agents.withInitiator(agent, () =>
          services.fs.readByteRange(target, { offset, length }, signal),
        );
        if (bytes.byteLength === 0) {
          controller.close();
          return;
        }
        offset += bytes.byteLength;
        controller.enqueue(bytes);
        if (offset > end) {
          controller.close();
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** A short plain-text error; HEAD keeps the same headers without a body. */
function failure(method: string, status: number, message: string): Response {
  return new Response(method === "HEAD" ? null : message, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Map filesystem failures onto the status the browser expects. */
function errorStatus(error: unknown): number {
  if (!(error instanceof FsError)) {
    return 500;
  }
  switch (error.code) {
    case "FS_NOT_FOUND":
      return 404;
    case "FS_NOT_REGULAR_FILE":
    case "FS_PERMISSION_DENIED":
    case "FS_SANDBOX_DENIED":
      return 403;
    case "FS_TOO_LARGE":
      return 413;
    case "FS_ABORTED":
      return 499;
    default:
      return 500;
  }
}
