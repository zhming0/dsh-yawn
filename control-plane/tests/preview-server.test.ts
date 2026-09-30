import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandboxManager } from "../src/manager/index.js";
import { previewHost } from "../src/preview.js";
import type { RunnerClient } from "../src/runner-client.js";

const REPOSITORY = "https://github.com/example/public.git";
const DOMAIN = "sandbox.example.com";

describe("preview listener on the manager", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-control-plane-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("serves previews by host name when a domain is configured", async () => {
    const ctx = new Context();
    const gateway = {
      waitFor: async () =>
        ({
          httpProxy: async function* () {
            yield {
              part: {
                case: "head",
                value: {
                  status: 200,
                  headers: [{ name: "content-type", value: "text/html" }],
                },
              },
            };
            yield {
              part: { case: "body", value: new TextEncoder().encode("hi") },
            };
          },
        }) as unknown as RunnerClient,
      drop() {},
    };
    // The manager's own tunnel is skipped by injecting the gateway; the
    // preview listener is what this test drives, on an ephemeral port.
    const manager = new SandboxManager(
      ctx,
      {
        stateDir: directory,
        repository: REPOSITORY,
        profiles: { standard: { backend: "docker", image: "runner:test" } },
        preview: { domain: DOMAIN, port: 0, bind: "127.0.0.1" },
      },
      { backends: {}, gateway },
    );

    // The constructor loads its stores in the background; disposing does not
    // wait for them, so settle that work before `afterEach` removes the
    // directory underneath it.
    await manager.getSessionProfile("session-one");
    const port = manager.previewPort();
    expect(port).toBeDefined();

    const host = previewHost(DOMAIN, "sandbox-one", 3000);
    const answer = await request(port as number, host, "/app?q=1");
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("text/html");
    expect(answer.body).toBe("hi");

    // The status names the domain even before any sandbox exists, so the
    // Preview tab can say what is configured rather than nothing.
    expect(await manager.getSandboxStatus("session-one")).toEqual({
      previewDomain: DOMAIN,
    });

    // Disposing the context closes the listener with everything else.
    await ctx.fiber.dispose();
    await expect(request(port as number, host, "/")).rejects.toThrow();
  });

  it("starts no listener without a preview domain", async () => {
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        stateDir: directory,
        repository: REPOSITORY,
        profiles: { standard: { backend: "docker", image: "runner:test" } },
      },
      { backends: {}, gateway: fakeGateway() },
    );
    await manager.getSessionProfile("session-one");
    expect(manager.previewPort()).toBeUndefined();
    expect(await manager.getSandboxStatus("session-one")).toEqual({});
    await ctx.fiber.dispose();
  });
});

function fakeGateway() {
  return {
    waitFor: async () => {
      throw new Error("no runner");
    },
    drop() {},
  };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

/** One HTTP request naming a host the server never resolves. */
function request(port: number, host: string, path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path, headers: { host } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as Record<string, string | string[]>,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}
