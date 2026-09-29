# Credentials and secrets

Sandboxes have no credentials of their own; they receive the control plane's.
The control plane keeps one store of named secrets and pushes the current
values to the runner before each command, which injects them into that
command's environment.

There are two scopes:

- **Global** secrets reach every sandbox.
- **Workspace** secrets reach the sandboxes of one repository Workspace and
  override a global secret with the same name.

A sandbox receives the global set with its workspace's overrides applied and
nothing from other workspaces. Scoping limits which sandbox receives a value;
it does not isolate users from one another. Anyone admitted to the control
plane can reach every sandbox.

This is the step after [installation](installations.md): the control plane and
a runner come first.

## GITHUB_TOKEN

`GITHUB_TOKEN` is the secret most installs need. It is injected like any other
secret, and it doubles as the Git credential for github.com: the control plane
serves it to Git over a Unix socket, so it never lands in the workspace or in a
remote URL.

Use a fine-grained personal access token scoped to the repositories sessions
work on, with **Contents: read** — add write access if the agent should push.
If you are logged in with the GitHub CLI, `gh auth token` prints a suitable
token. Without one, sessions can still clone public repositories; private
repositories fail at `git clone`. A workspace-scoped token serves that
workspace's clones instead of the global one, so two Workspaces can use two
tokens.

## Set a secret

Secrets go in through the Web UI: **Settings → Secrets**. It is the only way
in, and values are write-only: the page lists names, never values. The scope
selector picks **Global · All workspaces** or one repository Workspace. A name
stored in both scopes resolves to the workspace's value inside that workspace
and to the global value everywhere else.

A change applies before the session's next command, including to running
sessions: before every command the control plane re-reads the store and pushes
the session's effective set to its runner. No control-plane restart is needed.

## Credentials the control plane owns

Two credentials belong to the control plane and must never reach a sandbox:

- **The shared registration token**, in the `dsh-yawn-registration-token`
  Secret the chart creates. Warm runner pods must hold it before any session
  exists. It only lets a runner register a tunnel.
- **A Buildkite API token**, which can create and cancel builds. Store it in a
  Secret you own and pass it to the control plane with
  `controlPlane.extraEnv`, or enter it on **Settings → Sandboxes** when you
  create a Buildkite profile. The page writes it, write-only, to
  `$DSH_HOME/.credentials.yaml` on the control plane's data volume, under a
  name derived from the profile:
  `DSH_YAWN_BUILDKITE_<PROFILE>_TOKEN`. A stored token is used before the
  environment fallback.

[`installations-control-plane.md`](installations-control-plane.md#credentials)
sets both up, and
[`kubernetes.md`](kubernetes.md#the-in-cluster-control-plane) covers
registration-token rotation.

## Never write values down

A secret value must not appear in `cordis.patch.yml`, in a values file, in a
committed file, or in chat. Those are plain text, and transcripts are durable.

Sandbox code can read injected secrets — that is what they are for. Treat
everything in the store as visible to whatever a session runs. Keep each
secret as narrow as the work needs, and delete ones you stop using.
