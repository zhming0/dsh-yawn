---
name: acceptance-run
description: Prove a dsh-yawn change through a real session — a disposable control plane from the checkout, the feature's own UI steps, and assertions read inside the session's sandbox.
whenToUse: Use when a change needs evidence past unit tests — credentials, sandbox lifecycle, tool routing, settings, or a Web UI contribution. The steps differ per feature; this skill is the loop and the seams, not a fixed script.
---

# Acceptance run

An acceptance run answers one question: does the product path work when a real
model drives a real sandbox? The loop is the same every time; the steps in the
middle belong to the feature under test.

## The loop

1. **Bring up a disposable control plane from the checkout.**

   ```bash
   node scripts/acceptance.mjs up [--runner-image <tag>]
   ```

   It prints `{ url, home, log, stateDir, tunnelPort }`. It builds the control
   plane, installs it into a scratch `DSH_HOME` whose profile points at a Docker
   sandbox profile, opens the Docker socket permission a sandboxed runner user
   needs, and picks free ports — so it never touches a control plane the
   operator is using, and `down` removes only the sandboxes it created.

   The runner image must already exist. `docker buildx bake dev --load` builds
   it once; a released `ghcr.io/zhming0/dsh-yawn-runner:<version>` tag works for
   any change that does not touch `runner/`.

2. **Drive the feature's UI with `agent-browser`.** Read the
   `using-agent-browser` skill first; `agent-browser skills get core --full`
   prints its own reference. A machine that has not driven a browser yet needs
   `install-browser` and `. "$HOME/.local/share/agent-browser-env.sh"` in every
   shell that drives it.

   Two screens come first on a fresh control plane: an "Internal Testing
   Notice" (click **Continue**), then **Add workspace** with a disposable public
   repository URL. Everything after that is whatever the change needs — this is
   the part to customize.

3. **Assert from the host, not from the model's prose.**

   ```bash
   node scripts/acceptance.mjs sandbox ls
   node scripts/acceptance.mjs sandbox exec <session-id> -- cat /workspace/repository/<file>
   ```

   `sandbox ls` prints each sandbox's `sessionId`. Reading the sandbox is the
   evidence; a chat answer is not. Secrets are the exception: the runner injects
   them into session commands, so `docker exec` cannot see them — assert their
   *effect* from the host (a file, a git remote, a clone) and their injected
   values from the tool output in the transcript.

4. **Put what the user should see in `/workspace/artifacts/`**, by absolute
   path.

5. **Tear down.** `node scripts/acceptance.mjs down` stops the control plane and
   removes only the sandboxes it created. `--purge` also removes the scratch
   home; keep it after a failure, because its `web.log` and `state/` hold the
   diagnosis.

## Customize the middle

Write a scenario file when the same flow runs more than once, or when one run
needs many UI steps: a small Node script that shells out to `agent-browser` and
`scripts/acceptance.mjs`, with the feature's assertions at the end. Keep it
under `/workspace/artifacts/` — the checkout stays clean, and a scenario is
evidence, not product code.

A worked example, the workspace-scoped secret:

```bash
# UI: Settings → Secrets → scope Global → set SCOPE_DEMO=global-value
#     scope Workspace · octocat/Hello-World → set SCOPE_DEMO=workspace-value
# Session: ask the model to run `echo "$SCOPE_DEMO"`; the tool output must show
#          workspace-value, and git must clone with the workspace token.
node scripts/acceptance.mjs sandbox exec <session-id> -- \
  cat /workspace/repository/proof.txt
```

## Facts that save a run

- **A sandbox is as old as its container.** Hibernation and wake keep the same
  machine, and an image rebuild reaches a sandbox only when it is created, so a
  binary added to a Dockerfile can be missing from a sandbox that was created
  before the change. Check the machine (`dpkg -l docker-ce-cli`) before
  suspecting the image.
- **The Docker backend names a sandbox `dsh-<hash>` and labels it
  `dsh.session=<session-id>`**; that label is what `sandbox ls` reads.
- **`pnpm test:docker` and `pnpm test:kas` cover lifecycle and transport** and
  run on every branch in CI. An acceptance run is for what they cannot reach:
  the browser, the model, and the assembled control plane.
