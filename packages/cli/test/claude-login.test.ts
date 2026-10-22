// Does the Claude Code CLI have a login of its own? (issue #71)
//
// SAFETY: the keychain probe is a child process against the real login keychain, so it is never
// run here: the probe is injected. process.platform is never spoofed either; the platform is a
// parameter, so what each platform does is checked without touching that platform's stores.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCodeLogin, claudeLoginHint, hasClaudeAiOauth } from "../src/claude-auth.ts";

/** A home directory with a `.claude/.credentials.json` of the given content. */
function homeWith(content: string | null): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-cli-login-"));
  if (content !== null) {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), content);
  }
  return home;
}

const noEnv: NodeJS.ProcessEnv = {};

test("a token in the environment counts as a login, and says where it is", async () => {
  for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    const login = await claudeCodeLogin({ env: { [key]: "secret-value" }, home: homeWith(null), platform: "win32", keychain: async () => false });
    assert.equal(login.ok, true, key);
    assert.match(login.where, new RegExp(key));
    assert.ok(!login.where.includes("secret-value"), "no value is ever named");
  }
});

test("the macOS keychain item counts, and its secret is never read", async () => {
  let probed = 0;
  const login = await claudeCodeLogin({
    env: noEnv,
    home: homeWith(null),
    platform: "darwin",
    keychain: async () => { probed++; return true; },
  });
  assert.equal(probed, 1);
  assert.equal(login.ok, true);
  assert.match(login.where, /keychain/i);
  assert.ok(!login.where.includes("accessToken"));
});

test("a credential file with a claudeAiOauth block counts", async () => {
  const home = homeWith(JSON.stringify({ claudeAiOauth: { accessToken: "sk-secret", refreshToken: "r", expiresAt: 1 } }));
  const login = await claudeCodeLogin({ env: noEnv, home, platform: "linux", keychain: async () => false });
  assert.equal(login.ok, true);
  assert.match(login.where, /\.credentials\.json/);
  assert.ok(!login.where.includes("sk-secret"));
});

test("a file that only holds an mcpOAuth block is not a login", async () => {
  const home = homeWith(JSON.stringify({ mcpOAuth: { accessToken: "mcp-secret" } }));
  const login = await claudeCodeLogin({ env: noEnv, home, platform: "linux", keychain: async () => false });
  assert.equal(login.ok, false);
  assert.equal(hasClaudeAiOauth(JSON.stringify({ mcpOAuth: {} })), false);
});

test("an emptied login is not a login", async () => {
  assert.equal(hasClaudeAiOauth(JSON.stringify({ claudeAiOauth: { accessToken: "", expiresAt: 0 } })), false);
  assert.equal(hasClaudeAiOauth(JSON.stringify({ claudeAiOauth: { accessToken: "sk-x" } })), true);
  assert.equal(hasClaudeAiOauth(JSON.stringify({ claudeAiOauth: {} })), true);
  assert.equal(hasClaudeAiOauth("not json"), false);
  assert.equal(hasClaudeAiOauth(null), false);
});

test("no token, no keychain item and no file means no login", async () => {
  const login = await claudeCodeLogin({ env: noEnv, home: homeWith(null), platform: "darwin", keychain: async () => false });
  assert.equal(login.ok, false);
  assert.match(login.where, /no Claude Code login/);
});

test("only macOS asks the keychain", async () => {
  let probed = 0;
  const probe = async (): Promise<boolean> => { probed++; return true; };
  for (const platform of ["win32", "linux"] as NodeJS.Platform[]) {
    const login = await claudeCodeLogin({ env: noEnv, home: homeWith(null), platform, keychain: probe });
    assert.equal(login.ok, false, platform);
  }
  assert.equal(probed, 0, "the keychain probe is macOS only");
});

test("the hint names the binary to run", () => {
  assert.match(claudeLoginHint("/Applications/Claude/claude"), /\/login.*\/Applications\/Claude\/claude/);
  assert.match(claudeLoginHint(null), /\/login/);
});
