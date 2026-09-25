/**
 * Preview addressing: one sandbox's loopback servers, each at its own origin.
 * The host name carries everything the control plane needs:
 *
 *   <sandboxId>-p<port>.<preview domain>
 *
 * One DNS label per sandbox and port, so a single wildcard certificate covers
 * every preview of an install, and each preview is its own origin — storage,
 * cookies, and service workers work, and nothing the page does can reach the
 * Web UI's origin around the frame. The `-p` marker makes the trailing number
 * unambiguous, because sandbox ids already contain hyphens and digits. The
 * runner never learns any of this; it dials `127.0.0.1:<port>`.
 *
 * Design details: docs/plans/sandbox-preview.md.
 */

/** Where the preview listener answers; see docs/kubernetes.md for the Ingress. */
export const DEFAULT_PREVIEW_PORT = 8082;

/**
 * The port the status offers before the runner reports real ones. A
 * placeholder the Preview tab swaps for a detected port.
 */
export const PLACEHOLDER_PREVIEW_PORT = 3000;

export interface PreviewTarget {
  sandboxId: string;
  port: number;
}

/**
 * The DNS label naming one sandbox and port. Sandbox ids are already DNS
 * labels on every backend (Kubernetes object names, Docker hex ids); anything
 * that is not lowercases rather than failing, so a preview still resolves.
 */
export function previewLabel(sandboxId: string, port: number | string): string {
  return `${sanitizeLabel(sandboxId)}-p${port}`;
}

/**
 * The host name a browser uses to reach one port inside one sandbox. The
 * domain is the operator's `preview.domain`, a bare host with no scheme.
 */
export function previewHost(domain: string, sandboxId: string, port: number) {
  return `${previewLabel(sandboxId, port)}.${domain}`;
}

/**
 * Read a preview host name back into its sandbox and port. Anything that is
 * not a label under the configured domain — a different host, a malformed
 * port, a foreign subdomain — is an unknown host, never a guess.
 */
export function parsePreviewHost(
  domain: string,
  host: string | undefined,
): PreviewTarget | undefined {
  if (host === undefined) {
    return undefined;
  }
  // HTTP allows either case, and `host:port` is how a browser names a host
  // it reached on a non-default port.
  const lowered = host.toLowerCase();
  const withoutPort = lowered.replace(/:[0-9]+$/, "");
  const suffix = `.${domain.toLowerCase()}`;
  if (!withoutPort.endsWith(suffix)) {
    return undefined;
  }
  const label = withoutPort.slice(0, -suffix.length);
  if (label === "") {
    return undefined;
  }
  // Split at the last `-p`: the sandbox id may contain the same pattern, but
  // only the final one is the port marker.
  const at = label.lastIndexOf("-p");
  if (at <= 0) {
    return undefined;
  }
  const sandboxId = label.slice(0, at);
  const portText = label.slice(at + 2);
  if (!/^\d{1,5}$/.test(portText)) {
    return undefined;
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  return { sandboxId, port };
}

function sanitizeLabel(sandboxId: string): string {
  const lowered = sandboxId.toLowerCase();
  return /^[a-z0-9-]+$/.test(lowered)
    ? lowered
    : lowered.replace(/[^a-z0-9-]/g, "-");
}
