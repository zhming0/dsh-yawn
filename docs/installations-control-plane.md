# Control plane

The `dsh-yawn` Helm chart installs the control plane: the dsh process, its data
volume, the runner tunnel, the shared registration token, and the Kubernetes
permissions needed to manage sandboxes. Sandboxes run elsewhere; see the
[installation index](installations.md).

## Prerequisites

- A Kubernetes cluster you administer, with `kubectl` 1.27 or later.
- `helm` 3.8 or later.
- A default StorageClass, or a storage class name for the control plane's data
  volume.
- An OIDC identity provider. dsh has no user authentication of its own, so the
  distribution puts oauth2-proxy in front of it and you supply the client.
  Skip this if `kubectl port-forward` access is enough.

## Install

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

The chart creates the `dsh-yawn-registration-token` Secret. Runners present
that token to register with the control plane; the chart keeps its generated
value across `helm upgrade`. Use `registrationToken.value` or
`registrationToken.existingSecret` to supply your own.

The chart also creates the `dsh-yawn-control-plane` ServiceAccount and a
namespace-scoped Role and RoleBinding for `sandboxclaims` and `sandboxes`.
That is all a Kubernetes runner needs from you.

The Service is a ClusterIP anchor by default. Either set
`service.type=LoadBalancer` or point your own Ingress or Gateway API route at
it. Whatever fronts dsh must serve HTTPS and pass WebSockets and large RPC
bodies; [`kubernetes.md`](kubernetes.md) has nginx-ingress reference values.

Without `oidc.enabled`, reach the control plane with `kubectl port-forward` and
open `/launch-token`. The release notes print the exact command.

## Verify

```sh
kubectl -n dsh-yawn rollout status deployment/dsh-yawn-control-plane --timeout=300s
```

The pod becomes Ready when dsh is serving. Open the address you exposed; you
should land signed in through `/launch-token`. You can then create a session,
add secrets, and add a repository workspace. The first tool call fails until a
runner is installed, which is expected.

## Credentials

Three credentials touch this install:

- **OIDC client secret** for oauth2-proxy, in the `dsh-yawn-oidc` Secret above.
- **Registration token** created by the chart. To rotate it, see
  [`kubernetes.md`](kubernetes.md#the-in-cluster-control-plane).
- **Credentials the control plane uses itself**, such as a Buildkite API token.
  Put these in a Secret you own and pass them through `controlPlane.extraEnv`:

```sh
kubectl -n dsh-yawn create secret generic dsh-buildkite \
  --from-literal=token="$BUILDKITE_API_TOKEN"
```

```yaml
controlPlane:
  extraEnv:
    - name: BUILDKITE_API_TOKEN
      valueFrom:
        secretKeyRef:
          name: dsh-buildkite
          key: token
```

The pod's environment is fixed at startup, so restart the pod after changing
the Secret. Credentials like this must not go in the Web UI's secret store:
that store is pushed into sandboxes. See [`credentials.md`](credentials.md).

## Upgrade

`helm upgrade` moves the control plane. It does not change runners; re-apply
their manifests at the matching version to move their image.

The data volume carries the dsh profile across the upgrade. On the first boot
of a new image, the image's seed refreshes the control plane's own package and
keeps everything else in the profile, including plugins installed from the Web
UI. If that refresh fails, the seed logs a warning, keeps the previous
`package.json` as `package.json.before-reseed`, and retries on the next boot.
