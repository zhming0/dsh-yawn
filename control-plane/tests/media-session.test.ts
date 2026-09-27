import { describe, expect, it } from "vitest";

import {
  type MediaImage,
  mediaSrcWithSession,
  tagMediaImage,
} from "../src/client/media-session.js";

const PAGE = "https://dsh.example.test/";
const IMAGE = "https://dsh.example.test/api/file?path=%2Fworkspace%2Fa.png";

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

/** An image with the given source, inside a view for the given session. */
function fakeImage(src: string | null, sessionId?: string) {
  const attributes = new Map<string, string>();
  if (src !== null) {
    attributes.set("src", src);
  }
  const image: MediaImage = {
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => {
      attributes.set(name, value);
    },
    closest: (selector) =>
      sessionId === undefined
        ? null
        : {
            getAttribute: (name) =>
              `[${name}]` === selector ? sessionId : null,
          },
  };
  return { image, src: () => attributes.get("src") };
}

describe("tagMediaImage", () => {
  it("names the session of the conversation view the image sits in", () => {
    const one = fakeImage(IMAGE, "s-one");
    const two = fakeImage(IMAGE, "s-two");

    tagMediaImage(one.image, PAGE);
    tagMediaImage(two.image, PAGE);

    expect(one.src()).toBe(`${IMAGE}&dsh-yawn-session=s-one`);
    expect(two.src()).toBe(`${IMAGE}&dsh-yawn-session=s-two`);
  });

  it("leaves an image outside any conversation view, or with no source, alone", () => {
    const outside = fakeImage(IMAGE);
    const empty = fakeImage(null, "s-one");

    tagMediaImage(outside.image, PAGE);
    tagMediaImage(empty.image, PAGE);

    expect(outside.src()).toBe(IMAGE);
    expect(empty.src()).toBeUndefined();
  });
});
