# Buildkite backend

Setting this backend up is
[`installations-buildkite.md`](installations-buildkite.md): the pipeline, the
control-plane profile, and how agents reach the tunnel. This page is the reference for
what the backend does and the limits it has.

The Buildkite backend runs one sandbox as one build on a pipeline you own. The
control plane triggers the build through the Build API and tells the job which
sandbox it is, where to dial, and which runner image to run, and keeps the
token the runner presents in the pipeline cluster's Buildkite secret. The job
then runs `dsh-yawn-runner` until the
session goes idle, when the control plane checkpoints the session and
cancels the build. No agent, queue, or image is created on your behalf.

This backend is a development path, like Docker. It is unit tested against a
fake of the Build API; the pipeline examples below have not been run end to end
against a Buildkite agent fleet. Treat them as the intended shape and watch the
first build in your own organization.

## What the control plane does

```text
control plane ──▶ Buildkite API
  PUT  cluster secret {DSH_YAWN_REGISTRATION_TOKEN}
  POST /builds {DSH_YAWN_SANDBOX_ID, DSH_YAWN_CONTROL_PLANE_URL, DSH_YAWN_RUNNER_IMAGE}
  ◀── GET /builds/{n} until state == running
  ◀── agent injects the secret, dsh-yawn-runner dials DSH_YAWN_CONTROL_PLANE_URL with it
```

For each new session the control plane:

1. looks for a live build tagged with the session (`meta_data[dsh-session]`),
   in case the control plane stopped after creating one and before saving its record;
2. otherwise stores the current runner token in the pipeline cluster's
   `DSH_YAWN_REGISTRATION_TOKEN` secret, then creates a build with
   `commit: HEAD` on one shared branch (`main`), build env `DSH_YAWN_SANDBOX_ID`,
   `DSH_YAWN_CONTROL_PLANE_URL`, and `DSH_YAWN_RUNNER_IMAGE`, and that session
   tag;
3. polls the build until its state is `running`, giving up and cancelling the
   build after `readyTimeoutMs` (default 10 minutes); this covers queue wait and
   image pull, after which the runner has 60 seconds to register on the tunnel.

`DSH_YAWN_SANDBOX_ID` is `dsh-<16 hex chars of the session hash>-<6 random hex chars>`.
The random suffix changes on every build, so a runner from a cancelled job
that is still redialing cannot be mistaken for the new one. The build's branch
is not that id: it is always `main`. Buildkite requires a branch, but the
pipeline's repository has nothing to do with the sandbox and the step skips
checkout, so the branch is only a label. Because every sandbox shares it, the
pipeline's intermediate-build settings ("skip queued intermediate builds",
"cancel running intermediate builds") must stay off, or a new sandbox would
skip or cancel a live one.

## Idle: checkpoint, cancel, restore

A Buildkite job cannot pause, so there is no hibernation. Instead, when the
session goes idle the control plane checkpoints the sandbox before it cancels
the build: it commits the Git working tree inside the sandbox (only if there
are changes), writes the commits that `origin`'s default branch does not have
to a Git bundle, and pulls that bundle out over the tunnel into the control
plane's `stateDir/checkpoints/`. It then tars the session's artifacts folder,
`/workspace/artifacts/`, and pulls that out too. Nothing is pushed to
the repository and no Git write access is needed. The build is cancelled only
after the checkpoint files are on the control plane; if the Git save fails the
build keeps running and the idle timer retries. The session record stays,
marked checkpointed, and `expiresAfterMs` starts counting.

On the next prompt the control plane triggers a new build, the runner clones the
repository and runs `.agents/setup` exactly as for a new session, and the
control plane then unpacks the bundle and puts the session back where it was: the
original branch at the same commit (or a detached `HEAD`), with the checkpoint
commit undone so the changes are uncommitted once more, and the artifacts
folder unpacked into place.

The Git working tree and the artifacts folder are the only things saved.
Ignored files, installed packages, tool versions from `mise install`, and
everything else outside the repository are gone when the build is cancelled.
Put that setup in `.agents/setup` so the next build reproduces it. An artifacts
folder over 64 MiB, or one whose tar fails, is left behind rather than carried:
the Git work still checkpoints, and the next prompt says the folder did not come
back. The full contract, including what a checkpoint does and does not keep and
the 64 MiB caps, is in the control plane README under "Idle and hibernation".

