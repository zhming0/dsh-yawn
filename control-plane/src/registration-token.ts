import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The token runners present when they dial the tunnel. The control plane
 * generates it on first boot and keeps it in stateDir, so sandboxes started
 * before a restart can still register after it. Deleting the file and
 * restarting is how an operator replaces the token.
 */
export function loadRegistrationToken(stateDir: string): string {
  const path = join(stateDir, "registration-token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing !== "") {
      return existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}
