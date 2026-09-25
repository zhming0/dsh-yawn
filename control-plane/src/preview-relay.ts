import type { IncomingMessage, ServerResponse } from "node:http";

import type { PreviewTarget } from "./preview.js";
import type { HttpProxyRequestMessage, RunnerClient } from "./runner-client.js";

/**
 * The preview relay: one browser request in, one sandbox loopback request out,
 * multiplexed onto the sandbox's registered tunnel. It owns transport only.
 * Addressing is the caller's — the preview listener parses the host name —
 * and so is the security posture: a preview is served on its own origin, so
 * the sandbox server's headers and cookies pass through untouched and the
 * isolation is structural rather than something this relay enforces.
 */

/** How the relay reaches a runner: whatever holds the tunnel registrations. */
export interface PreviewGateway {
  waitFor(sandboxId: string, timeoutMs: number): Promise<RunnerClient>;
}

export interface PreviewRelayOptions {
  gateway: PreviewGateway;
  log?: (message: string) => void;
  /**
   * Cookie names stripped from the request before it enters the sandbox.
   * The preview's own cookies pass through untouched; what is named here is
   * the fronting proxy's session, which authenticates the person, not the
   * app, and must not become a credential sandbox code can read.
   */
  authCookieNames?: string[];
  /**
   * Called for each relayed preview request. Preview traffic is a user
   * looking at the sandbox, so it counts as session activity.
   */
  onPreviewHit?: (sandboxId: string) => void;
}

/**
 * How long a preview request waits for the runner to register. A running
 * sandbox is registered; anything else answers 503 rather than hanging the
 * browser open for a wake that is not coming.
 */
const RUNNER_WAIT_MS = 1_000;

/**
 * Headers that describe the browser's connection to the control plane, not
 * the request; forwarding them would describe a hop the sandbox never sees.
 * The runner states lengths itself once the body is re-chunked.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "keep-idle",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class PreviewRelay {
  private readonly log: (message: string) => void;
  private readonly authCookieNames: readonly string[];

  constructor(private readonly options: PreviewRelayOptions) {
    this.log = options.log ?? (() => {});
    this.authCookieNames = options.authCookieNames ?? [];
  }

  /**
   * Relay one browser request into the sandbox over its registered tunnel.
   * The target names the sandbox and loopback port; the runner that answers
   * is the one registered under that ID, so nothing is dialed, only
   * multiplexed.
   */
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    target: PreviewTarget,
  ): Promise<void> {
    this.options.onPreviewHit?.(target.sandboxId);
    let client: RunnerClient;
    try {
      client = await this.options.gateway.waitFor(
        target.sandboxId,
        RUNNER_WAIT_MS,
      );
    } catch {
      reply(
        response,
        503,
        "sandbox is not running; send a prompt in its session to wake it",
      );
      return;
    }
    // A browser that gives up must tear down the relayed request too, or the
    // sandbox server keeps serving a connection nobody reads.
    const abort = new AbortController();
    request.on("aborted", () => abort.abort());
    response.on("close", () => {
      if (!response.writableEnded) {
        abort.abort();
      }
    });
    try {
      const messages = client.httpProxy(
        previewMessages(request, target, this.authCookieNames),
        {
          signal: abort.signal,
        },
      );
      let headSeen = false;
      for await (const message of messages) {
        if (message.part.case === "head") {
          headSeen = true;
          response.writeHead(
            message.part.value.status,
            responseHeaders(message.part.value.headers),
          );
        } else if (message.part.case === "body") {
          if (!headSeen) {
            // Protocol violation: the status line and headers must come
            // before any body bytes the browser could read.
            throw new Error("runner sent a response body before the head");
          }
          if (request.method === "HEAD") {
            // A HEAD response carries headers only; Node would drop the
            // bytes, so the chunks are consumed and discarded here.
            continue;
          }
          // Await the write so a slow browser applies backpressure to the
          // sandbox server instead of buffering its whole response.
          await new Promise<void>((resolve, reject) => {
            // Node's write callback receives null, not undefined, on success.
            response.write(message.part.value, (error) =>
              error ? reject(error) : resolve(),
            );
          });
        }
      }
      response.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`preview: ${target.sandboxId}: ${message}`);
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
      } else {
        reply(response, 502, `sandbox did not answer: ${message}`);
      }
    } finally {
      // The relay is done; releasing the RPC lets both sides clean up even
      // when the browser left the connection half-open.
      abort.abort();
    }
  }
}

/**
 * Group repeated headers back into the shapes Node understands. `set-cookie`
 * stays an array so each cookie keeps its own header; the cookies belong to
 * the preview's origin, so they pass through like every other header.
 */
function responseHeaders(
  headers: Array<{ name: string; value: string }>,
): Record<string, string | string[]> {
  const grouped: Record<string, string | string[]> = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    const existing = grouped[name];
    if (existing === undefined) {
      grouped[name] = header.value;
    } else if (Array.isArray(existing)) {
      existing.push(header.value);
    } else {
      grouped[name] = [existing, header.value];
    }
  }
  return grouped;
}

/** Translate one browser request into the proxy RPC's message stream. */
async function* previewMessages(
  request: IncomingMessage,
  target: PreviewTarget,
  authCookieNames: readonly string[],
): AsyncGenerator<HttpProxyRequestMessage> {
  const headers: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(request.headers)) {
    const header = name.toLowerCase();
    if (HOP_BY_HOP.has(header)) {
      continue;
    }
    if (header === "cookie" && authCookieNames.length > 0) {
      // The fronting proxy's session cookie authenticates the viewer, not
      // the app, and the app inside the sandbox is untrusted code: drop the
      // named cookies and keep the app's own.
      const entries = Array.isArray(value)
        ? value
        : value === undefined
          ? []
          : [value];
      for (const entry of entries) {
        const kept = withoutAuthCookies(entry, authCookieNames);
        if (kept !== "") {
          headers.push({ name: header, value: kept });
        }
      }
      continue;
    }
    // Node folds repeatable headers into comma-joined strings except
    // set-cookie, which stays an array so each cookie keeps its own header.
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.push({ name: header, value: entry });
      }
    } else if (value !== undefined) {
      headers.push({ name: header, value });
    }
  }
  yield {
    part: {
      case: "head",
      value: {
        method: request.method ?? "GET",
        target: request.url ?? "/",
        port: target.port,
        headers,
      },
    },
  };
  // IncomingMessage's async iterator is typed as yielding any; the chunks of
  // an HTTP request body are buffers.
  const body = request as AsyncIterable<Buffer>;
  for await (const chunk of body) {
    yield { part: { case: "body", value: chunk } };
  }
}

/**
 * Remove the named cookies from one Cookie header value. A large proxy
 * session is split into `<name>_1`, `<name>_2`, … chunks, so a trailing
 * `_<digits>` on a named cookie goes too. An empty result means the header
 * carried nothing worth forwarding.
 */
function withoutAuthCookies(value: string, names: readonly string[]): string {
  const dropped = names.map((name) => name.toLowerCase());
  const kept = value.split(";").filter((pair) => {
    const eq = pair.indexOf("=");
    const name = (eq === -1 ? pair : pair.slice(0, eq)).trim().toLowerCase();
    if (dropped.includes(name)) {
      return false;
    }
    const chunk = name.match(/^(.*)_(\d+)$/);
    return !(chunk !== null && dropped.includes(chunk[1] ?? ""));
  });
  return kept.join("; ").trim();
}

function reply(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(`${message}\n`);
}
