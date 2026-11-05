/**
 * Right-sidebar video preview.
 *
 * dsh's document preview ships renderers for text, images, PDF, Office, and
 * spreadsheets, and lists a video suffix as a known binary it cannot show.
 * The preview registry is extensible by plugin: register the suffixes here and
 * put a body under the same id in the document slot. The body streams from
 * `sandbox-video-route` instead of reading complete bytes, so a recording
 * larger than the workspace-files complete-file cap can play and seek.
 *
 * The player is deliberately plain: browser controls, no autoplay, and one
 * failure line when the media cannot load or play. The route, not this
 * component, owns MIME type and range handling.
 *
 * @module @zhming0/dsh-yawn/client/video-preview
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-workspace-files/client";
// Type-only: adds the `useResource` standard prop and the `file` protocol's
// value type to the client context.
import type {} from "@deepseek-ai/dsh-client-resources/client";
// Type-only: declares `ctx.documentPreviews`, the document slot, and the
// renderer definition consumed below.
import type { DocumentPreviewProps } from "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client";

import { MEDIA_SESSION_PARAM } from "./media-session.js";
import { VIDEO_EXTENSIONS, VIDEO_ROUTE } from "../video-media.js";

/** Metadata id, and the keyed body id under `sidebar.right.tab.document`. */
export const VIDEO_PREVIEW_ID = "@zhming0/dsh-yawn/video-preview";

/** The file-address prefix that carries a Session. */
const SESSION_ADDRESS_PREFIX = "dsh-resource://file/session/";

/**
 * Register the video renderer while the stock document-preview service is
 * mounted. Both effects are reversible, so disabling either plugin restores
 * the stock "unsupported binary" state.
 */
export function installVideoPreview(ctx: Context): void {
  ctx.inject(["documentPreviews"], (scope) => {
    scope.effect(
      () =>
        scope.documentPreviews.register({
          id: VIDEO_PREVIEW_ID,
          extensions: VIDEO_EXTENSIONS,
          binaryExtensions: VIDEO_EXTENSIONS,
          priority: "extension",
          title: () => "Video",
          loading: "renderer",
          wrap: false,
        }),
      "video-preview: metadata",
    );
    scope.effect(
      () =>
        scope.slots.inject("sidebar.right.tab.document", () =>
          scope.slots.register(
            {
              name: "sidebar.right.tab.document",
              key: VIDEO_PREVIEW_ID,
            },
            VideoPreview,
          ),
        ),
      "video-preview: body",
    );
  });
}

/**
 * The document body: wait for the file's metadata, then hand the browser a URL
 * that can range-request the file from the session's sandbox.
 */
export function VideoPreview({
  content,
  resourceAddress,
  useResource,
}: DocumentPreviewProps): ReactNode {
  const meta = useResource<"file">(resourceAddress);
  const request = content.kind === "renderer" ? content : undefined;
  const version = meta.value?.version;
  const sessionId = sessionIdOfFileAddress(resourceAddress);
  const absolutePath = meta.value?.absolutePath;
  const loadedRevision = useRef<number | undefined>(undefined);
  const [playbackFailed, setPlaybackFailed] = useState(false);

  // `renderer` loading mode expects the body to report the version it shows.
  // The player is usable as soon as the file's metadata is known; its own
  // media request then loads the bytes.
  useEffect(() => {
    if (request === undefined || version === undefined) {
      return;
    }
    if (loadedRevision.current === request.revision) {
      return;
    }
    loadedRevision.current = request.revision;
    request.loaded(version);
  }, [request, version]);

  useEffect(() => {
    if (request !== undefined && meta.status === "failed") {
      request.failed();
    }
  }, [request, meta.status]);

  useEffect(() => {
    setPlaybackFailed(false);
  }, [version]);

  if (
    request === undefined ||
    sessionId === undefined ||
    absolutePath === undefined
  ) {
    return null;
  }

  return (
    <div style={FRAME_STYLE}>
      <video
        controls
        playsInline
        preload="metadata"
        src={videoSrc(document.baseURI, sessionId, absolutePath, version)}
        aria-label="Video preview"
        style={VIDEO_STYLE}
        onError={() => setPlaybackFailed(true)}
      />
      {playbackFailed && (
        <p style={FAILURE_STYLE} role="alert">
          This video could not be loaded or played. It may be unavailable, or
          the browser may not support its format or codec.
        </p>
      )}
    </div>
  );
}

/**
 * The Session id an address names, or undefined for an absolute address or a
 * malformed one. The document preview claims only Session addresses. This is
 * the `dsh-resource://file/session/<id>/<path>` grammar from
 * `dsh-util-workspace-path`, kept local so the bundle carries no second copy
 * of that package.
 */
export function sessionIdOfFileAddress(address: string): string | undefined {
  if (!address.startsWith(SESSION_ADDRESS_PREFIX)) {
    return undefined;
  }
  const rest = address.slice(SESSION_ADDRESS_PREFIX.length);
  const cut = rest.indexOf("/");
  const encoded = cut === -1 ? rest : rest.slice(0, cut);
  if (encoded.length === 0) {
    return undefined;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/**
 * The authenticated video route, with the session and file path it needs.
 * The route is relative so a deployment prefix survives; `v` keeps a reload of
 * a changed file separate from the previous response.
 */
export function videoSrc(
  base: string,
  sessionId: string,
  path: string,
  version?: string,
): string {
  const url = new URL(VIDEO_ROUTE.replace(/^\//u, ""), base);
  url.searchParams.set("path", path);
  url.searchParams.set(MEDIA_SESSION_PARAM, sessionId);
  if (version !== undefined) {
    url.searchParams.set("v", version);
  }
  return url.href;
}

const FRAME_STYLE = {
  alignItems: "center",
  background: "#000",
  display: "flex",
  height: "100%",
  justifyContent: "center",
  position: "relative",
  width: "100%",
} as const;

const VIDEO_STYLE = {
  maxHeight: "100%",
  maxWidth: "100%",
} as const;

const FAILURE_STYLE = {
  background: "rgba(0, 0, 0, 0.72)",
  borderRadius: 6,
  color: "#fff",
  fontSize: 13,
  left: "50%",
  margin: 0,
  maxWidth: 360,
  padding: "8px 12px",
  position: "absolute",
  textAlign: "center",
  top: "50%",
  transform: "translate(-50%, -50%)",
} as const;
