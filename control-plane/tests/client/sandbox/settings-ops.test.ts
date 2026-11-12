import { describe, expect, it } from "vitest";

import {
  BACKEND_FIELDS,
  INTERNAL_PROFILE_FIELDS,
  effectiveTokenCredential,
  formTokenCredential,
  newTokenCredential,
  profileRemoveOps,
  profileSaveOps,
  profileWithStableTokenCredential,
  profileWithTokenCredential,
  tokenCredentialOwner,
} from "../../../src/client/sandbox/settings-shared.js";
import type { SandboxProfileOptionView } from "../../../src/sandbox/sandbox-settings-remote.js";

function profile(
  name: string,
  backend: string,
  fields: Record<string, string> = {},
): SandboxProfileOptionView {
  return { name, backend, fields, locked: false, idleMs: 60_000 };
}

describe("profile fields", () => {
  it("keeps the token credential out of the rendered form and card", () => {
    expect(
      (BACKEND_FIELDS.buildkite ?? []).some(
        (field) => field.key === "tokenCredential",
      ),
    ).toBe(false);
    expect(INTERNAL_PROFILE_FIELDS.has("tokenCredential")).toBe(true);
  });
});

describe("effectiveTokenCredential", () => {
  it("derives the credential name for a Buildkite profile", () => {
    expect(effectiveTokenCredential("hosted", "buildkite", undefined)).toBe(
      "DSH_YAWN_BUILDKITE_HOSTED_TOKEN",
    );
  });

  it("keeps an explicit credential reference", () => {
    expect(
      effectiveTokenCredential(
        "renamed",
        "buildkite",
        "DSH_YAWN_BUILDKITE_ORIGINAL_TOKEN",
      ),
    ).toBe("DSH_YAWN_BUILDKITE_ORIGINAL_TOKEN");
  });

  it("has no token reference for a non-Buildkite backend", () => {
    expect(effectiveTokenCredential("standard", "docker", undefined)).toBe(
      undefined,
    );
  });

  it("keeps an explicit reference after a backend change", () => {
    expect(
      effectiveTokenCredential(
        "standard",
        "docker",
        "DSH_YAWN_BUILDKITE_ORIGINAL_TOKEN",
      ),
    ).toBe("DSH_YAWN_BUILDKITE_ORIGINAL_TOKEN");
  });
});

describe("profileWithStableTokenCredential", () => {
  it("pins the old credential name when a Buildkite profile is renamed", () => {
    expect(
      profileWithStableTokenCredential(
        { backend: "buildkite" },
        "large",
        "standard",
        "buildkite",
      ),
    ).toEqual({
      backend: "buildkite",
      tokenCredential: "DSH_YAWN_BUILDKITE_STANDARD_TOKEN",
    });
  });

  it("keeps an explicit credential reference", () => {
    expect(
      profileWithStableTokenCredential(
        {
          backend: "buildkite",
          tokenCredential: "DSH_YAWN_BUILDKITE_SHARED_TOKEN",
        },
        "large",
        "standard",
        "buildkite",
      ),
    ).toEqual({
      backend: "buildkite",
      tokenCredential: "DSH_YAWN_BUILDKITE_SHARED_TOKEN",
    });
  });

  it("does not pin a renamed profile of another backend", () => {
    expect(
      profileWithStableTokenCredential(
        { backend: "docker" },
        "large",
        "standard",
        "docker",
      ),
    ).toEqual({ backend: "docker" });
  });

  it("leaves an unchanged legacy Buildkite profile on its derived name", () => {
    expect(
      profileWithStableTokenCredential(
        { backend: "buildkite" },
        "hosted",
        "hosted",
        "buildkite",
      ),
    ).toEqual({ backend: "buildkite" });
  });

  it("pins the old name when a legacy profile switches backend", () => {
    expect(
      profileWithStableTokenCredential(
        { backend: "docker" },
        "hosted",
        "hosted",
        "buildkite",
      ),
    ).toEqual({
      backend: "docker",
      tokenCredential: "DSH_YAWN_BUILDKITE_HOSTED_TOKEN",
    });
  });
});

describe("formTokenCredential", () => {
  it("shows no reference for a new profile", () => {
    expect(
      formTokenCredential(undefined, "hosted", "buildkite", undefined),
    ).toBe("");
  });

  it("resolves an existing profile's reference", () => {
    expect(
      formTokenCredential("hosted", "hosted", "buildkite", undefined),
    ).toBe("DSH_YAWN_BUILDKITE_HOSTED_TOKEN");
  });

  it("shows no reference for a non-Buildkite profile", () => {
    expect(
      formTokenCredential("standard", "standard", "docker", undefined),
    ).toBe("");
  });
});

