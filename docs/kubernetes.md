# Kubernetes backend

This backend runs sessions in Kubernetes pods managed by
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox). It is
pinned to **v1.0.2** and the `agents.x-k8s.io/v1beta1` and
`extensions.agents.x-k8s.io/v1beta1` APIs. Do not assume these manifests work
with another release.

Installation is [`installations-kas.md`](installations-kas.md). This page
covers how the pieces work, the isolation model, the tunnel, and local
development.

## Security model

Each sandbox pod has two containers:

- **runner** — runs as UID 1000, serves the file, shell, and subprocess RPCs,
  and holds the session's tools. It has `allowPrivilegeEscalation: true` and a
  small set of capabilities so apt, dpkg, and sudo can install system packages.
  Seccomp stays `RuntimeDefault`.
- **docker** — a rootless Docker daemon sidecar. The runner's Docker CLI talks
  to it over a shared socket, so sessions can run `docker build` and
  `docker run` without access to the node's Docker daemon.

The pod uses the `runc` runtime by default, which is container isolation, not a
virtual-machine boundary for hostile code. For a stronger boundary, install and
verify a gVisor `RuntimeClass` on every eligible node and add
`runtimeClassName: gvisor` under `podTemplate.spec`. The Docker sidecar has
only been tested under `runc`.

The pod does not mount a service-account token. A NetworkPolicy default-denies
both directions: ingress is empty, and egress allows only the control-plane
tunnel (TCP 8081), DNS (TCP/UDP 53), and HTTP/HTTPS (80 and 443). The broad
80/443 rule reaches cluster and private addresses too, so production clusters
should narrow it to approved CIDRs or use an FQDN-aware network policy.
Connectivity rules are not a sandbox boundary.

The control plane's `dsh-yawn-control-plane` Role is namespace-scoped. It can
manage `sandboxclaims` and read and patch `sandboxes`; it grants nothing
cluster-wide or outside sandbox management.

## Docker inside a sandbox

The `docker` sidecar runs the upstream `docker:29.8.0-dind-rootless` image. It
is a rootless daemon: the process runs as UID 1000 and creates its own user
namespace, so "root" inside containers it starts is UID 1000 on the node.

The sidecar and the runner mount the workspace volume at the same `/workspace`
path, so bind mounts see the session checkout. Files the runner owns appear
root-owned inside a container, and files a container writes as root come back
as UID 1000. A published port is reachable at the pod's `localhost`.

Container images, containers, and volumes live on a 10Gi `emptyDir`, not on the
workspace volume. A hibernated sandbox loses that sidecar storage, so a woken
session keeps its files but pulls images again. This is deliberate: it avoids
the kubelet `fsGroup` ownership pass over every image layer on every pod start.
Raise the `sizeLimit` in the template if sessions build large images.

The sidecar is privileged because rootlesskit needs user and mount namespaces
and nested runc needs a fresh `/proc`. The default seccomp profile, AppArmor,
and masked `/proc` paths refuse those; `privileged: true` is the only
Kubernetes switch that lifts all three. The process stays UID 1000 with an
empty effective capability set, and privileged mode does not give it root on
the node — but it does remove seccomp and AppArmor protection for that
container. The pod no longer satisfies the `baseline` Pod Security Standard; a
namespace that enforces it rejects the pod. To drop the sidecar, delete the
`docker` container and its two `emptyDir` volumes from the template and the
runner's `DOCKER_HOST` entry.

## System packages in a sandbox

The sandbox user has passwordless sudo, so a repository whose setup installs
system packages works without a custom image. The permission stays inside the
runner container, but code in the sandbox can write anywhere in that
container, including over the runner's files. If that is the wrong trade for a
shared cluster, remove the sudoers file in a custom image.

Packages installed by apt do not survive a wake: `/usr` and `/var` come from
the image again when the pod is rebuilt. The repository's `.agents/setup` runs
on the new machine, and downloaded `.deb` files are cached on the workspace
volume at `/workspace/.dsh-yawn/apt-cache`, so they do not need downloading
twice. Packages installed under `$HOME` persist on their own.

## The in-cluster control plane

The Helm chart runs the control-plane image as a single-replica Deployment. Its
home directory is a data volume that holds everything durable: sessions and
storage, the seeded `web` profile, installed plugins, workspace anchors, and
credentials. Deleting the pod loses nothing; deleting the volume loses all of
it.

The pod sets `fsGroup` so UID 1000 can write the volume. The control plane's
credentials file (`/data/.dsh/.credentials.yaml`) must stay owner-only or dsh
refuses to boot, so an init container restores mode `0600` after the volume's
ownership pass and before dsh starts. This is expected and needs no
configuration.

