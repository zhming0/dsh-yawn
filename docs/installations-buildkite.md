# Runner on a Buildkite agent

Each sandbox is one build on a Buildkite pipeline you own: the control plane triggers
the build, the agent runs the runner container, and the runner dials back over
the tunnel. Pick this when sessions should run outside the cluster. The
backend's internals are in [`buildkite.md`](buildkite.md).

Install the [control plane](installations-control-plane.md) first.

## Prerequisites

- a Buildkite organization and permission to create a pipeline, an
  [API access token](https://buildkite.com/docs/apis/managing-api-tokens) with
  the `read_builds`, `write_builds`, `read_pipelines`, `read_secrets_details`,
  and `write_secrets` scopes, and either hosted Linux agents
  or self-hosted agents that can run Docker.
- the tunnel reachable from wherever those agents run. Agents are never on the
  host machine, so an in-cluster address will not do; see
  [Reaching the tunnel](#reaching-the-tunnel) below.

## Create the pipeline

For hosted Linux agents, create a pipeline with this one command step. The
control plane never uploads steps: the pipeline's own definition is the whole
contract.

```yaml
steps:
  - label: dsh sandbox
    image: "$DSH_YAWN_RUNNER_IMAGE"
    command: |
      exec runuser -u sandbox -- sh -c 'cd /workspace && exec dsh-yawn-runner'
    checkout:
      skip: true
    timeout_in_minutes: 240
    agents:
      queue: hosted-amd64-small
secrets:
  - DSH_YAWN_REGISTRATION_TOKEN
```

Set `queue` to your hosted Linux queue. Hosted agents resolve `image` from the
build environment. The agent and its startup hooks run as root with
`HOME=/root`; the command then launches the runner as `sandbox` (UID 1000)
with `HOME=/workspace/home`. Do not add `--login` or `--preserve-environment`
to `runuser`: the command needs to retain the `DSH_YAWN_*` job variables while
resetting `HOME` for the sandbox account.

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
    timeout_in_minutes: 240
    agents:
      queue: self-hosted
secrets:
  - DSH_YAWN_REGISTRATION_TOKEN
```

- `DSH_YAWN_RUNNER_IMAGE`, `DSH_YAWN_SANDBOX_ID`, and
  `DSH_YAWN_CONTROL_PLANE_URL` come from the build environment the control
  plane sets, so the pipeline never pins a runner image and cannot drift from
  the control plane. `DSH_YAWN_REGISTRATION_TOKEN` comes from the cluster
  secret the control plane creates and keeps current; the `secrets` key above
  is the only trace of it in the pipeline, and it holds no value. A profile
  with a custom `secretKey` — needed only when two profiles share a cluster —
  maps that key instead.
- Turn off **Skip intermediate builds** and **Cancel intermediate builds** in
  the pipeline's **Settings → Builds**. Every sandbox build lands on the same
  branch (`main`), so either setting would skip or cancel another live
  sandbox's build. Both are off by default.
- `agents.queue` selects your fleet. Keep it explicit in the pipeline; the
  hosted `image` behavior does not imply that other step attributes resolve
  arbitrary build variables. To offer two fleets, create two pipelines and
  point two profiles at them.
- `timeout_in_minutes` bounds a sandbox's life even if the control plane never cancels
  it; the control plane cancels on idle. Buildkite applies its own ceilings on top.
- The pipeline should not trigger builds on its own. Turn off its repository
  webhook, or leave it without a repository integration, so the only builds are
  the ones the control plane creates.

[`buildkite.md`](buildkite.md#the-pipeline) explains each of these in full.

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

The control plane creates every build on `main`. The branch is only a label
because the step skips checkout; if the pipeline limits its build branches,
that list has to include `main`.
Put the token in that Secret first, as
[control-plane credentials](installations-control-plane.md#credentials)
describes, then upgrade:

```sh
helm upgrade dsh-yawn-control-plane oci://ghcr.io/zhming0/charts/dsh-yawn \
  --namespace dsh-yawn \
  --values dsh-yawn.values.yaml
```

The token is resolved for each Buildkite request and never sent to a build, and
it does not go in the control plane's secret store. Then run a session: the
control plane creates a build, an agent picks it up, and the sandbox is live
once its runner registers.

## Reaching the tunnel

An HTTP Ingress that passes WebSocket upgrades can carry the tunnel — one
`/tunnel` path rule on the Ingress that fronts the Web UI, under the same
certificate. An endpoint you expose separately has to be L4: a TCP stream proxy
or a Gateway API `TLSRoute` in passthrough mode. Never put an HTTP-terminating
proxy or CDN in the path.
[`kubernetes.md`](kubernetes.md#exposing-the-runner-tunnel-beyond-the-cluster)
has the shapes and constraints. Exposure changes reachability, not trust: the
runner token still authenticates every runner.

## Several fleets

`agents.queue` is per pipeline, so a second fleet is a second pipeline and a
second profile. That is also how a session gets a choice between sandbox
places; the composer shows a profile chip when more than one exists:

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

[`credentials.md`](credentials.md) gives sessions their credentials,
`GITHUB_TOKEN` first.
