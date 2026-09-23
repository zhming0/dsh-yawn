# Credentials and secrets

Sandboxes have no credentials of their own; they borrow the control plane's. The control plane
keeps one store of named secrets and pushes the current values to the runner
before each command, which injects them into that command's environment. The
store is global to the control plane — one trust domain, no per-session or
per-repository scoping.

This is the step after [installation](installations.md): the control plane and
a runner come first.

## GITHUB_TOKEN

`GITHUB_TOKEN` is the one secret most installs need. Besides being injected
like any other, it is the Git credential for github.com: the control plane serves it to
Git over a Unix socket, so it never lands in the workspace or in a remote URL.

Use a fine-grained personal access token scoped to the repositories sessions
work on, with **Contents: read** — add write access if the agent should push.
If you are logged in with the GitHub CLI, `gh auth token` prints a suitable
token. Without one, sessions still clone public repositories; private ones
fail at `git clone`.

## Set a secret

Secrets go in through the Web UI: **Settings → Secrets**. It is the only way
in — there is no CLI — and values are write-only: the page lists names, never
values.

A change applies before the session's next command, running sessions included:
before every command the control plane re-reads the store and pushes it to the
runner. No control-plane restart is needed.

## Credentials the control plane owns

Two credentials are the control plane's own, not entries in the Secrets store:

- the **runner token**: the control plane generates it on first boot, keeps it
  on its data volume, and writes it into the `dsh-yawn-registration-token`
  Secret that warm pods mount before any session exists. It only lets a runner
  register a tunnel, and it reaches only the runners this control plane starts.
  **Settings → Sandboxes** shows and rotates it;
- a **Buildkite API token** — it can create and cancel builds, so it must never
  reach a sandbox. Store it in a Secret you own and read it into the control
  plane environment with `controlPlane.extraEnv`, or enter it on **Settings →
  Sandboxes** when you create a Buildkite profile: the page writes it
  write-only into the host credential document (`$DSH_HOME/.credentials.yaml`)
  on the data volume, under a name derived from the profile
  (`DSH_YAWN_BUILDKITE_<PROFILE>_TOKEN`, so two profiles keep two tokens). A
  stored token is used before the environment fallback. Either way it stays on
  the control plane and never reaches a sandbox.

[`installations-control-plane.md`](installations-control-plane.md#credentials)
sets the Buildkite token up, and
[`kubernetes.md`](kubernetes.md#the-in-cluster-control-plane) covers how the
runner token reaches Kubernetes sandboxes and how to rotate it.

## Never write values down

A value must not appear in `cordis.patch.yml`, in a values file, in a committed
file, or in chat: those are plain text, and transcripts are durable.

Sandbox code can read injected secrets — that is what they are for — so treat
everything in the store as visible to whatever a session runs. Keep each
secret as narrow as the work needs, and delete the ones you stop using.
