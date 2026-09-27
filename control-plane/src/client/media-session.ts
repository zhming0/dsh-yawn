/**
 * Name the session on each file image request.
 *
 * dsh renders a file image — inline in the chat, full size in the image
 * dialog, or in a Markdown preview in the right sidebar — as
 * `<img src="api/file?path=...">`, a URL the stock client builds without a
 * session id, so the request reaches the host with no identity beyond the
 * path — and one sandbox-frame path exists in every sandbox. The image's
 * place in the page does know: the stock conversation view and right sidebar
 * mark their roots with `data-conversation-session` and
 * `data-sidebar-right-session`, and dsh itself finds an element's session with
 * `closest()` on those attributes.
 *
 * This module watches the document and, for each `/api/file` image inside
 * such a view, adds that view's session as the `dsh-yawn-session` query
 * parameter. The bundle's `media-route` row reads it back on the host (see
 * `src/media-route.ts`); the stock route reads only `path` and ignores it.
 * The session comes from the image's own view, so two tabs, or two views in
 * one tab, never share a value.
 *
 * The rewrite runs in the observer's microtask, right after React inserts
 * the image. The inline images are `loading="lazy"`, so the browser has not
 * requested the original URL yet. Any other image outside a view is left as
 * it is, and fails as it did before.
 *
 * @module @zhming0/dsh-yawn/client/media-session
 */

/** The query parameter `src/media-route.ts` reads. */
export const MEDIA_SESSION_PARAM = "dsh-yawn-session";

/** The stock route `SessionMediaReferences` mounts, without its base. */
const MEDIA_ROUTE = "/api/file";

/**
 * The attributes the stock conversation view and right sidebar put on their
 * roots; dsh finds an element's session with `closest()` on the same ones.
 */
const SESSION_ATTRIBUTES = [
  "data-conversation-session",
  "data-sidebar-right-session",
];
const SESSION_SELECTOR = SESSION_ATTRIBUTES.map((a) => `[${a}]`).join(", ");

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

/**
 * The source as the stock client built it — absolute, without this module's
 * parameter — or undefined when it is not a same-origin `/api/file` URL.
 */
export function stockMediaSrc(
  src: string,
  documentUrl: string,
): string | undefined {
  let url: URL;
  try {
    url = new URL(src, documentUrl);
  } catch {
    return undefined;
  }
  if (
    url.origin !== new URL(documentUrl).origin ||
    !url.pathname.endsWith(MEDIA_ROUTE)
  ) {
    return undefined;
  }
  url.searchParams.delete(MEDIA_SESSION_PARAM);
  return url.href;
}

/** The part of a DOM element this module touches; tests fake it. */
export interface MediaElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  closest(selector: string): MediaElement | null;
  querySelectorAll(selector: string): Iterable<MediaElement>;
}

/** The session of the stock view an element sits in, if any. */
export function sessionOf(element: MediaElement): string | undefined {
  const owner = element.closest(SESSION_SELECTOR);
  for (const attribute of SESSION_ATTRIBUTES) {
    const sessionId = owner?.getAttribute(attribute);
    if (sessionId) {
      return sessionId;
    }
  }
  return undefined;
}

/**
 * Tags images for one document. An image inside a session view gets that
 * view's session. The full-size image dialog is portalled to
 * `document.body`, outside every view, so an image there gets the session
 * of the thumbnail the user just clicked — only when its source is exactly
 * that thumbnail's.
 */
export function createMediaTagger(documentUrl: () => string): {
  tag(image: MediaElement): void;
  noteClick(target: MediaElement): void;
} {
  let clicked = new Map<string, string>();
  return {
    tag(image) {
      const src = image.getAttribute("src");
      if (src === null) {
        return;
      }
      const stock = stockMediaSrc(src, documentUrl());
      const sessionId =
        sessionOf(image) ??
        (stock === undefined ? undefined : clicked.get(stock));
      if (sessionId === undefined) {
        return;
      }
      const tagged = mediaSrcWithSession(src, documentUrl(), sessionId);
      if (tagged !== undefined) {
        image.setAttribute("src", tagged);
      }
    },
    noteClick(target) {
      clicked = new Map();
      const sessionId = sessionOf(target);
      if (sessionId === undefined) {
        return;
      }
      const control = target.closest("button, a") ?? target;
      for (const image of control.querySelectorAll("img")) {
        const src = image.getAttribute("src");
        const stock =
          src === null ? undefined : stockMediaSrc(src, documentUrl());
        if (stock !== undefined) {
          clicked.set(stock, sessionId);
        }
      }
    },
  };
}

/** Tag every image under the document, now and as they appear. Returns the disposer. */
export function installMediaSession(root: Document = document): () => void {
  const tagger = createMediaTagger(() => root.baseURI);
  const tagAll = (node: Node): void => {
    if (!(node instanceof Element)) {
      return;
    }
    if (node instanceof HTMLImageElement) {
      tagger.tag(node);
    }
    for (const image of node.querySelectorAll("img")) {
      tagger.tag(image);
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
  // Capture phase: note the thumbnail before React opens the dialog.
  const onClick = (event: Event): void => {
    if (event.target instanceof Element) {
      tagger.noteClick(event.target);
    }
  };
  root.addEventListener("click", onClick, true);
  tagAll(root.documentElement);
  return () => {
    observer.disconnect();
    root.removeEventListener("click", onClick, true);
  };
}
