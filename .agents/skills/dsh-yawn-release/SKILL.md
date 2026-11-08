---
name: dsh-yawn-release
description: Cut and publish a DSH Yawn release through Buildkite
---

# Release DSH Yawn

Releases are cut from `main` by the `dsh-yawn` Buildkite pipeline (org `zhming0`). Each passing `main` build waits at a manual `:rocket: Release` block.

## Cut the release

1. Open the latest passing `main` build at https://buildkite.com/zhming0/dsh-yawn.
2. Unblock `:rocket: Release` (UI, API, or Buildkite MCP: `list_builds` → `list_jobs` → `unblock_job`). Unblocking uploads `.buildkite/pipeline.release.yml`.
3. Wait for the release pipeline to finish.
4. Get the version from the new GitHub release.

The release commits nothing, so `main` does not change. Do not tag or create the GitHub release by hand; the pipeline owns both.

## Write the release note

The pipeline writes the base note: the generated change list, images, the sandbox-pool pin, and the full-changelog link. Keep the generated list and full-changelog link.

Add a highlight only when a merged PR changes something a user can see. Skip it for refactors, CI, docs, and dependency bumps. Keep it dry:

- one fact per bullet, with no adjectives or "now you can"
- an emoji, then the user-visible result (not the PR title)
- at most three bullets; one is usually enough

Put the highlight at the top of the note, above `## What's Changed`, as a GitHub alert:

> [!NOTE]
> **✨ Highlights**
> - 🧩 Creator plugins persist across sandboxes.
> - ⚡ Sandboxes start when the first prompt is sent.

Use `[!IMPORTANT]` for a breaking change and say what to do in one line:

> [!IMPORTANT]
> **⚠️ Breaking**
> - 🔐 `oidc.enabled` is removed; set `auth.mode: oidc` instead.

To prepend it to the pipeline's note:

```bash
VERSION=<version>
gh release view "$VERSION" --repo zhming0/dsh-yawn --json body --jq .body > base-notes.md
{
  cat <<'EOF'
> [!NOTE]
> **✨ Highlights**
> - 🧩 ...
EOF
  echo
  cat base-notes.md
} > notes.md
gh release edit "$VERSION" --repo zhming0/dsh-yawn --notes-file notes.md
```

Do not add any other prose above the generated note.

## Verify

```bash
gh release view <version> --repo zhming0/dsh-yawn
docker manifest inspect ghcr.io/zhming0/dsh-yawn-control-plane:<version>
docker manifest inspect ghcr.io/zhming0/dsh-yawn-runner:<version>
helm show chart oci://ghcr.io/zhming0/charts/dsh-yawn --version <version>
```

Report the release URL. If the pipeline fails, read the failing log before retrying; a retry reuses the same version.
