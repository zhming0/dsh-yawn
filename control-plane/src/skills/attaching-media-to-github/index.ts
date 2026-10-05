import { skillMarkdown, type AuthoredSkill } from "../../skills.js";

/**
 * Teaches sandboxed sessions to put images and videos on GitHub with
 * `gh --attach`.
 *
 * The flag is newer than most models' training data, so without this a
 * session commits screenshots to a side branch and links them. gh's own help
 * is the version-matched reference, so this skill covers only what a session
 * cannot guess: that the flag exists, how body references are rewritten, and
 * which tokens, permissions, and hosts the upload refuses.
 */
export const attachingMediaToGithub: AuthoredSkill = {
  name: "attaching-media-to-github",
  description:
    "Attach screenshots, images, and videos to GitHub issues, pull requests, and comments with `gh --attach`, so they render inline without being committed anywhere.",
  whenToUse:
    "Use when an image or video should appear on GitHub: UI screenshots for a pull request, a reproduction for a bug report, or a recording of a result.",
  content: skillMarkdown(import.meta.url),
};