The control plane starts with no sandbox profile, so the Web UI, sessions,
secrets, and workspaces work but the first tool call fails until a profile is
configured. On a chart install, profile defaults come from
`controlPlane.sandboxManager` values, mounted at
`/etc/dsh-yawn/sandbox-settings.yaml`. **Settings → Sandboxes** adds its own
profiles and changes the default and timers without a restart. Profiles defined
in the chart are locked in the Web UI, and a values change rolls the pod.

The control plane uses the `dsh-yawn-control-plane` ServiceAccount token to
manage `sandboxclaims` and `sandboxes` through the chart's Role and
RoleBinding.

**Several pod sizes.** A sandbox's resources come from its warm-pool template,
so a second size means a second `SandboxTemplate` and `SandboxWarmPool` pair.
Copy [`20-sandbox-template.yaml`](../deploy/kubernetes/runner/20-sandbox-template.yaml)
and [`30-warm-pool.yaml`](../deploy/kubernetes/runner/30-warm-pool.yaml) under a
new name, change the resources and volume request, and add both to your
kustomization. Then list a profile for each pool:

```yaml
- id: sandbox-manager
  config:
    defaultProfile: standard
    profiles:
      standard:
        backend: kas
        namespace: dsh-yawn
        warmPool: dsh-yawn-universal
      large:
        backend: kas
        namespace: dsh-yawn
        warmPool: dsh-large
```

**Registration token rotation.** The control plane reads accepted tokens from
`DSH_YAWN_REGISTRATION_TOKEN`, and every runner pod reads the same
`dsh-yawn-registration-token` Secret. To rotate without dropping tunnels, first
add the new token alongside the old one, update the Secret, recycle the warm
pods, then remove the old token from the control plane:

```sh
# 1. Set DSH_YAWN_REGISTRATION_TOKEN on the control-plane Deployment to
#    "new,old" (new first). The control plane accepts every listed token.
# 2. Replace the Secret value with the new token.
kubectl -n dsh-yawn create secret generic dsh-yawn-registration-token \
  --from-literal=token="$(openssl rand -hex 32)" \
  --dry-run=client -o yaml | kubectl apply -f -
# 3. Recycle the warm pods and restart the control plane.
kubectl -n dsh-yawn delete sandbox --all
kubectl -n dsh-yawn rollout restart deployment/dsh-yawn-control-plane
# 4. Set the control plane's DSH_YAWN_REGISTRATION_TOKEN to the new token alone.
```

For a gap-free rotation, do step 4 only after warm runners have recycled and
reconnected.

## Reaching the Web UI

dsh binds to pod loopback and has no user authentication of its own, so the
chart can put oauth2-proxy in front of it. With `oidc.enabled`, the proxy
terminates the OIDC flow and forwards over pod-local loopback. The chart stops
at the proxy's pod port, 4180; exposing that port is up to your cluster.

A ClusterIP Service plus an ingress-nginx Ingress looks like this:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: dsh-yawn-control-plane
  namespace: dsh-yawn
spec:
  selector:
    app.kubernetes.io/name: dsh-yawn-control-plane
  ports:
    - name: http
      port: 80
      targetPort: 4180
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: dsh-yawn-control-plane
  namespace: dsh-yawn
  annotations:
    # The Web UI holds WebSockets open at /api/events.* and can carry large
    # attachments; nginx's defaults are too small.
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-body-size: 300m
spec:
  ingressClassName: nginx
  rules:
    - host: dsh.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: dsh-yawn-control-plane
                port:
                  name: http
          # Only for runners outside the cluster. Omit it when every runner is
          # in-cluster. See "Connectivity and isolation".
          - path: /tunnel
            pathType: Exact
            backend:
              service:
                name: dsh-yawn-control-plane-tunnel
                port:
                  name: tunnel
  tls:
    - hosts: [dsh.example.com]
      secretName: dsh-yawn-tls
```

The chart's oauth2-proxy patch also sets `--trusted-host` for the external
hostname, because dsh rejects `/api` requests whose `Host` header is neither
loopback nor explicitly trusted. If you change the hostname, change it there
too.

Behind the proxy, open `https://dsh.example.com/launch-token`. The patch sets
`DSH_YAWN_CONTROL_PLANE_LAUNCH_TOKEN_ROUTE=1`, which mounts a route that
redirects the browser to dsh's tokenized URL, so users never copy a token from
the logs. The route is not a sign-in: it hands the token to anyone who can
reach port 3000, which in this pod is only the proxy or your port-forward. Do
not enable it when port 3000 is exposed some other way. Without the route, take
the token from the log:

```sh
kubectl -n dsh-yawn logs deploy/dsh-yawn-control-plane | grep 'dsh web:'
# open https://dsh.example.com/?token=…
```

A port-forward always works, with or without the proxy:

```sh
kubectl -n dsh-yawn port-forward deploy/dsh-yawn-control-plane 3000:3000
# open http://localhost:3000/launch-token
```

