#!/usr/bin/env node

/**
 * A disposable dsh-yawn control plane from this checkout, for acceptance runs.
 *
 * The acceptance loop itself lives in `.agents/skills/acceptance-run`: the
 * feature under test decides which UI steps to drive with `agent-browser` and
 * what to assert in the sandbox. This script owns the parts that are the same
 * on every run — the pinned dsh CLI, a scratch `DSH_HOME` whose profile points
 * at the checkout and at a Docker sandbox profile, the socket permission a
 * sandboxed runner user needs, finding a session's sandbox container, and
 * cleanup.
 *
 * Usage:
 *   node scripts/acceptance.mjs up [--runner-image <tag>] [--home <dir>]
 *   node scripts/acceptance.mjs status
 *   node scripts/acceptance.mjs sandbox ls
 *   node scripts/acceptance.mjs sandbox exec <session-id|dsh-…> -- <command…>
 *   node scripts/acceptance.mjs down [--purge]
 *
 * `up` prints one JSON object on stdout; progress goes to stderr, so a caller
 * can parse the URL without scraping the human output.
 */

import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Scratch home and state, kept out of the checkout so the worktree stays clean. */
const DEFAULT_HOME = "/tmp/dsh-yawn-acceptance";
const DEFAULT_RUNNER_IMAGE = "dsh-yawn-runner:dev";
/** The label the Docker backend puts on every sandbox it creates. */
const SANDBOX_LABEL = "dsh.session";
const CONTROL_PLANE_PACKAGE = join(ROOT, "control-plane", "package.json");

const progress = (message) => process.stderr.write(`${message}\n`);

const sleep = (ms) => new Promise((resolve_) => setTimeout(resolve_, ms));

