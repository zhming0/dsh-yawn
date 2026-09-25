import { AsyncLocalStorage } from "node:async_hooks";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  TerminalAttachmentId,
  TerminalController,
  TerminalCreateRequest,
  WebTerminalId,
} from "@deepseek-ai/dsh-api-terminal-controller";
import { describe, expect, it } from "vitest";

import { scopeToSession } from "../../src/terminal/terminal-controller.js";

const AGENT = { id: "session-one" } as unknown as Agent;

/** Stock method names the wrapper replaces. */
const WRAPPED = ["shells", "create", "write", "resize"] as const;

/**
 * Enough of the stock controller to prove the wrapper's effect: `shells` and
 * `create` read the initiator (as every subprocess call does) and write and
 * resize record the calls and the activity sink.
 */
class FakeTerminalController {
  readonly initiators: Agent[] = [];
  readonly calls: string[] = [];

  constructor(private readonly agents: { requireInitiator: () => Agent }) {}

  async shells(_agent: Agent, _signal: AbortSignal): Promise<unknown[]> {
    this.initiators.push(this.agents.requireInitiator());
    return [];
  }

  async create(
    _agent: Agent,
    _request: TerminalCreateRequest,
    _signal: AbortSignal,
  ): Promise<unknown> {
    this.initiators.push(this.agents.requireInitiator());
    return { id: "terminal-one" };
  }

  write(
    _agent: Agent,
    _id: WebTerminalId,
    _attachmentId: TerminalAttachmentId,
    data: string,
  ): Promise<void> {
    this.calls.push(`write:${data}`);
    return Promise.resolve();
  }

  resize(
    _agent: Agent,
    _id: WebTerminalId,
    _attachmentId: TerminalAttachmentId,
    cols: number,
    rows: number,
  ): Promise<void> {
    this.calls.push(`resize:${cols}x${rows}`);
    return Promise.resolve();
  }

  environment(_agent: Agent, _signal: AbortSignal): unknown {
    return { cwd: "/workspace/repository" };
  }

  list(_sessionId: unknown): unknown[] {
    return [];
  }

  retain(
    _sessionId: unknown,
    _id: unknown,
    _signal: AbortSignal,
  ): AsyncIterable<unknown> {
    return (async function* () {})();
  }

  follow(
    _agent: Agent,
    _id: unknown,
    _attachmentId: unknown,
    _signal: AbortSignal,
  ): AsyncIterable<unknown> {
    return (async function* () {})();
  }

  rename(_agent: Agent, _id: unknown, _title: string): void {}

  close(_agent: Agent, _id: unknown): Promise<void> {
    return Promise.resolve();
  }
}

function makeService() {
  const storage = new AsyncLocalStorage<Agent>();
  const agents = {
    requireInitiator: (): Agent => {
      const current = storage.getStore();
      if (current === undefined) {
        throw new Error("no initiating Agent");
      }
      return current;
    },
    withInitiator: <T>(initiator: Agent, operation: () => T): T =>
      storage.run(initiator, operation),
  };
  const controller = new FakeTerminalController(agents);
  const activity: Agent[] = [];
  const undo = scopeToSession(
    controller as unknown as TerminalController,
    agents,
    (agent) => activity.push(agent),
  );
  return { controller, undo, activity };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("scopeToSession for the terminal controller", () => {
  it("discovers shells and creates terminals as the session agent", async () => {
    const { controller, undo } = makeService();
    const typed = controller as unknown as TerminalController;

    await expect(typed.shells(AGENT, signal())).resolves.toEqual([]);
    await expect(
      typed.create(
        AGENT,
        { id: "terminal-one", cols: 80, rows: 24 } as TerminalCreateRequest,
        signal(),
      ),
    ).resolves.toEqual({ id: "terminal-one" });

    expect(controller.initiators).toEqual([AGENT, AGENT]);

    undo();
    // Stock behaviour again: without an agent boundary the seam refuses.
    await expect(typed.shells(AGENT, signal())).rejects.toThrow(
      "no initiating Agent",
    );
  });

  it("notes terminal input and resize as session activity", async () => {
    const { controller, activity } = makeService();
    const typed = controller as unknown as TerminalController;

    await typed.write(
      AGENT,
      "terminal-one" as WebTerminalId,
      "attachment-one" as TerminalAttachmentId,
      "ls\n",
    );
    await typed.resize(
      AGENT,
      "terminal-one" as WebTerminalId,
      "attachment-one" as TerminalAttachmentId,
      100,
      40,
    );

    expect(controller.calls).toEqual(["write:ls\n", "resize:100x40"]);
    expect(activity).toEqual([AGENT, AGENT]);
  });

  it("leaves the stock prototype and its remote markers alone, and undoes cleanly", () => {
    const { controller, undo } = makeService();
    const typed = controller as unknown as TerminalController;

    for (const method of WRAPPED) {
      expect(Object.hasOwn(controller, method)).toBe(true);
    }
    // The browser half disappears if the row is replaced rather than wrapped,
    // so the stock methods must stay exactly where the gateway describes them.
    for (const method of [
      "environment",
      "list",
      "retain",
      "follow",
      "rename",
      "close",
    ]) {
      expect(Object.hasOwn(controller, method)).toBe(false);
      expect(Reflect.get(controller, method)).toBe(
        Reflect.get(FakeTerminalController.prototype, method),
      );
    }

    undo();
    for (const method of WRAPPED) {
      expect(Object.hasOwn(controller, method)).toBe(false);
    }
    expect(Reflect.get(typed, "write")).toBe(
      Reflect.get(FakeTerminalController.prototype, "write"),
    );
  });
});
