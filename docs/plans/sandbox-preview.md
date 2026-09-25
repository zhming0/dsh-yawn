# Sandbox previews on their own origin

## Problem

A session can start an HTTP server inside its sandbox — a dev server, a docs
build, a mock API — but nothing outside the sandbox can reach it. Sandboxes
accept no ingress at all (that is a design rule, not a gap), so the only way
to see the server is to read screenshots. The live feedback loop a developer
expects — watch it render, click through it, iterate — is impossible.

## Decision

Serve each preview on **its own origin**: one subdomain per sandbox and port,
`https://<sandboxId>-p<port>.<preview-domain>/`, forwarded to the sandbox over
the runner's existing tunnel by the `HttpProxy` RPC. A real origin is the
whole point — it is what a dev server expects — and it is why the first
implementation, which served previews under a `/preview/...` path prefix on
the Web UI's own origin, was replaced rather than kept:

- A path-prefixed proxy breaks any page that links absolute paths
  (`/app.js`), which is what Vite, Next, and most frameworks emit.
- Sharing the UI's origin forces a defensive posture (CSP `sandbox`
  injection, `Set-Cookie` stripping, no storage, no service workers) that
  un-does half the web platform. On its own origin, isolation is structural
  and none of that machinery is needed.

The label is a single DNS name segment — `<sandboxId>-p<port>` — so one
wildcard certificate covers every preview of an install. The `-p` marker
makes the trailing number unambiguous, because sandbox ids already contain
hyphens and digits. This is the same shape the hosted agents use (Amp's
`t-<thread>-p<port>.onamp.dev`, Gitpod's port-leading hosts).

Decided against, in discussion:

- **Path-prefixed previews as a second mode.** Two addressing modes mean two
  security postures and a URL whose meaning depends on configuration. The
  path mode's compatibility advantage (no operator prerequisites) does not
  outweigh serving broken previews for most real apps; an install without a
  preview domain gets a Sandbox tab row that says what is missing instead.
- **Mounting the route on the Web UI's server.** dsh's web server matches
  routes by path only (exact, then longest prefix, then one fallback seat),
  so a subdomain request with path `/` lands in the SPA fallback. A host
  needs its own listener.
- **Mounting the route on the tunnel listener.** That port is reachable from
  sandboxes by design; a preview route there is a cross-sandbox route on a
  sandbox-reachable port.
- **A token or capability URL.** One control plane is one trust domain, so a
  per-sandbox token gates nothing while inviting the URL to be treated as
  shareable. Previews sit behind the same proxy as the UI.
- **A second runner→host channel for proxied bytes.** One runner-initiated
  connection carries everything; HTTP/2 multiplexes the preview streams.
- **An in-app preview tab.** The first cut framed previews in a Web Preview
  conversation tab, and dsh 0.1.7 later shipped its own sidebar Browser.
  Both are a browser inside the browser: the user is already in a real one,
  a top-level tab has the full address bar, devtools, and extension set, and
  it is the path where the authenticating proxy's OAuth roundtrip cannot
  break. The tab was removed once the model could hand the user a clickable
  URL and the Sandbox tab linked every detected port; dsh's sidebar Browser
  stays disabled, so chat links open in the user's browser.

## How it works

**Transport (already landed).** `rpc HttpProxy(stream HttpProxyRequest)
returns (stream HttpProxyResponse)` in `proto/dsh/yawn/v1/runner.proto`. Each
direction sends one head message (method, request target, loopback port,
headers), then body chunks; both sides drop hop-by-hop headers. The runner
dials `127.0.0.1:<port>` — servers started by session commands share the
runner's network namespace, so loopback is the sandbox and nothing else. The
runner never learns the public URL. `SandboxStatusResponse.listening_ports`
reports the sandbox's listening TCP sockets (the runner's own health listener
excluded) so the UI can offer real ports.

**The preview listener.** A third listener in the control plane, shaped like
`TunnelServer`: it parses the request's `Host` against the configured preview
domain, maps `<sandboxId>-p<port>` to a sandbox and port, and delegates to a
`PreviewRelay`; `GET /healthz` answers 200 for load balancers; anything else
is 404. It binds like the tunnel does so a Service can front it, and it is
not the tunnel port (see above). The relay keeps the transport behavior —
request buffered up to 32 MiB, response streamed in 64 KiB chunks, abort
propagated, runner-less sandbox answered 503 with a hint to wake it — but on
its own origin it neither injects a CSP nor touches cookies in either
direction: the app's cookies belong to the preview's origin, not the UI's.

**Host headers.** The runner keeps dialing the loopback address, so the
sandbox server sees `Host: 127.0.0.1:<port>`. Dev servers that validate Host
(Vite's `allowedHosts`, Django's `ALLOWED_HOSTS`) therefore pass
unconfigured. The trade: an app that builds absolute URLs from its Host
header sees the loopback origin, not the public one. That is accepted for
now; the fix is a `PUBLIC_URL`-style convention that belongs with declared
services (below), not with addressing.

