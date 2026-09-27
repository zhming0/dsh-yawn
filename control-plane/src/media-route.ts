/**
 * Runs dsh's `/api/file` route (the chat's inline images) as the session the
 * image belongs to.
 *
 * `SessionMediaReferences` in `dsh-api-session-controller` serves that route
 * by reading through `ctx.fs`, from a plain browser GET: no agent turn
 * around the call, and no session id in the URL. This bundle's filesystem
 * finds a sandbox through the calling agent, so the stock route failed with
 * "no initiator" on every request and the chat showed "image preview
 * unavailable" while the sidebar (whose `workspace-files` calls carry a
 * session scope) worked.
 *
 * The missing identity arrives as the `dsh-yawn-session` query parameter:
 * the bundle's browser half adds, to each chat image's URL, the session of
 * the conversation view the image sits in (`src/client/media-session.ts`).
 * The stock route reads only `path`, so the extra parameter is harmless to
 * it. This row listens on the `connection/request` waterfall — which the
 * connection service runs after it has authenticated the request — and, for
 * `/api/file` only, resolves that session to its live agent and runs the
 * rest of the dispatch inside `agents.withInitiator`. The initiator travels
 * with the request's async chain into the route handler and its `ctx.fs`
 * calls, so the read reaches exactly the sandbox that conversation uses,
 * subagent lineage included (sandbox identity is root-keyed).
 *
 * The parameter is a hint, not a credential: the request is already
 * authenticated, and any value only selects a sandbox the operator can read
 * from the sidebar anyway. Anything but a clean hit is a pass-through — other
 * paths and methods, no session parameter, a session the controller cannot
 * resolve — and the stock route then fails as it did before, rather than
 * read a guessed sandbox.
 *
 * @module @zhming0/dsh-yawn/media-route
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Context } from "@deepseek-ai/cordis";
// Type-only: declares the `connection/request` waterfall on cordis Events.
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import { SessionId } from "@deepseek-ai/dsh-session";

import { MEDIA_SESSION_PARAM } from "./client/media-session.js";

type SessionResolver = Pick<Context["sessionController"], "resolveAgent">;
type Initiators = Pick<Context["agents"], "withInitiator">;

/** The exact route `SessionMediaReferences` mounts. */
const MEDIA_ROUTE = "/api/file";

export const name = "sandbox-media-route";

/**
 * Wait for the services rather than static-inject them: `sessionController`
 * comes with the Web surface only, and a waiting row keeps a headless
 * profile bootable (the same shape as `sandbox-workspace-files`).
 */
export function apply(ctx: Context): void {
  ctx.inject(["agents", "sessionController"], (scope) => {
    scope.on(
      "connection/request",
      mediaSessionRoute(scope.agents, scope.sessionController),
    );
  });
}

/**
 * The waterfall listener: for `/api/file` GET/HEAD whose query names a
 * session, run the rest of the dispatch as that session's agent. Everything
 * else passes through untouched.
 */
export function mediaSessionRoute(
  agents: Initiators,
  sessionController: SessionResolver,
): (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => Promise<void>,
) => Promise<void> {
  return (request, _response, next) => {
    if (
      (request.method !== "GET" && request.method !== "HEAD") ||
      pathname(request.url) !== MEDIA_ROUTE
    ) {
      return next();
    }
    const sessionId = requestedSession(request.url);
    if (sessionId === undefined) {
      return next();
    }
    return sessionController
      .resolveAgent(SessionId(sessionId))
      .then((resolved) =>
        "error" in resolved
          ? next()
          : agents.withInitiator(resolved.agent, next),
      );
  };
}

/** The request's pathname, without its query or fragment. */
function pathname(url: string | undefined): string {
  if (url === undefined) {
    return "";
  }
  const cut = url.search(/[?#]/u);
  return cut === -1 ? url : url.slice(0, cut);
}

/** The session a request URL's query names, when it names one. */
export function requestedSession(url: string | undefined): string | undefined {
  const start = url?.indexOf("?") ?? -1;
  if (url === undefined || start === -1) {
    return undefined;
  }
  const query = url.slice(start + 1).split("#")[0];
  const sessionId = new URLSearchParams(query).get(MEDIA_SESSION_PARAM);
  return sessionId === null || sessionId.length === 0 ? undefined : sessionId;
}
