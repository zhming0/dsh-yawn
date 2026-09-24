import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  missingImportedProfiles,
  readDeploymentSettings,
} from "../src/deployment-settings.js";

describe("deployment settings file", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-deployment-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("reads the chart's runtime slice, and nothing when unset", async () => {
    const path = join(directory, "sandbox-settings.yaml");
    expect(readDeploymentSettings(path)).toEqual({});

    await writeFile(
      path,
      [
        "sandboxManager:",
        "  profiles:",
        "    standard:",
        "      backend: kas",
        "      warmPool: dsh-yawn-universal",
        "  defaultProfile: standard",
        "  idleMs: 300000",
        "",
      ].join("\n"),
    );
    expect(readDeploymentSettings(path)).toMatchObject({
      profiles: {
        standard: {
          backend: "kas",
          warmPool: "dsh-yawn-universal",
        },
      },
      defaultProfile: "standard",
      idleMs: 300_000,
    });

    // A section this image does not know yet is ignored; the document is a
    // chart-to-image contract and the two tags can differ.
    await writeFile(
      path,
      "someFutureSection:\n  a: 1\nsandboxManager:\n  defaultProfile: standard\n",
    );
    expect(readDeploymentSettings(path)).toMatchObject({
      defaultProfile: "standard",
    });

    // A malformed section is operator error and must fail the row, not look
    // like a deployment with no profiles.
    await writeFile(path, "sandboxManager:\n  profiles: [");
    expect(() => readDeploymentSettings(path)).toThrow("is not valid YAML");
  });

  it("reports profiles a renamed legacy document still holds", async () => {
    const path = join(directory, "settings.yaml.imported");
    expect(missingImportedProfiles(path, [])).toEqual([]);

    await writeFile(
      path,
      [
        "sandbox-manager:",
        "  profiles:",
        "    hosted:",
        "      backend: buildkite",
        "    standard:",
        "      backend: docker",
        "",
      ].join("\n"),
    );
    expect(missingImportedProfiles(path, ["standard"])).toEqual(["hosted"]);
    expect(missingImportedProfiles(path, ["hosted", "standard"])).toEqual([]);

    // An unrelated document, or one that cannot be read, is not a reason to
    // warn.
    await writeFile(path, "ui-settings-general:\n  developerTools: true\n");
    expect(missingImportedProfiles(path, [])).toEqual([]);
    await writeFile(path, "sandbox-manager: [");
    expect(missingImportedProfiles(path, [])).toEqual([]);
  });
});