The browser cookie lasts 30 days and is signed with a secret on the data
volume, so a control-plane restart does not sign users out. The proxy
authenticates users but does not isolate them from each other. Everyone the
issuer admits shares the same sessions, secrets, and sandboxes. Restrict `OAUTH2_PROXY_EMAIL_DOMAINS` accordingly.

## Connectivity and isolation

A sandbox has no Service and accepts no ingress. The runner opens a WebSocket
to the `dsh-yawn-control-plane-tunnel` Service on port 8081
(`ws://dsh-yawn-control-plane-tunnel.dsh-yawn.svc.cluster.local:8081/tunnel`),
registers with the registration token, and serves RPCs over that connection.
The claim's `status.sandbox.name` identifies the sandbox; the runner presents
the same name during registration, and the control plane verifies it.

Inside the cluster the tunnel is plaintext; control-plane authenticity rests
on the cluster network being trusted. Runners outside the cluster
should use `wss://` through the Ingress that fronts the Web UI. The `/tunnel`
path must be `Exact` and must bypass oauth2-proxy: the registration token is
the tunnel's authentication. `GET /healthz` on the tunnel port answers 200 for
load-balancer health checks.

### Exposing the runner tunnel beyond the cluster

The tunnel is a WebSocket that, once upgraded, carries HTTP/2-with-reversed-
roles. An HTTPS proxy or Ingress can terminate TLS in front of it using the
same certificate as the Web UI. Two shapes work:

- An HTTP Ingress with a WebSocket-capable path rule; `/tunnel` goes straight
  to the tunnel Service under the UI certificate. This is the simplest option
  when the ingress controller supports WebSocket upgrades.
- An L4 stream proxy (nginx `stream`, HAProxy) or a Gateway API `TLSRoute` in
  passthrough mode, forwarding to the tunnel Service on 8081. Use this when the
  endpoint must not share the UI's listener.

A proxy that terminates the WebSocket and buffers or inspects it, such as an
HTTP-aware CDN, does not work. Use a DNS-only record when you terminate TLS
yourself. Keep the ingress read and send timeouts above the Web UI's 3600
seconds; a cut tunnel costs one redial and the RPC in flight.

An nginx `stream` proxy:

```nginx
stream {
  server {
    listen 8443 ssl;
    ssl_certificate     /etc/nginx/tls/tls.crt;
    ssl_certificate_key /etc/nginx/tls/tls.key;
    proxy_pass dsh-yawn-control-plane-tunnel.dsh-yawn.svc.cluster.local:8081;
  }
}
```

Then set the profile's `controlPlaneUrl` to the name agents dial, for example
`tls://dsh.example.com:8443`. The registration token still authenticates every
runner; exposure changes reachability, not trust.

## Local development

Build both images, start a `kind` cluster with the sandbox pool, and run the
smoke test:

```sh
docker buildx bake dev control-plane-dev --load

scripts/kas/dev-cluster.sh \
  --runner-image dsh-yawn-runner:dev \
  --control-plane-image dsh-yawn-control-plane:dev \
  --load-runner-image

scripts/kas/smoke-test.sh --namespace dsh-yawn
scripts/kas/teardown.sh
```

Omit `--control-plane-image` to run dsh outside the cluster and pass
`--control-plane-url ws://<host>:8081/tunnel` instead. The script generates a
registration token, or reads one from `--registration-token-file`, and stores
it in the `dsh-yawn-registration-token` Secret. Use `--name NAME` on both
cluster scripts to choose a different kind cluster name. For the full transport
and lifecycle test, see
[`e2e-testing.md`](e2e-testing.md#kubernetes-transport-and-lifecycle-test).

The smoke test verifies warm-pod adoption, suspend/resume persistence, workspace
and home-directory survival, the rootless Docker sidecar, and expiry. Hibernation
suspends the Sandbox (there is no `spec.paused`); running it again recreates the
pod around the surviving PVC. Expiry deletes the claim and its PVC. A closed
tunnel does not return a sandbox to the warm pool: an adopted pod is not
recycled, and the pool creates a new one after adoption.

The PVC carries `/workspace`: the repository checkout, `/workspace/home`, the
artifacts folder, and the apt cache. `/tmp`, running processes, installed apt
packages, and everything else in the container are gone after a wake; the
runner runs `.agents/setup` again on the new machine. The checked-in template
requests 6Gi and can hold up to 2GiB of `.deb` files. Size the claim for the
toolchains a session installs.

## OpenTelemetry

The control plane records claim time, resume time, lifecycle changes, and
command time through dsh's OpenTelemetry setup.

To export from runners, add standard `OTEL_EXPORTER_OTLP_*`,
`OTEL_TRACES_EXPORTER`, or `OTEL_METRICS_EXPORTER` variables to its container
in the template. Their endpoint must also be allowed by the egress policy. With
no exporter variables set, the runner does not contact a collector.
