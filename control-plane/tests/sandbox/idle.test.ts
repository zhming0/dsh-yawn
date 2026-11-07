import { describe, expect, it } from "vitest";

import { IdleSchedule } from "../../src/sandbox/manager/idle.js";
import { sleep } from "../support/fakes.js";

describe("idle schedule", () => {
  it("warns and re-arms when a suspend attempt fails", async () => {
    const warnings: string[] = [];
    let attempts = 0;
    const idle = new IdleSchedule({
      idleMsFor: () => 5,
      ready: async () => {},
      hibernate: async () => {
        attempts += 1;
        throw new Error("bundle too large");
      },
      warn: (message) => warnings.push(message),
    });
    idle.schedule("session-one");
    await sleep(40);
    idle.dispose();
    expect(attempts).toBeGreaterThan(1);
    expect(warnings[0]).toMatch(
      /could not suspend session-one.*bundle too large/,
    );
  });
});
