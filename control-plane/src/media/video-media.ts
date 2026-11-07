/**
 * Video file facts shared by the Host route and the browser preview.
 *
 * The route serves bytes, and the preview claims the file suffixes. Keeping
 * the suffix and media-type tables in one module stops the two halves from
 * disagreeing about what counts as a video.
 *
 * @module @zhming0/dsh-yawn/video-media
 */

/** The authenticated route the browser preview loads video bytes from. */
export const VIDEO_ROUTE = "/api/yawn-video";

/**
 * Suffixes the preview claims. These are containers browsers can usually play
 * natively; an unsupported codec inside one still gets a player that reports
 * the failure instead of a plain "unsupported preview" message.
 */
export const VIDEO_EXTENSIONS = [
  "mp4",
  "m4v",
  "mov",
  "webm",
  "ogv",
  "ogg",
] as const;

/** The media type sent with a video response, by container suffix. */
export function videoMediaType(path: string): string | undefined {
  switch (suffixOf(path)) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webm":
      return "video/webm";
    case "ogv":
    case "ogg":
      return "video/ogg";
    default:
      return undefined;
  }
}

/** One HTTP byte range, inclusive at both ends. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parse a single-range `Range` header against a file size.
 *
 * A missing header means the caller wants the whole file, an invalid or
 * unsatisfiable one means the caller should receive 416. Multiple ranges are
 * deliberately unsupported: browsers request one range for media, and
 * multipart responses would add a second framing path for no product benefit.
 *
 * @param header - the request's `Range` header, when present.
 * @param size - the file's byte length.
 * @returns the range, `"invalid"` for a 416 response, or undefined for the whole file.
 */
export function parseByteRange(
  header: string | null,
  size: number,
): ByteRange | "invalid" | undefined {
  if (header === null) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) {
    return "invalid";
  }
  const [, startText = "", endText = ""] = match;
  if (startText === "" && endText === "") {
    return "invalid";
  }
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) {
      return "invalid";
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start >= size) {
    return "invalid";
  }
  const end =
    endText === ""
      ? size - 1
      : Math.min(Number(endText), Math.max(size - 1, 0));
  if (!Number.isSafeInteger(end) || end < start) {
    return "invalid";
  }
  return { start, end };
}

/** The lower-case suffix after the last dot of a file path, when it has one. */
function suffixOf(path: string): string | undefined {
  const name = path.split(/[\\/]/u).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 || dot === name.length - 1
    ? undefined
    : name.slice(dot + 1).toLowerCase();
}
