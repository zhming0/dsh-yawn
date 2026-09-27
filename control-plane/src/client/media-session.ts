/**
 * Name the session on each chat image request.
 *
 * dsh renders an inline chat image as `<img src="api/file?path=...">`, a URL
 * the stock client builds without a session id, so the request reaches the
 * host with no identity beyond the path — and one sandbox-frame path exists
 * in every sandbox. The image's place in the page does know: the stock
 * conversation view marks its root with `data-conversation-session`, and dsh
 * itself finds a target's session with `closest("[data-conversation-session]")`.
 *
 * This module watches the document and, for each `/api/file` image inside a
 * conversation view, adds that view's session as the `dsh-yawn-session` query
 * parameter. The bundle's `media-route` row reads it back on the host (see
 * `src/media-route.ts`); the stock route reads only `path` and ignores it.
 * The session comes from the image's own view, so two tabs, or two views in
 * one tab, never share a value.
 *
 * The rewrite runs in the observer's microtask, right after React inserts
 * the image. The stock images are `loading="lazy"`, so the browser has not
 * requested the original URL yet. An image outside any conversation view is
 * left as it is, and fails as it did before.
 *
 * @module @zhming0/dsh-yawn/client/media-session
 */

/** The query parameter `src/media-route.ts` reads. */
export const MEDIA_SESSION_PARAM = "dsh-yawn-session";

/** The stock route `SessionMediaReferences` mounts, without its base. */
const MEDIA_ROUTE = "/api/file";

/** The attribute the stock conversation view puts on its root. */
const SESSION_ATTRIBUTE = "data-conversation-session";

/**
 * The image source with its session added, or undefined when the source is
 * not a same-origin `/api/file` URL or already names a session.
 */
export function mediaSrcWithSession(
  src: string,
  documentUrl: string,
  sessionId: string,
): string | undefined {
  let url: URL;
  try {
    url = new URL(src, documentUrl);
  } catch {
    return undefined;
  }
  if (
    url.origin !== new URL(documentUrl).origin ||
    !url.pathname.endsWith(MEDIA_ROUTE) ||
    url.searchParams.has(MEDIA_SESSION_PARAM)
  ) {
    return undefined;
  }
  url.searchParams.set(MEDIA_SESSION_PARAM, sessionId);
  return url.href;
}

/** The part of an image element this module touches; tests fake it. */
export interface MediaImage {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  closest(
    selector: string,
  ): { getAttribute(name: string): string | null } | null;
}

/** Add the enclosing conversation's session to one image's source. */
export function tagMediaImage(image: MediaImage, documentUrl: string): void {
  const src = image.getAttribute("src");
  const sessionId = image
    .closest(`[${SESSION_ATTRIBUTE}]`)
    ?.getAttribute(SESSION_ATTRIBUTE);
  if (src === null || !sessionId) {
    return;
  }
  const tagged = mediaSrcWithSession(src, documentUrl, sessionId);
  if (tagged !== undefined) {
    image.setAttribute("src", tagged);
  }
}

/** Tag every image under the document, now and as they appear. Returns the disposer. */
export function installMediaSession(root: Document = document): () => void {
  const tagAll = (node: Node): void => {
    if (!(node instanceof Element)) {
      return;
    }
    if (node instanceof HTMLImageElement) {
      tagMediaImage(node, root.baseURI);
    }
    for (const image of node.querySelectorAll("img")) {
      tagMediaImage(image, root.baseURI);
    }
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        tagAll(record.target);
      }
      record.addedNodes.forEach(tagAll);
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src"],
  });
  tagAll(root.documentElement);
  return () => observer.disconnect();
}
