/**
 * The query parameter that names the session on a sandbox media request.
 *
 * The host routes read it back and run the read as that session's agent; the
 * browser modules add it to image and video URLs. It lives here so neither
 * side needs to import the other.
 *
 * @module @zhming0/dsh-yawn/session-param
 */

/** The query parameter `src/media/media-route.ts` and the video route read. */
export const MEDIA_SESSION_PARAM = "dsh-yawn-session";
