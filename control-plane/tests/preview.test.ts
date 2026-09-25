import http2 from "node:http2";
import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";

import type { ServiceImpl } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { describe, expect, it } from "vitest";
import { createWebSocketStream, WebSocket } from "ws";

import {
  RunnerService,
  type HttpProxyHeader,
  type HttpProxyRequest,
  type HttpProxyRequestHead,
} from "../src/gen/dsh/yawn/v1/runner_pb.js";
import { parsePreviewHost, previewHost } from "../src/preview.js";
import type { PreviewGateway } from "../src/preview-relay.js";
import { PreviewServer } from "../src/preview-server.js";
import type { RunnerClient } from "../src/runner-client.js";
import { SANDBOX_ID_HEADER, TunnelServer } from "../src/tunnel.js";

/** The runner's registration token; previews carry none of their own. */
const REGISTRATION_TOKEN = "registration-token";
const DOMAIN = "sandbox.example.com";
const HOST = previewHost(DOMAIN, "sandbox-one", 3000);

describe("preview hosts", () => {
  it("round-trips its own hosts, port suffix included", () => {
    expect(parsePreviewHost(DOMAIN, HOST)).toEqual({
      sandboxId: "sandbox-one",
      port: 3000,
    });
    expect(parsePreviewHost(DOMAIN, `${HOST}:8443`)).toEqual({
      sandboxId: "sandbox-one",
      port: 3000,
    });
    // Case-insensitive on the wire.
    expect(parsePreviewHost(DOMAIN, HOST.toUpperCase())).toEqual({
      sandboxId: "sandbox-one",
      port: 3000,
    });
    // A sandbox id may itself contain the marker; only the last one is the port.
    expect(
      parsePreviewHost(DOMAIN, previewHost(DOMAIN, "dsh-a-p1-b", 5173)),
    ).toEqual({ sandboxId: "dsh-a-p1-b", port: 5173 });
  });

  it("rejects a bad port and a foreign host", () => {
    expect(parsePreviewHost(DOMAIN, `a-p0.${DOMAIN}`)).toBeUndefined();
    expect(parsePreviewHost(DOMAIN, `a-p70000.${DOMAIN}`)).toBeUndefined();
    expect(parsePreviewHost(DOMAIN, `a-pport.${DOMAIN}`)).toBeUndefined();
    expect(parsePreviewHost(DOMAIN, `-p3000.${DOMAIN}`)).toBeUndefined();
    expect(
      parsePreviewHost(DOMAIN, `a-p3000.other.example.com`),
    ).toBeUndefined();
    expect(
      parsePreviewHost(DOMAIN, `a-p3000.${DOMAIN}.evil.com`),
    ).toBeUndefined();
    expect(parsePreviewHost(DOMAIN, undefined)).toBeUndefined();
  });
});

