import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { parsePreviewHost } from "./preview.js";
import { PreviewRelay, type PreviewGateway } from "./preview-relay.js";

/** Answers 200 so an HTTP load balancer can health-check the port. */
export const PREVIEW_HEALTH_PATH = "/healthz";

export interface PreviewServerOptions {
  /** The bare domain previews live under, e.g. `sandbox.example.com`. */
  domain: string;
  port: number;
  bind?: string;
  gateway: PreviewGateway;
  log?: (message: string) => void;
  /**
   * Called for each relayed preview request. Preview traffic is a user
   * looking at the sandbox, so it counts as session activity.
   */
  onPreviewHit?: (sandboxId: string) => void;
}

/**
 * Serves previews by host name: `<sandboxId>-p<port>.<domain>` routes to that
 * sandbox's loopback port, everything else is an unknown host.
 *
 * This is a listener of its own, like the tunnel listener, for two reasons.
 * The dsh web server matches routes by path only, so a subdomain request with
 * path `/` would land in the SPA fallback and a preview route can never see
 * it. And it must not be the tunnel port: that port is reachable from
 * sandboxes by design, and a preview route there is a cross-sandbox route on
 * a sandbox-reachable port. The listener is plain HTTP, like the tunnel;
 * TLS and authentication come from whatever fronts it, exactly as for the Web
 * UI — see docs/kubernetes.md.
 */
export class PreviewServer {
  private readonly server: Server;
  private readonly relay: PreviewRelay;

  constructor(private readonly options: PreviewServerOptions) {
    this.relay = new PreviewRelay({
      gateway: options.gateway,
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(options.onPreviewHit === undefined
        ? {}
        : { onPreviewHit: options.onPreviewHit }),
    });
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.url === PREVIEW_HEALTH_PATH) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok\n");
      return;
    }
    const target = parsePreviewHost(this.options.domain, request.headers.host);
    if (target === undefined) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found\n");
      return;
    }
    await this.relay.handle(request, response, target);
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.bind, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  /** The bound port; useful when constructed with port 0 in tests. */
  port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("preview server is not listening");
    }
    return address.port;
  }

  async close(): Promise<void> {
    // Drop connections first, the order TunnelServer.close() uses: a relay
    // still streaming would otherwise hold the close callback open until the
    // sandbox server finished a response nobody is left to read. A server
    // that never listened closes here too, which is why the callback's error
    // is ignored.
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
