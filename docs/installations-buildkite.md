# Runner on a Buildkite agent

This backend runs each sandbox as one build on a Buildkite pipeline you own.
The control plane triggers the build; the agent runs the runner container; the
runner connects back over the tunnel. Choose it when sessions should run
outside the cluster.

This backend is a development path, like Docker. It is unit tested against a
fake Buildkite API, but the pipeline shapes below have not been tested against
every agent fleet; watch the first build in your organization. The backend's
internals and limits are in [`buildkite.md`](buildkite.md).

Install the [control plane](installations-control-plane.md) first.

## Prerequisites

- A Buildkite organization and permission to create a pipeline.
- An [API access token](https://buildkite.com/docs/apis/managing-api-tokens)
  with `read_builds` and `write_builds`.
- Hosted Linux agents, or self-hosted agents that can run Docker.
- A tunnel address the agents can reach. Agents are not on the control-plane
  host, so an in-cluster address will not work.

## Create the pipeline

For hosted Linux agents, use this one command step. The control plane never
uploads steps: the pipeline's own definition is the only place they are defined.

```yaml
steps:
  - label: dsh sandbox
    image: "$DSH_YAWN_RUNNER_IMAGE"
    command: |
      # The agent's Docker socket is root-owned; the sandbox account needs it
      # for the repository's Docker workflows.
      chmod 666 /var/run/docker.sock 2>/dev/null || true
      exec runuser -u sandbox -- sh -c 'cd /workspace && exec dsh-yawn-runner'
    checkout:
      skip: true
    secrets:
      DSH_YAWN_REGISTRATION_TOKEN: dsh_yawn_registration_token
    timeout_in_minutes: 240
    agents:
      queue: hosted-amd64-small
```

Set `queue` to your hosted Linux queue. The agent and its startup hooks run as
root; the command launches the runner as `sandbox` (UID 1000) with
`HOME=/workspace/home`. Do not add `--login` or `--preserve-environment` to
`runuser`: the command needs to keep the `DSH_YAWN_*` job variables while
resetting `HOME`.

For self-hosted agents, use Docker instead:

```yaml
steps:
  - label: dsh sandbox
    command: >-
      docker run --rm --user 1000:1000
      -e DSH_YAWN_SANDBOX_ID -e DSH_YAWN_CONTROL_PLANE_URL -e DSH_YAWN_REGISTRATION_TOKEN
      "$DSH_YAWN_RUNNER_IMAGE"
    checkout:
      skip: true
    secrets:
      DSH_YAWN_REGISTRATION_TOKEN: dsh_yawn_registration_token
    timeout_in_minutes: 240
    agents:
      queue: self-hosted
```

Things the pipeline must get right:

- `DSH_YAWN_RUNNER_IMAGE`, `DSH_YAWN_SANDBOX_ID`, and
  `DSH_YAWN_CONTROL_PLANE_URL` come from the build environment the control
  plane sets. Never pin a runner image in the pipeline.
- `secrets` maps a
  [Buildkite secret](https://buildkite.com/docs/pipelines/security/secrets/buildkite-secrets)
  into the job: the key on the left is the variable the runner reads, and the
  value on the right is the secret's key, which may contain only letters,
  numbers, and underscores. Create `dsh_yawn_registration_token` with the same
  value as the control plane's `dsh-yawn-registration-token` Secret. This
  needs agent 3.106.0 or later.
- Turn off **Skip intermediate builds** and **Cancel intermediate builds** in
  the pipeline's **Settings → Builds**. Every sandbox build uses branch
  `main`, so either setting would skip or cancel another live sandbox.
- Keep `agents.queue` explicit. It selects the fleet, and a second fleet means
  a second pipeline and profile.
- `timeout_in_minutes` bounds a sandbox's life if the control plane never
  cancels it. Buildkite may apply a lower ceiling of its own.
- Turn off the repository webhook, or leave the pipeline without a repository
  integration. Builds started by Buildkite alone have no sandbox variables and
  fail immediately.

## Point the control plane at the pipeline

```yaml
# dsh-yawn.values.yaml
controlPlane:
  sandboxManager:
    profiles:
      hosted:
        backend: buildkite
        organization: acme
        pipeline: dsh-yawn
        controlPlaneUrl: wss://dsh.example.com/tunnel
  extraEnv:
    - name: BUILDKITE_API_TOKEN
      valueFrom:
        secretKeyRef:
          name: dsh-buildkite
          key: token
```

Put the API token in that Secret first, following
[control-plane credentials](installations-control-plane.md#credentials), then
upgrade:

```sh
helm upgrade dsh-yawn-control-plane oci://ghcr.io/zhming0/charts/dsh-yawn \
  --namespace dsh-yawn \
  --values dsh-yawn.values.yaml
```

The control plane resolves the token for each Buildkite request and never sends
it to a build or a runner. Every build uses branch `main`; if the pipeline
limits its build branches, include `main`. Then run a session: the control
plane creates a build, an agent picks it up, and the runner registers.

## Reaching the tunnel

An HTTP Ingress that passes WebSocket upgrades can carry the tunnel as one
`/tunnel` path rule on the Ingress that fronts the Web UI, under the same
certificate. An endpoint exposed separately must be L4: a TCP stream proxy or a
Gateway API `TLSRoute` in passthrough mode. Never put an HTTP-terminating proxy
or CDN in the path.
[`kubernetes.md`](kubernetes.md#exposing-the-runner-tunnel-beyond-the-cluster)
has the details.

## Several fleets

`agents.queue` is per pipeline, so a second fleet means a second pipeline and a
second profile. The composer shows a profile picker when more than one exists:

```yaml
- id: sandbox-manager
  config:
    defaultProfile: hosted
    profiles:
      hosted:
        backend: buildkite
        organization: acme
        pipeline: dsh-yawn
        controlPlaneUrl: wss://dsh.example.com/tunnel
      self-hosted:
        backend: buildkite
        organization: acme
        pipeline: dsh-yawn-self-hosted
        controlPlaneUrl: wss://dsh.example.com/tunnel
```

## Next

[`credentials.md`](credentials.md) gives sessions their credentials, starting
with `GITHUB_TOKEN`.
