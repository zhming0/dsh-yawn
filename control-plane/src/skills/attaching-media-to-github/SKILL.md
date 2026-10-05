# Attaching media to GitHub

`gh` in this sandbox supports `--attach` (2.99.0 or later). It uploads a local
image or video to GitHub and writes the URL into the body, the same as dropping
the file into the browser. Do not commit images to the repository or push them
to a side branch to link them.

```bash
gh pr create --title "…" --body-file body.md \
  --attach /workspace/artifacts/before.png --attach /workspace/artifacts/after.png
gh issue comment 123 --attach '/workspace/artifacts/error.png#The sign-in error'
```

`--attach` works on `gh issue create|edit|comment` and
`gh pr create|edit|comment`. Repeat it once per file, up to 50 files per
command. `gh <command> --help` is the reference that matches the installed
version.

- To place an image inside the text, reference it in the body with the same
  path string you pass to `--attach`, such as
  `![The sign-in error](/workspace/artifacts/error.png)`. gh replaces the path
  with the uploaded URL and keeps your alt text. Files the body does not
  reference are added to the end.
- For an image added at the end, put the alt text after `#` in the flag. A
  video shows as a player only when its reference is alone in its own
  paragraph.
- Only images and videos can be attached.

## When it fails

- gh signs in with `GITHUB_TOKEN` from the command environment. Uploads accept
  OAuth tokens and personal access tokens (classic or fine-grained). A GitHub
  App installation token (`ghs_`) is refused with "unsupported authentication
  type".
- The token needs write access to the repository.
- It works on github.com and ghe.com, but not on GitHub Enterprise Server.

Report the error to the user instead of falling back to committing images.
