#!/usr/bin/env node

/**
 * Start a disposable dsh-yawn control plane from this checkout.
 *
 * `start` prepares a scratch `DSH_HOME` — the pinned dsh CLI, a profile that
 * points at this checkout and at a Docker sandbox profile, the socket
 * permission a sandboxed runner user needs, a free tunnel port, and the
 * address a sandbox uses to dial that tunnel — then hands the terminal to
 * `dsh web` in the foreground. The launcher's own output, including the
 * tokenized URL, is the interface, and a signal to this process goes on to the
 * launcher, so a process manager (Overmind, foreman) can own the pair.
 *
 * The acceptance steps in between are not scripted: the feature under test
 * decides what to drive with `agent-browser` and what to read back with
 * `docker exec`. `clean` removes what a run left behind — a plane still
 * running from that home and the sandboxes its sessions created.
 *
 * Usage:
 *   node scripts/dev.mjs start [--runner-image <tag>] [--control-plane-url <ws url>]
 *                              [--port <port>] [--home <dir>]
 *   node scripts/dev.mjs clean [--purge]
 *
 * `--port 0` (the default) lets the launcher pick a free port.
 * `--control-plane-url` names the tunnel URL for sandboxes instead of probing.
 */

import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Scratch home and state, kept out of the checkout so the worktree stays clean. */
const DEFAULT_HOME = "/tmp/dsh-yawn-dev";
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
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
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
  return { command, flags };
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

