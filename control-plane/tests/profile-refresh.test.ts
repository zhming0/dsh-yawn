import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

const run = promisify(execFile);
const seed = new URL("../image/seed", import.meta.url).pathname;

/** The profile manifest the image assembles; dsh-yawn is its only dependency. */
function imageManifest(version: string) {
  return {
    name: "dsh-profile-web",
    private: true,
    dependencies: {
      "@zhming0/dsh-yawn": `file:/opt/dsh-yawn/${version}/dsh-yawn.tgz`,
    },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@deepseek-ai/dsh-web-app",
          "@zhming0/dsh-yawn",
        ],
      },
    },
  };
}

/** A profile the user extended, as the Plugins page or `dsh plugin` leaves it. */
function userManifest(version: string, names: readonly string[]) {
  const manifest = imageManifest(version);
  return {
    ...manifest,
    dependencies: {
      ...Object.fromEntries(names.map((name) => [name, "^1.0.0"])),
      "@zhming0/dsh-yawn": manifest.dependencies["@zhming0/dsh-yawn"],
    },
    dsh: {
      profile: { bundles: [...manifest.dsh.profile.bundles, ...names] },
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * A home volume with a profile and an image root, as `dsh-yawn-seed` finds
 * them at boot. `pnpm` is a stub: this test is about which profile the seed
 * leaves behind, not about what pnpm does with it.
 */
async function fakeBoot(options: {
  imageVersion: string;
  profile?: Record<string, unknown>;
  profilePatch?: string;
  workspace?: string;
}) {
  const base = await mkdtemp(join(tmpdir(), "dsh-yawn-seed-"));
  directories.push(base);
  const root = join(base, "image");
  const home = join(base, "home");
  const bin = join(base, "bin");
  const profileDir = join(home, ".dsh", "profiles", "web");
  await mkdir(join(root, "profile"), { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await mkdir(bin, { recursive: true });

  await writeFile(join(root, "version"), `${options.imageVersion}\n`);
  await writeFile(join(root, "settings.patch.yml"), "# starter settings\n");
  await copyFile(
    new URL("../image/profile-refresh.mjs", import.meta.url),
    join(root, "profile-refresh.mjs"),
  );
  await writeJson(
    join(root, "profile", "package.json"),
    imageManifest(options.imageVersion),
  );
  await writeFile(
    join(root, "profile", "pnpm-workspace.yaml"),
    "nodeLinker: hoisted\n",
  );
  await mkdir(join(root, "profile", "node_modules", "@zhming0", "dsh-yawn"), {
    recursive: true,
  });
  await writeFile(
    join(
      root,
      "profile",
      "node_modules",
      "@zhming0",
      "dsh-yawn",
      "package.json",
    ),
    `{"name":"@zhming0/dsh-yawn","version":"${options.imageVersion}"}\n`,
  );

  const log = join(base, "pnpm.log");
  await writeFile(
    join(bin, "pnpm"),
    `#!/bin/sh\nprintf '%s %s\\n' "$(pwd)" "$*" >> "${log}"\nexit "\${PNPM_EXIT:-0}"\n`,
  );
  await chmod(join(bin, "pnpm"), 0o755);

  if (options.profile !== undefined) {
    await writeJson(join(profileDir, "package.json"), options.profile);
  }
  if (options.profilePatch !== undefined) {
    await writeFile(join(profileDir, "cordis.patch.yml"), options.profilePatch);
  }
  if (options.workspace !== undefined) {
    await writeFile(join(profileDir, "pnpm-workspace.yaml"), options.workspace);
  }

  async function runSeed(pnpmExit = 0): Promise<string> {
    const { stderr } = await run("/bin/sh", [seed], {
      env: {
        ...process.env,
        HOME: home,
        DSH_YAWN_IMAGE_ROOT: root,
        PNPM_EXIT: String(pnpmExit),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
    return stderr;
  }

  return {
    base,
    profileDir,
    root,
    runSeed,
    manifest: () => readJson(join(profileDir, "package.json")),
    marker: () => readFile(join(profileDir, ".dsh-yawn-image-version"), "utf8"),
    markerExists: () => fileExists(join(profileDir, ".dsh-yawn-image-version")),
    carried: () => readJson(join(profileDir, "package.json.before-reseed")),
    carriedExists: () =>
      fileExists(join(profileDir, "package.json.before-reseed")),
    pnpmLog: () => readFile(log, "utf8"),
  };
}

it("seeds the image profile on first boot", async () => {
  const boot = await fakeBoot({ imageVersion: "1.0.0" });

  expect(await boot.runSeed()).not.toContain("could not refresh");
  expect(await boot.manifest()).toEqual(imageManifest("1.0.0"));
  expect(await boot.marker()).toBe("1.0.0\n");
  expect(
    await readFile(join(boot.profileDir, "cordis.patch.yml"), "utf8"),
  ).toBe("# starter settings\n");
});

it("carries a user-installed plugin across an image upgrade", async () => {
  const boot = await fakeBoot({
    imageVersion: "2.0.0",
    profile: userManifest("1.0.0", ["@acme/dsh-sidebar"]),
    profilePatch: "- id: plugin-manager\n  disabled: false\n",
    workspace: "nodeLinker: hoisted\nallowBuilds:\n  sharp: true\n",
  });

  expect(await boot.runSeed()).not.toContain("could not refresh");
  expect(await boot.manifest()).toEqual({
    ...imageManifest("2.0.0"),
    dependencies: {
      "@acme/dsh-sidebar": "^1.0.0",
      "@zhming0/dsh-yawn": "file:/opt/dsh-yawn/2.0.0/dsh-yawn.tgz",
    },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@deepseek-ai/dsh-web-app",
          "@zhming0/dsh-yawn",
          "@acme/dsh-sidebar",
        ],
      },
    },
  });
  expect(await boot.marker()).toBe("2.0.0\n");
  expect(await boot.carriedExists()).toBe(false);
  // The user's files stay: the patch holds Web edits, the workspace file holds
  // pnpm's build-script approvals.
  expect(
    await readFile(join(boot.profileDir, "cordis.patch.yml"), "utf8"),
  ).toBe("- id: plugin-manager\n  disabled: false\n");
  expect(
    await readFile(join(boot.profileDir, "pnpm-workspace.yaml"), "utf8"),
  ).toBe("nodeLinker: hoisted\nallowBuilds:\n  sharp: true\n");
  expect(await boot.pnpmLog()).toBe(
    `${boot.profileDir} update @zhming0/dsh-yawn --prefer-offline\n`,
  );
});

it("keeps the user's manifest and retries when the refresh fails", async () => {
  const profile = userManifest("1.0.0", ["@acme/dsh-sidebar"]);
  const boot = await fakeBoot({
    imageVersion: "2.0.0",
    profile,
    profilePatch: "- id: plugin-manager\n  disabled: false\n",
  });

  expect(await boot.runSeed(1)).toContain("could not refresh the web profile");
  // The pod still starts on the image's own profile...
  expect(await boot.manifest()).toEqual(imageManifest("2.0.0"));
  expect(
    await readFile(join(boot.profileDir, "cordis.patch.yml"), "utf8"),
  ).toBe("- id: plugin-manager\n  disabled: false\n");
  const installed = JSON.parse(
    await readFile(
      join(
        boot.profileDir,
        "node_modules",
        "@zhming0",
        "dsh-yawn",
        "package.json",
      ),
      "utf8",
    ),
  ) as { version: string };
  expect(installed.version).toBe("2.0.0");
  // ...the manifest it was working from is kept, and no version marker is
  // written, so the next boot retries.
  expect(await boot.carried()).toEqual({
    ...imageManifest("2.0.0"),
    dependencies: {
      "@acme/dsh-sidebar": "^1.0.0",
      "@zhming0/dsh-yawn": "file:/opt/dsh-yawn/2.0.0/dsh-yawn.tgz",
    },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@deepseek-ai/dsh-web-app",
          "@zhming0/dsh-yawn",
          "@acme/dsh-sidebar",
        ],
      },
    },
  });
  expect(await boot.markerExists()).toBe(false);

  expect(await boot.runSeed()).not.toContain("could not refresh");
  expect(await boot.manifest()).toEqual({
    ...imageManifest("2.0.0"),
    dependencies: {
      "@acme/dsh-sidebar": "^1.0.0",
      "@zhming0/dsh-yawn": "file:/opt/dsh-yawn/2.0.0/dsh-yawn.tgz",
    },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@deepseek-ai/dsh-web-app",
          "@zhming0/dsh-yawn",
          "@acme/dsh-sidebar",
        ],
      },
    },
  });
  expect(await boot.marker()).toBe("2.0.0\n");
  expect(await boot.carriedExists()).toBe(false);
});

it("also keeps plugins installed after a failed refresh", async () => {
  const boot = await fakeBoot({
    imageVersion: "2.0.0",
    profile: userManifest("1.0.0", ["@acme/dsh-sidebar"]),
  });

  expect(await boot.runSeed(1)).toContain("could not refresh the web profile");
  // The user reinstalls a plugin on the reseeded profile before the retry.
  await writeJson(
    join(boot.profileDir, "package.json"),
    userManifest("2.0.0", ["@acme/dsh-new"]),
  );

  expect(await boot.runSeed()).not.toContain("could not refresh");
  expect(await boot.manifest()).toEqual({
    ...imageManifest("2.0.0"),
    dependencies: {
      "@acme/dsh-new": "^1.0.0",
      "@acme/dsh-sidebar": "^1.0.0",
      "@zhming0/dsh-yawn": "file:/opt/dsh-yawn/2.0.0/dsh-yawn.tgz",
    },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@deepseek-ai/dsh-web-app",
          "@zhming0/dsh-yawn",
          "@acme/dsh-new",
          "@acme/dsh-sidebar",
        ],
      },
    },
  });
  expect(await boot.carriedExists()).toBe(false);
});
