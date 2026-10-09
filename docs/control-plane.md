# Control plane

The control plane is the dsh process, its data volume, and the runner tunnel.
It runs on Kubernetes through the Helm chart, or on a VM with Docker. Sandboxes
run elsewhere; see the [installation index](installations.md).

- [Kubernetes](#kubernetes)
  - [Prerequisites](#prerequisites)
  - [Install](#install)
  - [Expose the Web UI](#expose-the-web-ui)
  - [Verify](#verify)
  - [Upgrade](#upgrade)
- [VM or other Docker host](#vm-or-other-docker-host)
  - [Run the container](#run-the-container)
  - [Authentication](#authentication)
  - [Upgrade](#upgrade-1)

## Kubernetes

The `dsh-yawn` Helm chart installs the control plane and the Kubernetes
permissions it needs to manage sandboxes.

### Prerequisites

- A Kubernetes cluster you administer, with `kubectl` 1.27 or later.
- `helm` 3.8 or later.
- A default StorageClass, or a storage class name for the control plane's data
  volume.
- An OIDC identity provider. dsh has no user authentication of its own, so the
  distribution puts oauth2-proxy in front of it and you supply the client.
  Skip this if `kubectl port-forward` access is enough.

### Install

The examples use namespace `dsh-yawn`. One namespace holds one control plane,
and the release must be named `dsh-yawn-control-plane`: the Kubernetes runner
manifests read fixed names that this release owns.

Create the proxy's OIDC Secret first. Secret values do not belong in values
files, so the chart deliberately never sees them:

```sh
kubectl create namespace dsh-yawn
kubectl -n dsh-yawn create secret generic dsh-yawn-oidc \
  --from-literal=OAUTH2_PROXY_OIDC_ISSUER_URL=https://your-idp/realm \
  --from-literal=OAUTH2_PROXY_CLIENT_ID=dsh-yawn-control-plane \
  --from-literal=OAUTH2_PROXY_CLIENT_SECRET=… \
  --from-literal=OAUTH2_PROXY_COOKIE_SECRET="$(openssl rand -base64 32 | tr -- '+/' '-_')"
```

```yaml
# dsh-yawn.values.yaml
oidc:
  enabled: true
  hostname: dsh.example.com
  emailDomains: your-company.com
service:
  type: LoadBalancer
```

```sh
helm install dsh-yawn-control-plane oci://ghcr.io/zhming0/charts/dsh-yawn \
  --namespace dsh-yawn \
  --values dsh-yawn.values.yaml
```

The chart also creates the ServiceAccount, Role, and RoleBinding the Kubernetes
backend uses: `sandboxclaims`, `sandboxes`, and the
`dsh-yawn-registration-token` Secret the control plane keeps current.
Kubernetes cannot limit `create` to one Secret name, so the Role can create any
Secret in the namespace; `patch` is limited to that one Secret.

### Expose the Web UI

The chart's Service is a ClusterIP anchor by default. Either set
`service.type=LoadBalancer`, as above, or point your own Ingress or Gateway API
route at it. Whatever fronts dsh must serve HTTPS, because the proxy's cookie
is secure, and pass WebSockets and large request bodies. With ingress-nginx:

```yaml
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
          # Only for runners outside the cluster, such as Buildkite agents.
          # It skips oauth2-proxy: the registration token protects the tunnel.
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

The host must match `oidc.hostname`. The chart passes it to dsh as
`--trusted-host`, because dsh rejects `/api` requests whose `Host` header is
neither loopback nor trusted.

Users sign in at `https://dsh.example.com/launch-token`. Everyone the identity
provider admits shares the same sessions, secrets, and sandboxes, so set
`oidc.emailDomains` accordingly.

Without `oidc.enabled`, or to skip the proxy, use a port-forward:

```sh
kubectl -n dsh-yawn port-forward deploy/dsh-yawn-control-plane 3000:3000
# open http://localhost:3000/launch-token
```

### Previews

Set `preview.domain` to serve each sandbox port at its own origin,
`<sandboxId>-p<port>.<domain>`. The chart then opens the preview listener and
creates Service `dsh-yawn-control-plane-preview`, and nothing in front of it.
You provide the wildcard DNS record, a wildcard certificate (cert-manager
needs the DNS-01 solver; HTTP-01 cannot answer for a wildcard name), the
Ingress rule, and authentication:

```yaml
# A second rule on the Web UI's Ingress, with the same timeouts.
rules:
  - host: "*.sandbox.example.com"
    http:
      paths:
        - path: /
          pathType: Prefix
          backend:
            service:
              name: dsh-yawn-control-plane-preview
              port:
                name: http
tls:
  - hosts: ["*.sandbox.example.com"]
    secretName: dsh-yawn-preview-tls
```

The listener answers every request that reaches it, and `oidc.enabled` does
not cover it. Put your own authentication in front of the preview rule, or
keep the Service internal. Three rules keep that authentication out of
sandbox code:

- List its session cookie in `preview.authCookieNames`. A front that covers
  every preview host sets a cookie for the whole wildcard, and the browser
  sends it with every preview request. The control plane removes the listed
  cookies, and their numbered `_1`, `_2`, … chunks, before a request enters
  a sandbox; the previewed app's own cookies pass through.
- Do not authenticate previews with a header. Only cookies are stripped, so a
  header such as basic auth's `Authorization` reaches sandbox code.
- Keep the Web UI's cookie host-only. A cookie domain on the UI's
  oauth2-proxy that spans the preview hosts sends the UI session with every
  preview request.

Previews open as top-level browser tabs, so any domain works. A registrable
domain separate from the UI's is recommended (these examples share
`example.com` only for brevity), so the browser keeps the two sets of cookies
apart. The sandbox NetworkPolicy needs no change: sandboxes reach the control
plane on the tunnel port only.

### Verify

```sh
kubectl -n dsh-yawn rollout status deployment/dsh-yawn-control-plane --timeout=300s
```

The pod becomes Ready when dsh is serving. Open the address you exposed; you
should land signed in through `/launch-token`. You can then create a session,
add secrets, and add a repository workspace. The first tool call fails until a
runner is installed, which is expected.

### Upgrade

`helm upgrade` moves the control plane. It does not change runners; re-apply
their manifests at the matching version to move their image.

The data volume carries the dsh profile across the upgrade. On the first boot
of a new image, the image's seed refreshes the control plane's own package and
keeps everything else in the profile, including plugins installed from the Web
UI. If that refresh fails, the seed logs a warning, keeps the previous
`package.json` as `package.json.before-reseed`, and retries on the next boot.

## VM or other Docker host

The same control-plane image runs as one Docker container on any machine you
keep on. Sandboxes then run as sibling containers on that machine's Docker, or
on Buildkite. Unlike the chart, this path ships no authentication: you bring
the HTTPS proxy and the sign-in in front of it.

### Run the container

```sh
docker run -d --name dsh-yawn --restart unless-stopped \
  --network host \
  -e DSH_YAWN_CONTROL_PLANE_LAUNCH_TOKEN_ROUTE=1 \
  -v dsh-yawn-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/zhming0/dsh-yawn-control-plane:<version> \
  --trusted-host dsh.example.com
```

This differs from the [README's quick start](../README.md#quick-start) on
purpose:

- `--network host` without `DSH_YAWN_BIND_ALL` keeps the Web UI on the VM's
  loopback, `127.0.0.1:3000`, as in the Kubernetes pod. Sandbox containers
  cannot reach it, so only your proxy can use `/launch-token`. On a Docker
  network the quick start's way, a sandbox could reach port 3000 and take the
  sign-in token.
- The runner tunnel listens on port 8081 on every interface, so sandboxes on
  this machine can dial it. Keep it off the internet with a firewall.
- `--trusted-host` names the hostname users open. dsh rejects `/api` requests
  whose `Host` header is neither loopback nor trusted.
- The `dsh-yawn-data` volume holds the profile, sessions, and credentials.

### Authentication

Any reverse proxy works, such as Caddy or nginx, together with an
authentication layer, such as oauth2-proxy with your OIDC provider, an
identity-aware proxy, or a private network only your team can join. Run it on
the VM itself, or in a container with `--network host`, so it can reach
loopback. It must:

- serve HTTPS and proxy to `http://127.0.0.1:3000`, passing the `Host` header
  through;
- pass WebSockets, keep connections open for hours, and accept request bodies
  of a few hundred megabytes;
- admit only people you trust with the whole control plane. Everyone it admits
  shares the same sessions, secrets, and sandboxes.

Users then open `https://dsh.example.com/launch-token` to sign in.

For runners outside this machine, such as Buildkite agents, also route the
exact path `/tunnel` to port 8081 and leave authentication off that path: the
registration token already protects it. Runners then dial
`wss://dsh.example.com/tunnel`. See
[Tunnel](../control-plane/README.md#tunnel).

### Upgrade

Pull the new version, remove the container, and run the same command with the
new tag. The data volume keeps the profile and installed plugins, as on
Kubernetes.