describe("newTokenCredential", () => {
  it("generates an opaque, valid credential reference", () => {
    expect(newTokenCredential()).toMatch(
      /^DSH_YAWN_BUILDKITE_[0-9A-F]{32}_TOKEN$/,
    );
  });

  it("generates a different reference each time", () => {
    expect(newTokenCredential()).not.toBe(newTokenCredential());
  });
});

describe("profileWithTokenCredential", () => {
  it("gives a new Buildkite profile an opaque reference", () => {
    const saved = profileWithTokenCredential(
      { backend: "buildkite" },
      "hosted",
      undefined,
      undefined,
    );
    expect(saved.tokenCredential).toMatch(
      /^DSH_YAWN_BUILDKITE_[0-9A-F]{32}_TOKEN$/,
    );
  });

  it("leaves a new non-Buildkite profile without one", () => {
    expect(
      profileWithTokenCredential(
        { backend: "docker" },
        "standard",
        undefined,
        undefined,
      ),
    ).toEqual({ backend: "docker" });
  });

  it("keeps an existing reference", () => {
    expect(
      profileWithTokenCredential(
        {
          backend: "buildkite",
          tokenCredential: "DSH_YAWN_BUILDKITE_ORIGINAL_TOKEN",
        },
        "hosted",
        undefined,
        undefined,
      ),
    ).toEqual({
      backend: "buildkite",
      tokenCredential: "DSH_YAWN_BUILDKITE_ORIGINAL_TOKEN",
    });
  });

  it("pins the old derived name when a legacy profile is renamed", () => {
    expect(
      profileWithTokenCredential(
        { backend: "buildkite" },
        "hosted-east",
        "hosted",
        "buildkite",
      ),
    ).toEqual({
      backend: "buildkite",
      tokenCredential: "DSH_YAWN_BUILDKITE_HOSTED_TOKEN",
    });
  });
});

describe("tokenCredentialOwner", () => {
  it("finds a profile whose derived name collides", () => {
    expect(
      tokenCredentialOwner(
        [profile("a-b", "buildkite"), profile("a_b", "buildkite")],
        "a_b",
        "DSH_YAWN_BUILDKITE_A_B_TOKEN",
      ),
    ).toBe("a-b");
  });

  it("finds a profile with an explicit reference", () => {
    expect(
      tokenCredentialOwner(
        [
          profile("standard", "docker", {
            tokenCredential: "DSH_YAWN_BUILDKITE_SHARED_TOKEN",
          }),
        ],
        "large",
        "DSH_YAWN_BUILDKITE_SHARED_TOKEN",
      ),
    ).toBe("standard");
  });

  it("ignores the profile being saved", () => {
    expect(
      tokenCredentialOwner(
        [profile("standard", "buildkite")],
        "standard",
        "DSH_YAWN_BUILDKITE_STANDARD_TOKEN",
      ),
    ).toBeUndefined();
  });

  it("reports no owner for a unique reference", () => {
    expect(
      tokenCredentialOwner(
        [profile("standard", "buildkite")],
        "large",
        "DSH_YAWN_BUILDKITE_LARGE_TOKEN",
      ),
    ).toBeUndefined();
  });
});

describe("profileSaveOps", () => {
  it("adds a new profile with one write", () => {
    expect(
      profileSaveOps("standard", { backend: "docker" }, undefined, false),
    ).toEqual([
      {
        op: "set",
        path: ["profiles", "standard"],
        value: { backend: "docker" },
      },
    ]);
  });

  it("renames in one write instead of leaving both names behind", () => {
    expect(
      profileSaveOps("large", { backend: "docker" }, "standard", false),
    ).toEqual([
      { op: "set", path: ["profiles", "large"], value: { backend: "docker" } },
      { op: "unset", path: ["profiles", "standard"] },
    ]);
  });

  it("moves a default selection to the new name", () => {
    expect(
      profileSaveOps("large", { backend: "docker" }, "standard", true),
    ).toEqual([
      { op: "set", path: ["profiles", "large"], value: { backend: "docker" } },
      { op: "unset", path: ["profiles", "standard"] },
      { op: "set", path: ["defaultProfile"], value: "large" },
    ]);
  });

  it("edits a profile in place without unsetting it", () => {
    expect(
      profileSaveOps("standard", { backend: "docker" }, "standard", false),
    ).toEqual([
      {
        op: "set",
        path: ["profiles", "standard"],
        value: { backend: "docker" },
      },
    ]);
  });
});

describe("profileRemoveOps", () => {
  it("removes a profile", () => {
    expect(profileRemoveOps("standard", false)).toEqual([
      { op: "unset", path: ["profiles", "standard"] },
    ]);
  });

  it("clears the default selection the profile owned", () => {
    expect(profileRemoveOps("standard", true)).toEqual([
      { op: "unset", path: ["profiles", "standard"] },
      { op: "unset", path: ["defaultProfile"] },
    ]);
  });
});
