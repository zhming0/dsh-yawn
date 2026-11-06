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

The pipeline writes the base note: image pulls, the sandbox-pool overlay, and the generated PR list. Keep the generated list and full-changelog link.

Decide from the merged PRs whether the release needs a highlight. Write one only for a user-visible change worth calling out, always as a single short sentence that says what changed. Put it first, above `## Images`, as a GitHub alert:

> [!NOTE]
> Adds OIDC sign-in and per-host Git credentials.

Use `[!IMPORTANT]` instead for a breaking change. Do not add any other prose above the generated note.

```bash
gh release edit <version> --repo zhming0/dsh-yawn --notes-file notes.md
```

## Verify

```bash
gh release view <version> --repo zhming0/dsh-yawn
docker manifest inspect ghcr.io/zhming0/dsh-yawn-control-plane:<version>
docker manifest inspect ghcr.io/zhming0/dsh-yawn-runner:<version>
helm show chart oci://ghcr.io/zhming0/charts/dsh-yawn --version <version>
```

Report the release URL. If the pipeline fails, read the failing log before retrying; a retry reuses the same version.