async function ensureDocker() {
  try {
    await run("docker", ["--version"]);
  } catch {
    throw new Error(
      "the docker CLI is not on PATH; install Docker or run this where it is",
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
    progress("dev: opening the Docker socket for this machine");
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
    progress(`dev: installing the pinned dsh CLI (${pinned})`);
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
 * A port nothing is listening on. The tunnel binds `0.0.0.0`, so an operator's
 * own control plane on the same machine would otherwise collide with this one.
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

/** IPv4 addresses this machine holds, which a sandbox may be able to dial. */
function hostAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

/**
 * The tunnel URL a sandbox dials, or undefined to leave the Docker backend's
 * own default alone.
 *
 * `host.docker.internal` is the right answer where Docker maps it to the host,
 * which is what the Docker backend assumes. It is the wrong answer for a
 * rootless daemon: there it resolves to the rootless bridge gateway, a
 * namespace this process does not bind in, and every runner fails to register
 * — the dev-only "runner did not become healthy". So bind the tunnel port
 * briefly and ask a container which address reaches it, preferring the mapped
 * name and falling back to an address this machine holds. A machine where both
 * work keeps the name, so a profile written here still reads like a
 * hand-written one. The caller's `override` answers for the probe.
 */
async function sandboxControlPlaneUrl(tunnelPort, runnerImage, override) {
  if (override !== undefined && override !== "") {
    return override;
  }
  // A port probe is not an HTTP request: the server only has to accept the
  // connection, and whatever the socket then does must not escape as an error.
  const server = createServer((socket) => socket.end());
  server.on("clientError", (_error, socket) => socket.destroy());
  const listening = await new Promise((resolve_) => {
    server.once("error", () => resolve_(false));
    server.listen(tunnelPort, "0.0.0.0", () => resolve_(true));
  });
  if (!listening) {
    return undefined;
  }
  try {
    const address = await probeFromSandbox(
      ["host.docker.internal", ...hostAddresses()],
      tunnelPort,
      runnerImage,
    );
    return address === undefined
      ? undefined
      : `ws://${address}:${tunnelPort}/tunnel`;
  } finally {
    await new Promise((resolve_) => server.close(resolve_));
  }
}

/**
 * One container's answer to "which of these addresses reaches the port", or
 * undefined when none does.
 *
 * The container is the runner image and the address mapping is the one the
 * Docker backend adds, so this asks the question the sandboxes this control
 * plane will create are about to ask. It removes itself, so it is never a
 * leftover to clean up. The image installs python3 but no netcat, so the
 * connect test is a python program with a deadline, not `nc -z`: the wrong
 * tool here answers nothing and silently leaves the default in place.
 */
async function probeFromSandbox(candidates, port, runnerImage) {
  const connect =
    "import socket,sys;" +
    "socket.setdefaulttimeout(2);" +
    "socket.create_connection((sys.argv[1],int(sys.argv[2]))).close()";
  const script = [
    'for address in "$@"; do',
    '  if python3 -c "$PROBE_CODE" "$address" "$PROBE_PORT" 2>/dev/null; then',
    '    printf %s "$address"',
    "    exit 0",
    "  fi",
    "done",
    "exit 1",
  ].join("\n");
  try {
    const { stdout } = await run(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        "--add-host",
        "host.docker.internal:host-gateway",
        "--env",
        `PROBE_CODE=${connect}`,
        "--env",
        `PROBE_PORT=${port}`,
        runnerImage,
        "-c",
        script,
        "probe",
        ...candidates,
      ],
      { timeout: 60_000 },
    );
    const address = stdout.trim();
    return candidates.includes(address) ? address : undefined;
  } catch {
    // An image without the tools to probe, or a daemon that refuses this
    // container, is not a reason to fail a run: the default may still work,
    // and `--control-plane-url` is the way out when it does not.
    return undefined;
  }
}

/** Session ids this scratch control plane created, read from its own state. */
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

/** The sandbox containers those sessions own, by the label the backend sets. */
async function sandboxNames(home) {
  const names = [];
  for (const sessionId of recordedSessionIds(home)) {
    const { stdout } = await docker([
      "ps",
      "-a",
      "--filter",
      `label=${SANDBOX_LABEL}=${sessionId}`,
      "--format",
      "{{.Names}}",
    ]);
    for (const name of stdout.trim().split("\n")) {
      if (name !== "") {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * Remove the sandboxes one home's sessions created. A sandbox is a child of
 * the Docker daemon, not of the control plane, so nothing else takes it away
 * when the plane exits — and the session records that name it live in the
 * home, which both `clean` and the next `start` are about to replace.
 */
async function removeSandboxes(home) {
  for (const name of await sandboxNames(home)) {
    try {
      await docker(["rm", "-f", name]);
      progress(`dev: removed ${name}`);
    } catch {
      // Already gone: nothing to clean up.
    }
  }
}

/** Bring up the scratch control plane, then run it until it exits. */
async function start(flags) {
  const home = resolve(flags.home ?? DEFAULT_HOME);
  const runnerImage = flags["runner-image"] ?? DEFAULT_RUNNER_IMAGE;

  const previous = readState(home);
  if (previous !== undefined && isAlive(previous.pid)) {
    throw new Error(
      `${home} is already in use by pid ${previous.pid}; run \`clean\` first`,
    );
  }

  await ensureDocker();
  await ensureRunnerImage(runnerImage);
  await ensureDshCli();

  progress("dev: building the control plane");
  await run("pnpm", ["build"]);

  // A run that ended without `clean` — Ctrl-C, a closed shell — leaves its
  // sandboxes behind, and wiping the home below loses the records that name
  // them. Clean them up while those records still exist.
  await removeSandboxes(home);

  progress(`dev: creating the scratch profile at ${home}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  await run(
    "dsh",
    ["plugin", "--profile", "web", "add", join(ROOT, "control-plane")],
    { env: { ...process.env, DSH_HOME: home } },
  );

  // An explicit stateDir keeps the credential broker and session records inside
  // the scratch home, so this never reads or writes the state of a control
  // plane the operator is actually using — which is also what makes `clean`
  // safe. The tunnel port is picked to avoid the 0.0.0.0 collision above.
  const stateDir = join(home, "state");
  const tunnelPort = await freePort();
  const controlPlaneUrl = await sandboxControlPlaneUrl(
    tunnelPort,
    runnerImage,
    flags["control-plane-url"],
  );
  progress(
    controlPlaneUrl === undefined
      ? "dev: probe found no reachable address; sandboxes keep " +
          `ws://host.docker.internal:${tunnelPort}/tunnel`
      : `dev: sandboxes dial ${controlPlaneUrl}`,
  );
  writeFileSync(
    join(home, "profiles", "web", "cordis.patch.yml"),
    [
      "# Written by scripts/dev.mjs for a disposable control plane.",
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
      ...(controlPlaneUrl === undefined
        ? []
        : [`        controlPlaneUrl: ${controlPlaneUrl}`]),
      "",
    ].join("\n"),
  );

  progress("dev: starting dsh web in the foreground");
  const child = spawn("dsh", ["web", "--no-open", "--port", flags.port ?? "0"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DSH_HOME: home },
  });
  writeFileSync(
    statePath(home),
    `${JSON.stringify(
      {
        home,
        pid: child.pid,
        runnerImage,
        stateDir,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  // A process manager or Ctrl-C signals this wrapper; pass it on so the
  // launcher goes with it instead of leaking.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  return await new Promise((resolve_, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve_(code ?? 0));
  });
}

/**
 * Remove what a home's run left behind: its plane, if one is still up, and the
 * sandboxes its sessions created. A run usually ends with Ctrl-C, so this is
 * about the leftovers that outlive it.
 */
async function clean(flags) {
  const home = resolve(flags.home ?? DEFAULT_HOME);
  const state = readState(home);
  if (state === undefined) {
    progress(`dev: nothing recorded at ${statePath(home)}`);
  } else if (isAlive(state.pid)) {
    progress(`dev: stopping dsh web (pid ${state.pid})`);
    process.kill(state.pid, "SIGTERM");
    for (let attempt = 0; attempt < 40 && isAlive(state.pid); attempt += 1) {
      await sleep(250);
    }
    if (isAlive(state.pid)) {
      process.kill(state.pid, "SIGKILL");
    }
  }

  await removeSandboxes(home);
  rmSync(statePath(home), { force: true });
  if ("purge" in flags && flags.purge !== "false") {
    rmSync(home, { recursive: true, force: true });
    progress(`dev: removed ${home}`);
  }
}

const { command, flags } = parseArguments(process.argv.slice(2));

const usage = `usage: node scripts/dev.mjs <command>

  start [--runner-image <tag>] [--control-plane-url <ws url>]
        [--port <port>] [--home <dir>]
  clean [--purge]`;

let exitCode = 0;
try {
  if (command === "start") {
    exitCode = await start(flags);
  } else if (command === "clean") {
    await clean(flags);
  } else {
    progress(usage);
    exitCode = 2;
  }
} catch (error) {
  progress(`dev: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
}

process.exit(exitCode);