The control plane polls the build state when a session resumes. A build that has
finished or been cancelled outside dsh is reported as missing and the session
gets a replacement build under the same profile.

## Host configuration

```yaml
- id: sandbox-manager
  config:
    tunnel:
      port: 8081
    profiles:
      hosted:
        backend: buildkite
        organization: acme
        pipeline: dsh-yawn
        controlPlaneUrl: wss://dsh.example.com/tunnel
```

| Field            | Default               | Meaning                                                                  |
| ---------------- | --------------------- | ------------------------------------------------------------------------ |
| `organization`   | required              | Organization slug, as in `buildkite.com/<organization>`                  |
| `pipeline`       | required              | Pipeline slug                                                            |
| `controlPlaneUrl`        | required              | Tunnel endpoint the runner dials, `wss://host/tunnel` or `ws://host:port/tunnel` |
| `image`          | matching release tag  | Runner image the job runs, sent to the build as `DSH_YAWN_RUNNER_IMAGE`       |
| `readyTimeoutMs` | `600000`              | How long a build may sit `scheduled` before the control plane cancels it      |
| `secretKey`      | `DSH_YAWN_REGISTRATION_TOKEN` | Cluster secret holding the token; only needed when profiles share a cluster |

The control plane needs an [API access token](https://buildkite.com/docs/apis/managing-api-tokens)
for the organization with these scopes: `read_builds` and `write_builds` for the
builds, `read_pipelines` to find the pipeline's cluster, and
`read_secrets_details` and `write_secrets` for the secret. Enter it on
**Settings → Sandboxes** when you create the profile, which stores it
write-only in the host credential document, or set `BUILDKITE_API_TOKEN` on the
control plane. It is resolved per Buildkite request, so a changed token reaches
the next call without a restart, and a profile whose token resolves nowhere
does not stop the host: its sessions fail at the first prompt with the setting
to fix. The token stays in the control plane process; it is never sent to a
build or a runner.

The control plane generates the runner token and keeps it in the pipeline
cluster's Buildkite secret, created with an access policy for that pipeline, so
the value never appears in the build environment the Builds API returns. The
pipeline maps the key into the job once — see
[the pipeline](#the-pipeline) — and Buildkite injects it at job start. A profile
whose pipeline is not in a cluster fails to provision with that message: only
clustered agents can read Buildkite secrets.

`controlPlaneUrl` must be reachable from Buildkite agents, which are never on the control plane
machine. The tunnel is a WebSocket on the control plane's plaintext tunnel port, so
whenever agents reach it over a network you do not control, and hosted agents
always do, terminate TLS in front of it and hand the agents a `wss://` URL. On
the Kubernetes distribution that is one `/tunnel` path rule on the Ingress
that already serves the Web UI, under the same certificate; the exact rule,
the L4 alternative, and the proxy limits that matter are in
[`kubernetes.md`](kubernetes.md#exposing-the-runner-tunnel-beyond-the-cluster).
Any HTTPS reverse proxy that passes WebSocket upgrades does the same job
elsewhere.

## The pipeline

The pipeline is one command step that runs the runner image the control plane names.
[`installations-buildkite.md`](installations-buildkite.md#create-the-pipeline)
has the YAML and the setup steps. What matters to the backend:

- The step declares the secret once, under the key the profile uses
  (`DSH_YAWN_REGISTRATION_TOKEN` by default):

  ```yaml
  secrets:
    - DSH_YAWN_REGISTRATION_TOKEN
  ```

  The agent injects the stored value into the job at start, so the runner finds
  it in the environment without the value ever appearing in the build
  environment the Builds API returns. Delete and re-create the secret by hand
  and the control plane still owns its value: it re-creates it on the next
  publish.
- Hosted Linux agents use `image: "$DSH_YAWN_RUNNER_IMAGE"`, resolved from
  the build environment. Startup hooks run as root, then `runuser -u sandbox`
  launches the runner as UID 1000 with `HOME=/workspace/home`, retaining the
  `DSH_YAWN_*` job variables. There is no nested runner container.
- Self-hosted agents use `docker run --user 1000:1000`. Its `-e VAR` flags
  copy `DSH_YAWN_SANDBOX_ID`, `DSH_YAWN_CONTROL_PLANE_URL`, and
  `DSH_YAWN_REGISTRATION_TOKEN` from the job environment into the container.
  The image has no entrypoint and defaults to `CMD ["dsh-yawn-runner"]`.
- The image leaves `HOME` unset so the container runtime selects the starting
  user's home: `/root` for root, or `/workspace/home` for the sandbox account
  (UID 1000). This lets root-run hosted agent hooks create Docker credentials
  under `/root/.docker` rather than the sandbox account's home.
- The control plane sets `DSH_YAWN_RUNNER_IMAGE` to the tag matching its own version, so
  the pipeline never pins an image and cannot drift from the control plane.
- `agents.queue` explicitly picks the fleet in the pipeline. Two fleets mean
  two pipelines; do not assume the hosted `image` interpolation behavior
  applies to queue selection.
- `checkout: { skip: true }` stops the agent from cloning the pipeline's own
  repository. The runner clones the session's repository itself, into
  `/workspace/repository` inside the container, with credentials the control plane
  pushes over the tunnel. The pipeline's repository setting is irrelevant to
  the sandbox; point it at any repository the agent may read, or an empty one.
- Every build uses the same branch (`main`), because Buildkite requires one.
  Keep the pipeline's **Skip intermediate builds** and **Cancel intermediate
  builds** settings off: they act on everything sharing a branch, so a new
  sandbox would skip or cancel a live one. Both are off by default.
- `timeout_in_minutes` bounds a sandbox's life even if the control plane never cancels
  it, so it is a backstop. Buildkite applies its own ceiling on top: the
  Personal plan caps a job at 4 hours, hosted agents at 8 hours unless
  Buildkite support raises it, and an organization or pipeline may set a
  maximum command step timeout.

The pipeline should not trigger builds on its own. Turn off the repository
webhook, or leave the pipeline without a repository integration, so the only
builds are the ones the control plane creates. A build that Buildkite starts by
itself has no `DSH_YAWN_SANDBOX_ID` or `DSH_YAWN_CONTROL_PLANE_URL` in its env, so `dsh-yawn-runner` exits at
once and the job fails; it wastes an agent slot but never reaches the control plane.

## Trust boundary

One control plane is one trust domain, and a Buildkite profile widens it:

- The API token can create and cancel builds on the pipeline, and its secrets
  scopes let whoever owns the token write the cluster's secrets. Anyone who can
  read the control plane's environment can trigger jobs on your agents and
  rewrite cluster secrets. Keep the token to the control plane, and give the
  pipeline its own cluster and queue rather than sharing them with unrelated
  CI.
- Every agent that can take the job, and every person who can edit the
  pipeline's steps, can read `DSH_YAWN_REGISTRATION_TOKEN` and the secrets the
  control plane pushes to the runner after it registers. The secret's access
  policy scopes it to this pipeline, so a pipeline that should not have it
  cannot fetch it.
- The job runs with whatever the agent grants it. On hosted agents that is a
  Buildkite-managed VM; on self-hosted agents it is your infrastructure.
- The idle checkpoint files — the Git bundle and the artifacts tar — live in
  the control plane's state directory, next to the credential store, so a
  checkpointed session's work has the same exposure as a hibernated sandbox's
  disk.

## Limits

- No hibernation. Idle saves the Git working tree and the artifacts folder on
  the control plane and cancels the build; everything else in the sandbox is
  lost. The first prompt after the restore tells the model what did not come
  back.
- A build is polled every two seconds while waiting for an agent. With a busy
  self-hosted queue, raise `readyTimeoutMs`.
- `health` is a Build API read on every resume of a session whose tunnel has
  dropped. Buildkite's REST rate limit applies to the API token.
- Build states are read from the Build API, not from the job. A build whose
  single job has failed shows `failed`; a build blocked by a step the pipeline
  should not have is treated as never starting and cancelled at the timeout.
