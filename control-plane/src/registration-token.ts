import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The token runners present when they dial the tunnel, plus the predecessors
 * still accepted while the runners holding them drain. The control plane
 * generates the token itself; nothing outside supplies one.
 */
export interface RegistrationTokenView {
  current: string;
  retiring: string[];
}

interface StoredState {
  current: string;
  retiring: string[];
}

const FILE_NAME = "registration-token.json";

/**
 * Owns the tunnel credential: it persists one token on first use, hands the
 * current one to every runner the control plane starts, and can replace it
 * without dropping runners that already hold the old value.
 *
 * The accepted set is current plus retiring. A rotation mints a new current
 * and moves the old one to retiring; retiring entries are dropped only when an
 * operator says the runners holding them are gone, because a runner reads its
 * token once at boot and a warm sandbox may outlive the rotation by days.
 */
export class RegistrationTokens {
  private state: StoredState;

  constructor(private readonly stateDir: string) {
    const path = join(stateDir, FILE_NAME);
    const stored = readState(path);
    this.state = stored ?? { current: mint(), retiring: [] };
    if (stored === undefined) {
      this.persist();
    }
  }

  current(): string {
    return this.state.current;
  }

  /** Every token the tunnel still admits. */
  accepted(): string[] {
    return [this.state.current, ...this.state.retiring];
  }

  view(): RegistrationTokenView {
    return { current: this.state.current, retiring: [...this.state.retiring] };
  }

  /** Mint a new token and keep the old one accepted until retired. */
  rotate(): RegistrationTokenView {
    const retiring = [this.state.current, ...this.state.retiring];
    this.state = { current: mint(), retiring };
    this.persist();
    return this.view();
  }

  /** Stop accepting the predecessors; their runners must already be gone. */
  retire(): RegistrationTokenView {
    if (this.state.retiring.length > 0) {
      this.state = { current: this.state.current, retiring: [] };
      this.persist();
    }
    return this.view();
  }

  private persist(): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(this.stateDir, FILE_NAME),
      `${JSON.stringify(this.state)}\n`,
      { mode: 0o600 },
    );
  }
}

function mint(): string {
  return randomBytes(32).toString("hex");
}

function readState(path: string): StoredState | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as {
    current?: unknown;
    retiring?: unknown;
  } | null;
  if (
    parsed === null ||
    typeof parsed.current !== "string" ||
    parsed.current === "" ||
    !isTokenList(parsed.retiring)
  ) {
    throw new Error(`${path} does not hold a runner token`);
  }
  return { current: parsed.current, retiring: parsed.retiring };
}

function isTokenList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((token) => typeof token === "string" && token !== "")
  );
}
