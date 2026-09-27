import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

/**
 * The file-image fix (`src/media-route.ts`, `src/client/media-session.ts`)
 * rests on details of the pinned dsh packages that dsh does not promise. Each
 * check below reads the built package and fails, naming the assumption, in
 * the same change that bumps the dsh pin. When one fails, the images most
 * likely show "Image preview unavailable" again; re-verify the named
 * assumption in the new release and adapt the fix, or delete it if dsh now
 * puts the session in the image URL itself.
 *
 * The browser-only packages are devDependencies here solely for this test,
 * pinned with the rest of dsh (checked below).
 */

const require = createRequire(import.meta.url);

function packageDirectory(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

function packageFile(name: string, file: string): string {
  return readFileSync(join(packageDirectory(name), file), "utf8");
}

/** The Web app's own bundle; its file names carry a content hash. */
function frontendBundle(): string {
  const assets = join(
    packageDirectory("@deepseek-ai/dsh-web-frontend"),
    "dist",
    "assets",
  );
  return readdirSync(assets)
    .filter((file) => /^index-.*\.js$/u.test(file))
    .map((file) => readFileSync(join(assets, file), "utf8"))
    .join("\n");
}

/** One top-level function of a built module, by name. */
function functionBody(text: string, signature: string): string {
  const start = text.indexOf(signature);
  expect(start, `${signature} is gone`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end === -1 ? undefined : end);
}

describe("dsh assumptions behind the file-image fix", () => {
  it("keeps the browser-only packages on the dsh pin", () => {
    const pin = packageJson.peerDependencies["@deepseek-ai/dsh-agent"];
    const devDependencies: Record<string, string> = packageJson.devDependencies;
    for (const name of [
      "@deepseek-ai/dsh-web-frontend",
      "@deepseek-ai/dsh-client-ui-chat",
      "@deepseek-ai/dsh-client-ui-sidebar-right",
      "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
    ]) {
      expect(devDependencies[name], `${name} is not pinned to ${pin}`).toBe(
        pin,
      );
    }
  });

  it("serves /api/file through ctx.fs, reading only the path parameter", () => {
    const text = packageFile(
      "@deepseek-ai/dsh-api-session-controller",
      "lib/index.js",
    );
    expect(
      /connection\.fetch\.register\(\{\s*path:\s*"\/api\/file"/u.test(text),
      "SessionMediaReferences no longer registers GET /api/file",
    ).toBe(true);
    const serveFile = functionBody(text, "async function serveFile(");
    expect(
      serveFile.includes('.searchParams.get("path")'),
      "serveFile no longer reads the path query parameter",
    ).toBe(true);
    expect(
      serveFile.match(/searchParams/gu)?.length,
      "serveFile reads another query parameter; check it cannot clash with dsh-yawn-session",
    ).toBe(1);
    expect(
      /fs\.resolve\(/u.test(serveFile),
      "serveFile no longer reads through ctx.fs, which the initiator boundary relies on",
    ).toBe(true);
  });

  it("runs the connection/request waterfall after auth, around the route dispatch", () => {
    const text = packageFile(
      "@deepseek-ai/dsh-client-connection",
      "lib/index.js",
    );
    expect(
      /\.admit\(req\)[\s\S]{0,400}?\.waterfall\("connection\/request",\s*req,\s*res,\s*\(\)\s*=>\s*bridge\(/u.test(
        text,
      ),
      "the /api route no longer admits the request and then dispatches it inside the connection/request waterfall",
    ).toBe(true);
  });

  it("builds file image URLs as api/file?path=...", () => {
    for (const name of [
      "@deepseek-ai/dsh-client-ui-chat",
      "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
    ]) {
      expect(
        packageFile(name, "lib/client.js").includes(
          "new URL(`api/file?path=${encodeURIComponent(path)}`, base)",
        ),
        `${name} no longer builds image URLs as api/file?path=`,
      ).toBe(true);
    }
  });

  it("marks the conversation view and the right sidebar with their session", () => {
    expect(
      packageFile(
        "@deepseek-ai/dsh-client-ui-conversation",
        "lib/client.js",
      ).includes('"data-conversation-session": sessionId'),
      "the conversation view no longer carries data-conversation-session",
    ).toBe(true);
    expect(
      packageFile(
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "lib/client.js",
      ).includes('"data-sidebar-right-session": sessionId'),
      "the right sidebar no longer carries data-sidebar-right-session",
    ).toBe(true);
  });

  it("loads chat images lazily and opens the dialog on the thumbnail's own URL", () => {
    const bundle = frontendBundle();

    const images = [
      ...bundle.matchAll(
        /\.jsx\("img",\{[^;]{0,400}?referrerPolicy:"no-referrer"/gu,
      ),
    ].map((match) => match[0]);
    expect(images.length, "no chat image renderer found").toBeGreaterThan(0);
    for (const image of images) {
      expect(
        image.includes('loading:"lazy"'),
        "a chat image is no longer lazy, so the browser may request it before the session is added",
      ).toBe(true);
    }

    const thumbnail =
      /const (\w+)=\w+\.jsx\("img",\{className:\w+\.image,src:(\w+),alt:\w+,[\s\S]{0,200}?loading:"lazy"[\s\S]{0,200}?\}\);[\s\S]{0,200}?\.jsx\("button",\{[\s\S]{0,400}?children:\1\}\),\w+&&\w+\.jsx\((\w+),\{src:\2,alt:\w+,labels:\w+\.labels,onClose/u.exec(
        bundle,
      );
    expect(
      thumbnail,
      "the chat thumbnail is no longer a button that opens a dialog on its own src",
    ).not.toBeNull();
    const dialog = thumbnail?.[3] ?? "";
    expect(
      new RegExp(
        `function ${dialog}\\(\\{src:(\\w+)[\\s\\S]{0,1000}?createPortal\\([\\s\\S]{0,600}?\\.jsx\\("img",\\{className:\\w+\\.image,src:\\1,alt:\\w+\\}\\)[\\s\\S]{0,400}?document\\.body\\)`,
        "u",
      ).test(bundle),
      "the image dialog no longer renders the given src in a portal on document.body",
    ).toBe(true);
  });
});
