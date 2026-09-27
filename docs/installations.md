# Installation

Install the control plane once, then one or more runners where sessions run:

| Step | What it is                                                                                                                                                                 | Page                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1    | **Control plane** — the Helm chart that installs the dsh process, its data volume, the runner tunnel, the registration token, and Kubernetes access                        | [installations-control-plane.md](installations-control-plane.md)                                         |
| 2    | **Runner** — the process that runs commands inside each sandbox. Choose [Kubernetes agent-sandbox](installations-kas.md) or [Buildkite agents](installations-buildkite.md) | [installations-kas.md](installations-kas.md) or [installations-buildkite.md](installations-buildkite.md) |
| 3    | **Sandbox credentials** — the secrets sessions receive, starting with `GITHUB_TOKEN`                                                                                       | [credentials.md](credentials.md)                                                                         |

The steps are independent. Once step 1 is done, the Web UI, sessions, secrets,
instructions, and repository workspaces work. Without a runner, the first tool
call fails with a message naming the missing runner.

The supported product is the Kubernetes distribution: the control-plane and
runner images are released and tested together. Docker and checkout installs
are development paths described in [development.md](development.md). Only the dsh Web UI (`dsh web`) is supported; headless mode exits before the
idle lifecycle can run.