describe("preview server", () => {
  it("relays a request by host name and passes the response through", async () => {
    const seen: Array<{
      method?: string;
      target?: string;
      port?: number;
      headers?: HttpProxyHeader[];
      body?: string;
    }> = [];
    const h2 = fakeRunner({
      health: () => ({ sandboxId: "sandbox-one", setupComplete: true }),
      httpProxy: async function* (requests: AsyncIterable<HttpProxyRequest>) {
        let head: HttpProxyRequestHead | undefined;
        const chunks: Uint8Array[] = [];
        for await (const message of requests) {
          if (message.part.case === "head") {
            head = message.part.value;
          } else if (message.part.case === "body") {
            chunks.push(message.part.value);
          }
        }
        if (head !== undefined) {
          seen.push({
            method: head.method,
            target: head.target,
            port: head.port,
            headers: head.headers,
            body: Buffer.concat(chunks).toString(),
          });
        }
        yield {
          part: {
            case: "head",
            value: {
              status: 201,
              headers: [
                { name: "content-type", value: "text/plain" },
                // The sandbox server's cookies and policy are its own on this
                // origin; both must arrive untouched.
                { name: "set-cookie", value: "a=1" },
                { name: "set-cookie", value: "b=2" },
                {
                  name: "content-security-policy",
                  value: "default-src 'none'",
                },
              ],
            },
          },
        };
        yield { part: { case: "body", value: new Uint8Array([104, 105]) } };
      },
    });
    const hits: string[] = [];
    const tunnel = new TunnelServer({
      port: 0,
      tokens: () => [REGISTRATION_TOKEN],
    });
    await tunnel.listen();
    const server = new PreviewServer({
      domain: DOMAIN,
      port: 0,
      bind: "127.0.0.1",
      gateway: tunnel,
      onPreviewHit: (sandboxId) => hits.push(sandboxId),
    });
    await server.listen();
    try {
      const { stream } = await openTunnel(
        tunnel.port(),
        "sandbox-one",
        REGISTRATION_TOKEN,
      );
      h2.emit("connection", stream);
      await tunnel.waitFor("sandbox-one", 5_000);

      const answer = await request(server.port(), HOST, "/echo?say=hi", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          // The preview's cookies are its own; they ride like any header.
          cookie: "app=1",
        },
        body: "ping",
      });
      expect(answer.status).toBe(201);
      expect(answer.headers["content-type"]).toBe("text/plain");
      expect(answer.body).toBe("hi");
      expect(answer.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
      expect(answer.headers["content-security-policy"]).toBe(
        "default-src 'none'",
      );

      const relayed = seen[0] as {
        method?: string;
        target?: string;
        port?: number;
        headers?: Array<{ name: string; value: string }>;
        body?: string;
      };
      expect(relayed.method).toBe("POST");
      expect(relayed.target).toBe("/echo?say=hi");
      expect(relayed.port).toBe(3000);
      expect(relayed.body).toBe("ping");
      const forwarded = (relayed.headers ?? []).map((header) => [
        header.name.toLowerCase(),
        header.value,
      ]);
      expect(forwarded).toContainEqual(["content-type", "text/plain"]);
      expect(forwarded).toContainEqual(["cookie", "app=1"]);
      // The browser's connection to the control plane is not the sandbox's.
      expect(forwarded.map(([name]) => name)).not.toContain("host");
      expect(hits).toEqual(["sandbox-one"]);

      // A host the domain does not own is an unknown host, not a dial.
      const foreign = await request(server.port(), "other.example.com", "/");
      expect(foreign.status).toBe(404);
      expect(hits).toEqual(["sandbox-one"]);

      // A load balancer can health-check the port.
      const health = await request(server.port(), HOST, "/healthz");
      expect(health.status).toBe(200);
    } finally {
      await server.close();
      await tunnel.close();
      h2.close();
    }
  });

  it("answers 503 when the sandbox has no runner and 502 when it fails", async () => {
    const h2 = fakeRunner({
      health: () => ({ sandboxId: "sandbox-two", setupComplete: true }),
      httpProxy: async function* () {
        yield { part: { case: "body", value: new Uint8Array() } };
      },
    });
    const tunnel = new TunnelServer({
      port: 0,
      tokens: () => [REGISTRATION_TOKEN],
    });
    await tunnel.listen();
    const server = new PreviewServer({
      domain: DOMAIN,
      port: 0,
      bind: "127.0.0.1",
      gateway: tunnel,
    });
    await server.listen();
    try {
      // No runner registered for sandbox-one: the wake hint, not a hang.
      const asleep = await request(server.port(), HOST, "/");
      expect(asleep.status).toBe(503);
      expect(asleep.body).toContain("wake");

      // A runner that violates the protocol (body before head) surfaces 502.
      const { stream } = await openTunnel(
        tunnel.port(),
        "sandbox-one",
        REGISTRATION_TOKEN,
      );
      h2.emit("connection", stream);
      await tunnel.waitFor("sandbox-one", 5_000);
      const broken = await request(server.port(), HOST, "/");
      expect(broken.status).toBe(502);
      expect(broken.body).toContain("before the head");
    } finally {
      await server.close();
      await tunnel.close();
      h2.close();
    }
  });

  it("closes while a response is still streaming", async () => {
    // A relay that has sent its head and then stalls. Closing the listener
    // must not wait for a sandbox server to finish a response the browser is
    // no longer there to read.
    const gateway: PreviewGateway = {
      waitFor: async () =>
        ({
          httpProxy: () =>
            (async function* () {
              yield {
                part: { case: "head", value: { status: 200, headers: [] } },
              };
              // One chunk, so the browser sees the response and the relay is
              // provably mid-stream; then the sandbox stalls.
              yield { part: { case: "body", value: new Uint8Array([104]) } };
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 30_000).unref();
              });
            })(),
        }) as unknown as RunnerClient,
    };
    const server = new PreviewServer({
      domain: DOMAIN,
      port: 0,
      bind: "127.0.0.1",
      gateway,
    });
    await server.listen();
    const streaming = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port(),
        path: "/stream",
        headers: { host: HOST },
      },
      (response) => {
        response.on("data", () => {});
        response.on("error", () => {});
      },
    );
    streaming.on("error", () => {});
    streaming.end();
    try {
      // Wait for the head, so the relay is provably mid-stream before close.
      await new Promise<void>((resolve) => {
        streaming.once("response", () => resolve());
      });
      const outcome = await Promise.race([
        server.close().then(() => "closed"),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("pending"), 2_000).unref();
        }),
      ]);
      expect(outcome).toBe("closed");
    } finally {
      streaming.destroy();
      await server.close();
    }
  });
});

interface Reply {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

/**
 * One HTTP request naming a host the server never resolves. fetch refuses a
 * custom Host header (it is a forbidden header name), so this is plain http.
 */
function request(
  port: number,
  host: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: init.method ?? "GET",
        path,
        headers: { host, ...(init.headers ?? {}) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as Record<string, string | string[]>,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (init.body !== undefined) {
      outgoing.end(init.body);
    } else {
      outgoing.end();
    }
  });
}

/** The fake runner: an HTTP/2 connect server fed the WebSocket stream. */
function fakeRunner(
  routes: Partial<ServiceImpl<typeof RunnerService>>,
): http2.Http2Server {
  return http2.createServer(
    connectNodeAdapter({
      routes: (router) => router.service(RunnerService, routes),
    }),
  );
}

function openTunnel(
  port: number,
  sandboxId: string,
  token: string,
): Promise<{ stream?: Duplex }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, {
      headers: {
        authorization: `Bearer ${token}`,
        [SANDBOX_ID_HEADER]: sandboxId,
      },
    });
    ws.once("error", reject);
    ws.once("open", () => resolve({ stream: createWebSocketStream(ws) }));
  });
}
