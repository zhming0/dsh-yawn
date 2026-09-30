import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadRegistrationToken } from "../src/registration-token.js";

describe("runner token", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-token-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("generates the token once and keeps it owner-only", async () => {
    const token = loadRegistrationToken(directory);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(loadRegistrationToken(directory)).toBe(token);
    const file = await stat(join(directory, "registration-token"));
    expect(file.mode & 0o777).toBe(0o600);
  });

  it("generates a new token after the file is deleted", async () => {
    const first = loadRegistrationToken(directory);
    await rm(join(directory, "registration-token"));
    expect(loadRegistrationToken(directory)).not.toBe(first);
  });
});
