import { describe, expect, it } from "vitest";

import {
  sessionIdOfFileAddress,
  videoSrc,
} from "../src/client/video-preview.js";

describe("sessionIdOfFileAddress", () => {
  it("reads the session from a Session-scoped file address", () => {
    expect(
      sessionIdOfFileAddress(
        "dsh-resource://file/session/session-one/clip.mp4",
      ),
    ).toBe("session-one");
    expect(
      sessionIdOfFileAddress(
        "dsh-resource://file/session/s%20one/a%20clip.mp4",
      ),
    ).toBe("s one");
  });

  it("refuses absolute and malformed addresses", () => {
    for (const address of [
      "dsh-resource://file/absolute/workspace/clip.mp4",
      "dsh-resource://file/session//clip.mp4",
      "dsh-resource://file/session/%E0%A4%A/clip.mp4",
      "https://example.test/clip.mp4",
    ]) {
      expect(sessionIdOfFileAddress(address)).toBeUndefined();
    }
  });
});

describe("videoSrc", () => {
  it("builds a relative route under the application base", () => {
    expect(
      videoSrc(
        "https://dsh.example.test/prefix/",
        "session-one",
        "/workspace/repository/clip.mp4",
        "7",
      ),
    ).toBe(
      "https://dsh.example.test/prefix/api/yawn-video?path=%2Fworkspace%2Frepository%2Fclip.mp4&dsh-yawn-session=session-one&v=7",
    );
  });

  it("omits the version when metadata has none", () => {
    expect(
      videoSrc("https://dsh.example.test/", "s one", "/workspace/a b.mp4"),
    ).toBe(
      "https://dsh.example.test/api/yawn-video?path=%2Fworkspace%2Fa+b.mp4&dsh-yawn-session=s+one",
    );
  });
});
