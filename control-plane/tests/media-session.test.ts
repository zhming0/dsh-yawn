import { describe, expect, it } from "vitest";

import {
  createMediaTagger,
  type MediaElement,
  mediaSrcWithSession,
  sessionOf,
  stockMediaSrc,
} from "../src/client/media-session.js";

const PAGE = "https://dsh.example.test/";
const IMAGE = "https://dsh.example.test/api/file?path=%2Fworkspace%2Fa.png";
const OTHER = "https://dsh.example.test/api/file?path=%2Fworkspace%2Fb.png";

describe("mediaSrcWithSession", () => {
  it("adds the session to a same-origin /api/file URL", () => {
    expect(mediaSrcWithSession(IMAGE, PAGE, "s-one")).toBe(
      `${IMAGE}&dsh-yawn-session=s-one`,
    );
    expect(
      mediaSrcWithSession("api/file?path=%2Fa.png", `${PAGE}prefix/`, "s one"),
    ).toBe(
      "https://dsh.example.test/prefix/api/file?path=%2Fa.png&dsh-yawn-session=s+one",
    );
  });

  it("leaves other sources, and a source that already names a session, alone", () => {
    for (const src of [
      "https://other.example.test/api/file?path=%2Fa.png",
      "https://dsh.example.test/assets/logo.png",
      "data:image/png;base64,AAAA",
      `${IMAGE}&dsh-yawn-session=s-two`,
    ]) {
      expect(mediaSrcWithSession(src, PAGE, "s-one")).toBeUndefined();
    }
  });
});

describe("stockMediaSrc", () => {
  it("drops the session parameter and resolves against the document", () => {
    expect(stockMediaSrc(`${IMAGE}&dsh-yawn-session=s-one`, PAGE)).toBe(IMAGE);
    expect(stockMediaSrc("api/file?path=%2Fworkspace%2Fa.png", PAGE)).toBe(
      IMAGE,
    );
    expect(stockMediaSrc("/assets/logo.png", PAGE)).toBeUndefined();
  });
});

/** A minimal DOM: elements with attributes, a parent, and children. */
class FakeElement implements MediaElement {
  readonly children: FakeElement[] = [];
  parent: FakeElement | undefined;
  constructor(
    readonly tag: string,
    readonly attributes: Record<string, string> = {},
  ) {}
  append(...children: FakeElement[]): this {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
    return this;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  /** Supports the selectors the module uses: tags and `[attribute]` lists. */
  matches(selector: string): boolean {
    return selector
      .split(",")
      .map((part) => part.trim())
      .some((part) =>
        part.startsWith("[")
          ? part.slice(1, -1) in this.attributes
          : part === this.tag,
      );
  }
  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) {
      return this;
    }
    return this.parent?.closest(selector) ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

const img = (src: string) => new FakeElement("img", { src });

describe("sessionOf", () => {
  it("reads the conversation view or right sidebar an element sits in", () => {
    const inChat = img(IMAGE);
    const inSidebar = img(IMAGE);
    new FakeElement("div", { "data-conversation-session": "s-chat" }).append(
      new FakeElement("p").append(inChat),
    );
    new FakeElement("div", { "data-sidebar-right-session": "s-side" }).append(
      inSidebar,
    );

    expect(sessionOf(inChat)).toBe("s-chat");
    expect(sessionOf(inSidebar)).toBe("s-side");
    expect(sessionOf(img(IMAGE))).toBeUndefined();
  });
});

describe("createMediaTagger", () => {
  it("names the session of the view each image sits in", () => {
    const tagger = createMediaTagger(() => PAGE);
    const one = img(IMAGE);
    const two = img(IMAGE);
    new FakeElement("div", { "data-conversation-session": "s-one" }).append(
      one,
    );
    new FakeElement("div", { "data-sidebar-right-session": "s-two" }).append(
      two,
    );

    tagger.tag(one);
    tagger.tag(two);

    expect(one.attributes.src).toBe(`${IMAGE}&dsh-yawn-session=s-one`);
    expect(two.attributes.src).toBe(`${IMAGE}&dsh-yawn-session=s-two`);
  });

  it("gives the image dialog the session of the thumbnail just clicked", () => {
    const tagger = createMediaTagger(() => PAGE);
    const thumbnail = img(IMAGE);
    new FakeElement("div", { "data-conversation-session": "s-one" }).append(
      new FakeElement("button").append(thumbnail),
    );
    tagger.tag(thumbnail);

    tagger.noteClick(thumbnail);
    const dialog = img(IMAGE);
    const unrelated = img(OTHER);
    tagger.tag(dialog);
    tagger.tag(unrelated);

    expect(dialog.attributes.src).toBe(`${IMAGE}&dsh-yawn-session=s-one`);
    expect(unrelated.attributes.src).toBe(OTHER);
  });

  it("forgets the thumbnail on the next click", () => {
    const tagger = createMediaTagger(() => PAGE);
    const thumbnail = img(IMAGE);
    new FakeElement("div", { "data-conversation-session": "s-one" }).append(
      new FakeElement("button").append(thumbnail),
    );
    tagger.noteClick(thumbnail);
    tagger.noteClick(new FakeElement("div"));

    const dialog = img(IMAGE);
    tagger.tag(dialog);

    expect(dialog.attributes.src).toBe(IMAGE);
  });

  it("leaves an image outside every view, or with no source, alone", () => {
    const tagger = createMediaTagger(() => PAGE);
    const outside = img(IMAGE);
    const empty = new FakeElement("img");
    new FakeElement("div", { "data-conversation-session": "s-one" }).append(
      empty,
    );

    tagger.tag(outside);
    tagger.tag(empty);

    expect(outside.attributes.src).toBe(IMAGE);
    expect(empty.attributes.src).toBeUndefined();
  });
});
