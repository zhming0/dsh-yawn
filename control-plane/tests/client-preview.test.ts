import { describe, expect, it } from "vitest";

import { previewPathSuffix, withPreviewPort } from "../src/client/preview.js";

describe("preview URLs", () => {
  it("swaps the port of the sandbox label and leaves the domain alone", () => {
    expect(withPreviewPort("sandbox-one-p3000.example.com", "4173")).toBe(
      "sandbox-one-p4173.example.com",
    );
    // A sandbox id may contain the same shape; only the trailing marker is
    // the port.
    expect(withPreviewPort("dsh-a1b2c3-p3000.example.com", "4173")).toBe(
      "dsh-a1b2c3-p4173.example.com",
    );
    // A domain that contains the marker keeps its own text.
    expect(withPreviewPort("sandbox-one-p3000.example-p8082.com", "4173")).toBe(
      "sandbox-one-p4173.example-p8082.com",
    );
    expect(withPreviewPort("sandbox-one-p3000.example.com", " 80 ")).toBe(
      "sandbox-one-p80.example.com",
    );
  });

  it("refuses a bad port or a host that is not a preview host", () => {
    for (const port of ["", "0", "70000", "abc", "41 73"]) {
      expect(
        withPreviewPort("sandbox-one-p3000.example.com", port),
      ).toBeUndefined();
    }
    expect(withPreviewPort("example.com", "4173")).toBeUndefined();
    expect(withPreviewPort("sandbox-one.example.com", "4173")).toBeUndefined();
  });

  it("appends an entry path without doubling its slash", () => {
    expect(previewPathSuffix("")).toBe("");
    expect(previewPathSuffix("   ")).toBe("");
    expect(previewPathSuffix("/")).toBe("");
    expect(previewPathSuffix("docs")).toBe("/docs");
    expect(previewPathSuffix("//docs/a")).toBe("/docs/a");
    expect(previewPathSuffix("/docs?tab=1")).toBe("/docs?tab=1");
  });
});
