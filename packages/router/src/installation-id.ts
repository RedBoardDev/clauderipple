// An installation's opaque identity, so a caller can tell which router a response came from.
//
// The admin port is not identity: two installations on one account can be configured for the same
// port (a hand-edited config, or two homes with the same listen port), and any HTTP server that
// answers `/api/status` with a version string would look like "our router". This 128-bit id lives
// in the installation's own home (never the account-wide Claude settings), is reported by the
// router's status, and is required for the CLI to accept a response as this installation's before
// it asks anything to drain (B01/D6, 2026-10-25). No home path is exposed by it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "./config.ts";

const ID = /^[a-f0-9]{32}$/;

export function installationIdPath(home: string = homeDir()): string {
  return path.join(home, "installation-id");
}

/** The id this installation recorded, or null when missing or not in the shape we write. */
export function readInstallationId(home: string = homeDir()): string | null {
  try {
    const text = fs.readFileSync(installationIdPath(home), "utf8").trim();
    return ID.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Creates the id on first use (owner-only) and returns it; an existing id is never replaced. */
export function ensureInstallationId(home: string = homeDir()): string {
  const existing = readInstallationId(home);
  if (existing) return existing;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const id = crypto.randomBytes(16).toString("hex");
  const file = installationIdPath(home);
  try {
    fs.writeFileSync(file, `${id}\n`, { mode: 0o600, flag: "wx" });
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another process created it first: use that one, so both callers agree.
    const raced = readInstallationId(home);
    if (raced) return raced;
    throw error;
  }
}
