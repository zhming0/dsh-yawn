# Buildkite backend

Each sandbox is one build on a Buildkite pipeline you own. The control plane
triggers the build and tells the job which sandbox it is, where to connect, and
which runner image to run. The pipeline supplies the registration token. The
job runs `dsh-yawn-runner` until the session goes idle, when the control plane
saves the session and cancels the build.

This backend is a development path, like Docker. It is unit tested against a
fake Buildkite API; the example pipelines have not been tested against every
agent fleet. Setup is
[`installations-buildkite.md`](installations-buildkite.md).

## How a sandbox runs

For each session, the control plane:

1. Looks for a live build tagged with the session, in case it restarted after
   creating one but before saving the record.
2. Otherwise creates a build on branch `main` with `DSH_YAWN_SANDBOX_ID`,
   `DSH_YAWN_CONTROL_PLANE_URL`, and `DSH_YAWN_RUNNER_IMAGE` in the build
   environment.
3. Waits for the build to be `running`, then waits up to 60 seconds for the
   runner to register on the tunnel. If the build does not start within
   `readyTimeoutMs` (default 10 minutes), the control plane cancels it.

The build's branch is always `main`, because Buildkite requires one; the step
skips checkout, so the branch is only a label. Every sandbox shares it. Keep
the pipeline's **Skip intermediate builds** and **Cancel intermediate builds**
settings off, or a new sandbox may skip or cancel a live one.

The sandbox ID looks like `dsh-<16 hex chars>-<6 random hex chars>`. The random
suffix changes on every build, so a runner from a cancelled job cannot be
mistaken for a new one.

## Idle: checkpoint, cancel, restore

A Buildkite job cannot pause, so this backend checkpoints instead of
hibernating:

1. The control plane commits the sandbox's Git working tree (only if there are
   changes).
2. It writes commits that `origin`'s default branch does not have to a Git
   bundle (a file Git can restore commits from) in the control plane's state
   directory.
3. It tars the session's `/workspace/artifacts` folder beside the bundle.
4. It cancels the build.

On the next prompt, the control plane creates a new build. The runner clones
the repository and runs `.agents/setup` as it would for a new session. The
control plane then restores the branch and commit, reverts the checkpoint
commit so changes are uncommitted again, and unpacks the artifacts folder.

Saved: the branch, its commits (pushed or not), every tracked or untracked
file, and the artifacts folder. Lost: ignored files, installed tools and
packages, other local branches, stashes, and which changes were staged. Put
what the session needs into `.agents/setup` so the next build recreates it. An
artifacts folder over 64 MiB, or one whose tar fails, is left behind instead of
carried over. The full rules are in
[`control-plane/README.md`](../control-plane/README.md#idle-and-hibernation).

If the git save fails, the build stays up and the idle timer retries. A build
that Buildkite finishes or cancels outside dsh is reported as missing, and the
next prompt gets a replacement.

## Host configuration

```yaml
- id: sandbox-manager
  config:
    registrationToken: <shared with the pipeline>
    tunnel:
      port: 8081
    profiles:
      hosted:
        backend: buildkite
        organization: acme
        pipeline: dsh-yawn
        controlPlaneUrl: wss://dsh.example.com/tunnel
```

| Field             | Default                                   | Meaning                                                                          |
| ----------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| `organization`    | required                                  | Organization slug, as in `buildkite.com/<organization>`                          |
| `pipeline`        | required                                  | Pipeline slug                                                                    |
| `controlPlaneUrl` | required                                  | Tunnel endpoint the runner dials: `wss://host/tunnel` or `ws://host:port/tunnel` |
| `image`           | matching release tag                      | Runner image sent to the build as `DSH_YAWN_RUNNER_IMAGE`                        |
| `readyTimeoutMs`  | top-level `readyTimeoutMs`, else `600000` | How long a build may wait for an agent before the control plane cancels it       |
| `idleMs`          | top-level `idleMs`                        | Idle delay before this profile's sandboxes checkpoint                            |

The API token needs `read_builds` and `write_builds`. Enter it in **Settings →
Sandboxes** when creating the profile, which stores it write-only, or set
`BUILDKITE_API_TOKEN` on the control plane. It is resolved per request, so a
changed token reaches the next call without a restart. The token stays in the
control plane and is never sent to a build or runner. A profile whose token
cannot be resolved does not stop the control plane; its sessions fail at the
first prompt with the setting to fix.

The control plane also needs the registration token: `registrationToken` in
settings or `DSH_YAWN_REGISTRATION_TOKEN` in the environment. It does not
generate one, because the pipeline must hold the same value.

`controlPlaneUrl` must be reachable from the Buildkite agents. Agents are never
on the control-plane host, and hosted agents always reach it over a network you
do not control, so terminate TLS in front of the tunnel and use `wss://`. The
Kubernetes distribution does this with one `/tunnel` path rule on the Ingress
that serves the Web UI. See
[`kubernetes.md`](kubernetes.md#exposing-the-runner-tunnel-beyond-the-cluster).

## Trust boundary

A Buildkite profile widens who can reach the control plane's secrets and build
agents:

- The API token can create and cancel builds on the pipeline. Anyone who can
  read the control plane's environment can trigger jobs on your agents.
- Every agent that can take the job, and everyone who can edit the pipeline's
  steps, can read `DSH_YAWN_REGISTRATION_TOKEN` and the secrets pushed to the
  runner after it registers. Give the pipeline its own cluster and queue rather
  than sharing them with unrelated CI.
- The job runs with whatever the agent grants it: a Buildkite-managed VM on
  hosted agents, your infrastructure on self-hosted agents.
- Idle checkpoint files — the Git bundle and artifacts tar — live next to the
  control plane's credential store, so they have the same exposure as a
  hibernated sandbox's disk.

## Limits

- No hibernation. Idle saves Git work and the artifacts folder, then destroys
  the sandbox; everything else is lost. The first prompt after a restore says
  what did not come back.
- Builds are polled every two seconds while waiting for an agent. Raise
  `readyTimeoutMs` on a busy self-hosted queue.
- Each resume checks the Build API, so Buildkite's REST rate limit applies to
  the API token.
- Build states come from the Build API, not the job. A build whose single job
  failed shows `failed`; a build blocked by an unrelated step is treated as
  never started and cancelled when the timeout passes.
