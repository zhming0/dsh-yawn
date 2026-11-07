import { readFile } from "node:fs/promises";

import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import {
  apply,
  getForgeCredentials,
  inject,
  name,
} from "../../src/credentials/forge-credentials.js";

function makeContext() {
  const ctx = new Context();
  const calls: Array<{ host: string; repositoryUrl?: string }> = [];
  ctx.provide("sandboxManager", {
    gitCredential: async (host: string, repositoryUrl?: string) => {
      calls.push({
        host,
        ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
      });
      return host.toLowerCase() === "github.com"
        ? {
            host: "github.com",
            username: "x-access-token",
            password: "token",
          }
        : undefined;
    },
  });
  return { ctx, calls };
}

describe("forge credentials", () => {
  it("exports the row module from the package", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, unknown> };
    expect(manifest.exports?.["./forge-credentials"]).toBeDefined();
  });

  it("is optional before the row mounts", async () => {
    const { ctx } = makeContext();
    expect(getForgeCredentials(ctx)).toBeUndefined();
  });

  it("resolves a host and passes the repository scope through", async () => {
    const { ctx, calls } = makeContext();
    const fiber = await ctx.plugin({ name, inject, apply });
    const credentials = getForgeCredentials(ctx);
    expect(credentials).toBeDefined();
    await expect(
      credentials!.resolve({
        host: "GitHub.com",
        repositoryUrl: "https://github.com/example/repo.git",
      }),
    ).resolves.toEqual({ username: "x-access-token", password: "token" });
    expect(calls).toEqual([
      {
        host: "GitHub.com",
        repositoryUrl: "https://github.com/example/repo.git",
      },
    ]);
    await fiber.dispose();
    expect(getForgeCredentials(ctx)).toBeUndefined();
  });

  it("passes no repository through for a host-only lookup", async () => {
    const { ctx, calls } = makeContext();
    await ctx.plugin({ name, inject, apply });
    const credentials = getForgeCredentials(ctx)!;
    await credentials.resolve({ host: "github.com" });
    expect(calls).toEqual([{ host: "github.com" }]);
  });

  it("answers undefined when the broker has no credential", async () => {
    const { ctx } = makeContext();
    await ctx.plugin({ name, inject, apply });
    const credentials = getForgeCredentials(ctx)!;
    await expect(
      credentials.resolve({ host: "gitlab.com" }),
    ).resolves.toBeUndefined();
  });
});