**Configuration.** `preview: { domain, port }` in the control plane settings,
mirroring `tunnel: { port, bind }`. When the domain is unset the listener
does not start and the Sandbox tab explains what is missing and where to
configure it — the row never silently vanishes.

**Status and the Sandbox tab.** The sandbox status carries the preview
domain and each sandbox's host (the `<sandboxId>-p<port>` origin with the
default port) beside the listening ports. The Sandbox tab turns both into
links that open in the user's browser, and the sandbox environment prompt
tells the model the address pattern once its sandbox exists, so it can start
a server, hand the user the URL, and the user's click opens a real tab.
Preview traffic counts as session activity, so a sandbox receiving preview
requests does not hibernate under its viewer, and opening a preview wakes a
hibernated one.

**Kubernetes and auth.** The chart gains the container port, a `ClusterIP`
Service (a sibling of the tunnel Service), and oauth2-proxy configuration to
authenticate the preview domain with its own cookie. Operator setup, which
the chart documents but does not own: a wildcard DNS record, a wildcard
certificate (cert-manager DNS-01), and an Ingress rule for
`*.sandbox.<domain>` routed to the preview Service with the same long read
and send timeouts the UI needs. That Ingress also serves the UI, on the same
scheme and default port: a preview URL carries no port, so the browser asks
for whatever the UI's own page used. Previews open in the user's own browser,
as top-level pages: that is the most robust path through the authenticating
proxy (a first-party OAuth roundtrip on every browser, no framed third-party
cookie at all), which is also why dsh's in-app sidebar Browser is left
disabled. An install that wants in-app tabs may enable it; previews are its
own origins either way. Putting previews on a registrable domain separate
from the UI's is recommended: it keeps the proxy's cookies off the UI's site
entirely and removes same-site request surfaces. The sandbox
NetworkPolicy needs no change — egress to the control plane pod is allowed
on the tunnel port only, so sandboxes cannot reach the preview listener
directly.

**The proxy's cookie must never reach a sandbox.** Authenticating the
wildcard host requires a cookie scoped to cover every preview host, so the
browser attaches it to each preview request — and the relay passes cookies
through, which is correct for the previewed app's own cookies and wrong for
the proxy's: the app inside the sandbox is untrusted code, and a session
credential it can read off the wire is one it can replay. oauth2-proxy does
not strip its cookie before forwarding upstream (its issues #388 and #1993
ask for exactly that), so the exposure change closes this on our side:

- The listener drops configured auth-cookie names from the request before it
  enters the tunnel — `preview.authCookieNames`, which the chart fills with
  the cookie name it gives oauth2-proxy. The app's own cookies are untouched.
- The preview cookie's domain stays disjoint from the UI's, so a cookie that
  does leak somewhere is valid against previews only, never the control
  plane's UI, and the UI's cookie is never attached to a preview request in
  the first place.

Both rules together are what make "the relay forwards cookies" safe: what
arrives at the sandbox is the app's own session and nothing else.

## Limits

- No WebSocket upgrades through the preview yet, so HMR does not connect.
  Both ends already speak WebSocket; the extension is its own change.
- Requests are buffered up to 32 MiB, like every other host↔sandbox
  transfer.
- Previews need operator prerequisites (wildcard DNS and certificate). An
  install without them has no previews, by the one-mode decision above.
- The app sees a loopback Host, not its public hostname.

## Steps

1. **Preview feature** (on top of the transport; landed in two PRs): the
   control-plane half — the preview listener with host parsing,
   `preview: { domain, port }` settings, the relay on the listener,
   `previewDomain` + `previewHost` facts in the status, the preview surfaces
   (a third cut replaced the first Web Preview tab with Sandbox-tab links
   and the prompt sentence), and tests, including a Docker smoke through the
   real listener. Then the exposure
   half — the chart's port/Service/proxy values and the operator
   documentation: wildcard DNS and certificates, the Ingress rule, the
   auth-cookie rules above (`preview.authCookieNames` wired to the proxy's
   cookie name, preview and UI cookie domains disjoint), and the
   recommendation to keep previews on a registrable domain separate from the
   UI's. Browser acceptance needs neither: `<sandbox>-p<port>.localhost`
   resolves to loopback in Chrome and Firefox, with a browser-side host
   mapping for the listener's port (`docs/e2e-testing.md`).
2. **WebSocket upgrades through `HttpProxy`** so dev-server HMR connects
   (`wss://` terminated at the Ingress like every other preview byte).
3. **Declared services** (optional, later): a per-repository manifest of
   long-running services the control plane supervises across wakes — the
   successor to `setsid`-started servers, which every wake kills — with
   `PORT`/`PUBLIC_URL` injection for apps that need their public origin.
