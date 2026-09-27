import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { describe, expect, it } from "vitest";

import { mediaSessionRoute, requestedSession } from "../src/media-route.js";

const IMAGE = "/api/file?path=%2Fworkspace%2Frepository%2Flogo.png";

/** The image URL the browser half produces for one conversation's session. */
const imageFor = (sessionId: string, path = IMAGE): string =>
  `${path}&dsh-yawn-session=${encodeURIComponent(sessionId)}`;

/**
 * The agent world the listener runs in: an AsyncLocalStorage initiator (the
 * same mechanism the real `agents` service uses) and a controller that
 * resumes any session except `session-gone`.
 */
function makeWorld() {
  const storage = new AsyncLocalStorage<Agent>();
  const resolved: string[] = [];
  const agents = {
    withInitiator: <T>(agent: Agent, operation: () => T): T =>
      storage.run(agent, operation),
  };
  const sessionController = {
    resolveAgent: async (sessionId: SessionId) => {
      resolved.push(String(sessionId));
      if (String(sessionId) === "session-gone") {
        return {
          error: new RemoteError("session/not-found", "gone", {
            sessionId,
          }),
        };
      }
      return {
        agent: { id: String(sessionId) } as unknown as Agent,
      };
    },
  };
  return { storage, resolved, agents, sessionController };
}

/**
 * Dispatch one request through the listener, recording the session id its
 * dispatch ran under, or null when it ran with no initiator at all.
 */
async function dispatch(
  listener: ReturnType<typeof mediaSessionRoute>,
  storage: AsyncLocalStorage<Agent>,
  request: Partial<IncomingMessage> & { url: string },
): Promise<string | null> {
  let initiator: unknown = undefined;
  await listener(
    { method: "GET", headers: {}, ...request } as IncomingMessage,
    {} as ServerResponse,
    async () => {
      initiator = storage.getStore()?.id ?? null;
    },
  );
  return initiator as string | null;
}

describe("mediaSessionRoute", () => {
  it("runs an /api/file GET as the session its query names", async () => {
    const world = makeWorld();
    const listener = mediaSessionRoute(world.agents, world.sessionController);

    const initiator = await dispatch(listener, world.storage, {
      url: imageFor("session-one"),
    });

    expect(initiator).toBe("session-one");
    expect(world.resolved).toEqual(["session-one"]);
  });

  it("keeps two sessions reading the same path apart", async () => {
    const world = makeWorld();
    const listener = mediaSessionRoute(world.agents, world.sessionController);

    const [first, second] = await Promise.all([
      dispatch(listener, world.storage, { url: imageFor("session-one") }),
      dispatch(listener, world.storage, { url: imageFor("session-two") }),
    ]);

    expect([first, second]).toEqual(["session-one", "session-two"]);
  });

  it("also serves a HEAD, but no other path or method", async () => {
    const world = makeWorld();
    const listener = mediaSessionRoute(world.agents, world.sessionController);
    expect(
      await dispatch(listener, world.storage, {
        url: imageFor("session-one"),
        method: "HEAD",
      }),
    ).toBe("session-one");
    expect(
      await dispatch(listener, world.storage, {
        url: "/api/remote.mux?dsh-yawn-session=session-one",
      }),
    ).toBeNull();
    expect(
      await dispatch(listener, world.storage, {
        url: imageFor("session-one"),
        method: "POST",
      }),
    ).toBeNull();
    expect(world.resolved).toEqual(["session-one"]);
  });

  it("passes through without a session and past one it cannot resolve", async () => {
    const world = makeWorld();
    const listener = mediaSessionRoute(world.agents, world.sessionController);

    for (const url of [
      IMAGE,
      `${IMAGE}&dsh-yawn-session=`,
      imageFor("session-gone"),
    ]) {
      expect(await dispatch(listener, world.storage, { url })).toBeNull();
    }
    expect(world.resolved).toEqual(["session-gone"]);
  });
});

describe("requestedSession", () => {
  it("reads the session a request URL's query names", () => {
    expect(requestedSession(imageFor("s-one"))).toBe("s-one");
    expect(requestedSession("/api/file?dsh-yawn-session=s-one&path=x#a")).toBe(
      "s-one",
    );
    expect(requestedSession(imageFor("s one/two"))).toBe("s one/two");
  });

  it("answers nothing for a missing or empty parameter", () => {
    expect(requestedSession(undefined)).toBeUndefined();
    expect(requestedSession("/api/file")).toBeUndefined();
    expect(requestedSession(IMAGE)).toBeUndefined();
    expect(requestedSession(`${IMAGE}&dsh-yawn-session=`)).toBeUndefined();
  });
});
