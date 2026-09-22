import { describe, expect, it } from "vitest";

import { testing as shellTesting } from "../src/shell.js";

describe("shell output buffers", () => {
  it("keeps a bounded output tail and reports truncation", () => {
    const shell = new shellTesting.TailBuffer(4);
    shell.append(new TextEncoder().encode("abcdef"));
    expect(shell.collected()).toEqual({ text: "cdef", truncated: true });
  });

  it("keeps the capture whole for observers when a cursor drains", () => {
    const shell = new shellTesting.TailBuffer(64);
    shell.append(new TextEncoder().encode("hello world"));

    // The consuming cursor reads forward...
    const first = shell.readSince(0);
    expect(first).toEqual({
      text: "hello world",
      lossy: false,
      nextCursor: 11,
    });
    const second = shell.readSince(first.nextCursor);
    expect(second.text).toBe("");

    // ...but the capture the observed readers and the foreground result read
    // still holds everything: a drain must not steal bytes from them.
    expect(shell.collected()).toEqual({
      text: "hello world",
      truncated: false,
    });
    expect(shell.readFrom(0)).toEqual({
      text: "hello world",
      nextOffset: 11,
      lossy: false,
    });
  });
});
