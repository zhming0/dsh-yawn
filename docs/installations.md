# Installation

Install the control plane once, then one or more runners where sessions run:

| Step | What it is                                                                                                                                                            | Page                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1    | **Control plane** — the dsh process, its data volume, and the runner tunnel, on Kubernetes through the Helm chart or on a VM with Docker                              | [control-plane.md](control-plane.md)                                                           |
| 2    | **Runner** — the process that runs commands inside each sandbox. Choose [Kubernetes agent-sandbox](runners/kubernetes.md) or [Buildkite agents](runners/buildkite.md) | [runners/kubernetes.md](runners/kubernetes.md) or [runners/buildkite.md](runners/buildkite.md) |
| 3    | **Sandbox credentials** — the secrets sessions receive, starting with `GITHUB_TOKEN`                                                                                  | [credentials.md](credentials.md)                                                               |

The Docker backend needs no runner install: the control plane starts each
sandbox as a container through the Docker socket, as in the
[README's quick start](../README.md#quick-start).

The steps are independent. Once step 1 is done, the Web UI, sessions, secrets,
instructions, and repository workspaces work. Without a runner, the first tool
call fails with a message naming the missing runner.

The control-plane and runner images are released and tested together.
Sandboxes run on Docker, Kubernetes agent-sandbox, or Buildkite. Checkout
installs are a development path described in [development.md](development.md). Only the dsh Web UI (`dsh web`) is supported; headless mode exits before the
idle lifecycle can run.
