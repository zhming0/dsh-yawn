#!/usr/bin/env node
/**
 * Merge the image's profile manifest into the profile on the data volume.
 *
 * `dsh-yawn-seed` calls this on an image upgrade, so an upgrade refreshes
 * what the image owns — its own dependency and the bundle selection it ships
 * — without dropping what the user added. A plugin installed from the Web
 * Plugins page or `dsh plugin` is a dependency and a bundle entry, so it
 * stays.
 *
 * A fourth argument names the manifest a failed refresh kept as
 * `package.json.before-reseed`. Its dependencies and bundle entries merge
 * back in too, so a retry recovers plugins a reseed dropped. Where the
 * current profile and that manifest name the same thing, the current profile
 * wins.
 *
 * Usage: profile-refresh.mjs <image-manifest> <profile-manifest> <output> [carried-manifest]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** @param {string} path */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const [imagePath, profilePath, outputPath, carriedPath] = process.argv.slice(2);
if (imagePath === undefined || profilePath === undefined || outputPath === undefined) {
  process.stderr.write(
    "usage: profile-refresh.mjs <image-manifest> <profile-manifest> <output> [carried-manifest]\n",
  );
  process.exit(2);
}

const image = readJson(imagePath);
const profile = readJson(profilePath);
const carried =
  carriedPath !== undefined && existsSync(carriedPath) ? readJson(carriedPath) : {};
const imageBundles = image.dsh?.profile?.bundles ?? [];
const profileBundles = profile.dsh?.profile?.bundles ?? [];
// The image's bundles come first so an upgrade cannot change layer precedence,
// then the user's in the order the current profile has them, then anything
// only the kept manifest names.
const bundles = [
  ...imageBundles,
  ...profileBundles.filter((name) => !imageBundles.includes(name)),
  ...(carried.dsh?.profile?.bundles ?? []).filter(
    (name) => !imageBundles.includes(name) && !profileBundles.includes(name),
  ),
];

const merged = {
  ...carried,
  ...profile,
  ...image,
  dependencies: {
    ...carried.dependencies,
    ...profile.dependencies,
    ...image.dependencies,
  },
  dsh: {
    ...carried.dsh,
    ...profile.dsh,
    ...image.dsh,
    profile: { ...carried.dsh?.profile, ...profile.dsh?.profile, ...image.dsh?.profile, bundles },
  },
};

writeFileSync(outputPath, `${JSON.stringify(merged, null, 2)}\n`);