async function run(command, arguments_, options = {}) {
  return execFileAsync(command, arguments_, {
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

const docker = (arguments_) => run("docker", arguments_);

function parseArguments(argv) {
  const [command = "", ...rest] = argv;
  const flags = {};
  const positional = [];
  let passthrough = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--") {
      passthrough = rest.slice(index + 1);
      break;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split("=", 2);
    const next = rest[index + 1];
    if (inline !== undefined) {
      flags[name] = inline;
    } else if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = "";
    }
  }
  return { command, flags, positional, passthrough };
}

function statePath(home) {
  return join(home, "state.json");
}

function readState(home) {
  try {
    return JSON.parse(readFileSync(statePath(home), "utf8"));
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Session ids this scratch control plane knows about. Its state directory is
 * inside the scratch home, so this never sees another control plane's
 * sessions — which is what keeps `down` from removing sandboxes it did not
 * create.
 */
function recordedSessionIds(home) {
  try {
    const state = JSON.parse(
      readFileSync(join(home, "state", "sessions.json"), "utf8"),
    );
    return Object.keys(state.sessions ?? {});
  } catch {
    return [];
  }
}

/**
 * A port nothing is listening on. The tunnel binds `0.0.0.0`, so an operator's
 * own control plane on the same machine would otherwise collide with ours.
 */
function freePort() {
  return new Promise((resolve_, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const { port } = server.address();
      server.close(() => resolve_(port));
    });
  });
}

async function ensureDocker() {
  try {
    await run("docker", ["--version"]);
  } catch {
    throw new Error(
      "the docker CLI is not on PATH; the runner image ships one, so run this from a sandbox that has it, or install Docker",
    );
  }
  try {
    await docker(["info"]);
  } catch (error) {
    const text = `${error?.stderr ?? ""}${error?.message ?? ""}`;
    if (!/permission denied/.test(text)) {
      throw error;
    }
    // A sandbox mounts the host socket root-only while the sandbox user has
    // passwordless sudo; opening it is what lets a control plane running
    // inside the sandbox create sibling containers. Disposable by design.
    progress("acceptance: opening the Docker socket for this machine");
    try {
      await run("sudo", ["-n", "chmod", "666", "/var/run/docker.sock"]);
    } catch {
      throw new Error(
        "the Docker socket is not readable and sudo could not open it; " +
          "join the socket's group or run this where Docker is available",
      );
    }
    await docker(["info"]);
  }
}

async function ensureRunnerImage(image) {
  try {
    await docker(["image", "inspect", image]);
  } catch {
    throw new Error(
      `runner image ${image} is not in this Docker; build it once with ` +
        '`docker buildx bake dev --load`, pass --runner-image <tag>, or point ' +
        "at a published ghcr.io/zhming0/dsh-yawn-runner tag",
    );
  }
}

async function ensureDshCli() {
  const pinned = JSON.parse(readFileSync(CONTROL_PLANE_PACKAGE, "utf8"))
    .peerDependencies["@deepseek-ai/dsh-agent"];
  let version;
  try {
    ({ stdout: version } = await run("dsh", ["--version"]));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    progress(`acceptance: installing the pinned dsh CLI (${pinned})`);
    await run("npm", ["install", "-g", `@deepseek-ai/dsh@${pinned}`]);
    return;
  }
  if (version.trim() !== pinned) {
    throw new Error(
      `dsh ${version.trim()} is on PATH but this checkout pins ${pinned}; ` +
        `run \`npm install -g @deepseek-ai/dsh@${pinned}\``,
    );
  }
}

/**
 * Start the scratch control plane and return its state. Steps run in cheap
 * order so a missing prerequisite fails before a build.
 */
async function up(flags) {
  const home = resolve(flags.home ?? DEFAULT_HOME);
  const runnerImage = flags["runner-image"] ?? DEFAULT_RUNNER_IMAGE;

  const previous = readState(home);
  if (previous !== undefined && isAlive(previous.pid)) {
    throw new Error(
      `${previous.url} is still running from ${statePath(home)}; run \`down\` first`,
    );
  }

  await ensureDocker();
  await ensureRunnerImage(runnerImage);
  await ensureDshCli();

  progress("acceptance: building the control plane");
  await run("pnpm", ["build"]);

  progress(`acceptance: creating the scratch profile at ${home}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  await run(
    "dsh",
    ["plugin", "--profile", "web", "add", join(ROOT, "control-plane")],
    { env: { ...process.env, DSH_HOME: home } },
  );

  // An explicit stateDir keeps the credential broker and session records
  // inside the scratch home, so an acceptance run never reads or writes the
  // state of a control plane the operator is actually using.
  const stateDir = join(home, "state");
  const tunnelPort = flags["tunnel-port"] ?? (await freePort());
  writeFileSync(
    join(home, "profiles", "web", "cordis.patch.yml"),
    [
      "# Written by scripts/acceptance.mjs for a disposable acceptance run.",
      "- id: sandbox-manager",
      "  config:",
      `    stateDir: ${stateDir}`,
      "    tunnel:",
      `      port: ${tunnelPort}`,
      "      bind: 0.0.0.0",
      "    profiles:",
      "      standard:",
      "        backend: docker",
      `        image: ${runnerImage}`,
      "",
    ].join("\n"),
  );

  const log = join(home, "web.log");
  const output = openSync(log, "a");
  progress("acceptance: starting dsh web");
  const child = spawn("dsh", ["web", "--no-open", "--port", "0"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", output, output],
    env: { ...process.env, DSH_HOME: home },
  });
  child.unref();

  const url = await waitForUrl(log, child);
  const state = {
    url,
    home,
    log,
    pid: child.pid,
    runnerImage,
    stateDir,
    tunnelPort,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(statePath(home), `${JSON.stringify(state, null, 2)}\n`);

  progress(`acceptance: ${url}`);
  progress(
    "acceptance: next — install-browser, drive the UI with agent-browser, " +
      "assert with `sandbox ls` / `sandbox exec`, then `down`",
  );
  return state;
}

/** Wait for the launcher's URL line; the port is whatever it chose. */
async function waitForUrl(log, child) {
  const deadline = Date.now() + 90_000;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    const match = /dsh web: (http\S+)/.exec(text);
    if (match !== null) {
      return match[1];
    }
    if (exited) {
      throw new Error(`dsh web exited before printing a URL:\n${text}`);
    }
    await sleep(250);
  }
  throw new Error(`dsh web printed no URL within 90s; see ${log}`);
}

function status(flags) {
  const home = resolve(flags.home ?? DEFAULT_HOME);
  const state = readState(home);
  if (state === undefined) {
    return { running: false, home };
  }
  return { running: isAlive(state.pid), ...state };
}

/**
 * The sandboxes this run created. Reading the scratch home's session records
 * rather than every labelled container keeps an operator's own sandboxes out
 * of the answer, which is also what makes `down` safe.
 */
async function sandboxList(home) {
  const sandboxes = [];
  for (const sessionId of recordedSessionIds(home)) {
    const { stdout } = await docker([
      "ps",
      "-a",
      "--filter",
      `label=${SANDBOX_LABEL}=${sessionId}`,
      "--format",
      "{{.Names}}\t{{.Status}}",
    ]);
    const line = stdout.trim().split("\n")[0];
    if (line === undefined || line === "") {
      continue;
    }
    const [name, status_] = line.split("\t");
    sandboxes.push({ name, status: status_, sessionId });
  }
  return sandboxes;
}

async function sandboxContainer(target) {
  if (/^dsh-[0-9a-f]{16}$/.test(target)) {
    return target;
  }
  const { stdout } = await docker([
    "ps",
    "-a",
    "--filter",
    `label=${SANDBOX_LABEL}=${target}`,
    "--format",
    "{{.Names}}",
  ]);
  const name = stdout.trim().split("\n")[0];
  if (name === "") {
    throw new Error(`no sandbox container for session ${target}`);
  }
  return name;
}

async function sandboxExec(target, command) {
  if (target === "" || command.length === 0) {
    throw new Error(
      "sandbox exec needs a session id (or container name) and a command after `--`",
    );
  }
  const container = await sandboxContainer(target);
  await new Promise((resolve_, reject) => {
    const child = spawn("docker", ["exec", container, ...command], {
      stdio: "inherit",
    });
    child.once("exit", (code) =>
      code === 0 ? resolve_() : reject(new Error(`docker exec exited ${code}`)),
    );
  });
}

async function down(flags) {
  const home = resolve(flags.home ?? DEFAULT_HOME);
  const state = readState(home);
  if (state === undefined) {
    progress(`acceptance: nothing recorded at ${statePath(home)}`);
  } else if (isAlive(state.pid)) {
    progress(`acceptance: stopping dsh web (pid ${state.pid})`);
    process.kill(state.pid, "SIGTERM");
    for (let attempt = 0; attempt < 40 && isAlive(state.pid); attempt += 1) {
      await sleep(250);
    }
    if (isAlive(state.pid)) {
      process.kill(state.pid, "SIGKILL");
    }
  }

  const sandboxes = await sandboxList(home);
  for (const { name } of sandboxes) {
    try {
      await docker(["rm", "-f", name]);
    } catch {
      // Already gone: nothing to clean up.
    }
  }
  rmSync(statePath(home), { force: true });
  if ("purge" in flags && flags.purge !== "false") {
    rmSync(home, { recursive: true, force: true });
  }
  return {
    stopped: state?.pid ?? null,
    removedSandboxes: sandboxes.map(({ name }) => name),
    home,
  };
}

const { command, flags, positional, passthrough } = parseArguments(
  process.argv.slice(2),
);

const usage = `usage: node scripts/acceptance.mjs <command>

  up [--runner-image <tag>] [--home <dir>] [--tunnel-port <port>]
  status
  sandbox ls
  sandbox exec <session-id|dsh-…> -- <command…>
  down [--purge]`;

let result;
try {
  if (command === "up") {
    result = await up(flags);
  } else if (command === "status") {
    result = status(flags);
  } else if (command === "sandbox" && positional[0] === "ls") {
    result = await sandboxList(resolve(flags.home ?? DEFAULT_HOME));
  } else if (command === "sandbox" && positional[0] === "exec") {
    await sandboxExec(positional[1] ?? "", passthrough);
  } else if (command === "down") {
    result = await down(flags);
  } else {
    progress(usage);
    process.exit(2);
  }
} catch (error) {
  progress(`acceptance: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (result !== undefined) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
