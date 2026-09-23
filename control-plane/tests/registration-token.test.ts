import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegistrationTokens } from "../src/registration-token.js";

describe("runner tokens", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-tokens-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("generates one token on first use and persists it", async () => {
    const tokens = new RegistrationTokens(directory);
    const current = tokens.current();
    expect(current).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.accepted()).toEqual([current]);
    expect(tokens.view()).toEqual({ current, retiring: [] });

    // A second owner of the same state directory reads the same token, so
    // runners from an earlier control-plane process stay registerable.
    expect(new RegistrationTokens(directory).current()).toBe(current);
    const stored = JSON.parse(
      await readFile(join(directory, "registration-token.json"), "utf8"),
    ) as { current: string };
    expect(stored.current).toBe(current);
  });

  it("rotates onto a new current while keeping the old one accepted", () => {
    const tokens = new RegistrationTokens(directory);
    const first = tokens.current();

    const rotated = tokens.rotate();
    expect(rotated.current).not.toBe(first);
    expect(rotated.retiring).toEqual([first]);
    expect(tokens.accepted()).toEqual([rotated.current, first]);

    // Rotation survives a restart: the tunnel must still admit a runner that
    // booted before it.
    const reloaded = new RegistrationTokens(directory);
    expect(reloaded.accepted()).toEqual([rotated.current, first]);
  });

  it("drops retired tokens from the accepted set", () => {
    const tokens = new RegistrationTokens(directory);
    const first = tokens.current();
    tokens.rotate();

    const retired = tokens.retire();
    expect(retired.retiring).toEqual([]);
    expect(tokens.accepted()).toEqual([retired.current]);
    expect(tokens.accepted()).not.toContain(first);

    // Retiring with nothing left is a no-op, not an error.
    expect(tokens.retire()).toEqual(retired);
  });

  it("refuses a state file that does not hold a token", async () => {
    await writeFile(
      join(directory, "registration-token.json"),
      '{"current":""}',
    );
    expect(() => new RegistrationTokens(directory)).toThrow(
      "does not hold a runner token",
    );
  });
});
