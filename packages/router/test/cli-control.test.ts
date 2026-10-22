import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli, startCliDetached, parseUpdateCheck } from "../src/cli-control.ts";

test("shared CLI boundary uses isolated runtime, pinned env, detached log and exit status", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-cli-control-"));
  const previous = process.env.CLAUDERIPPLE_HOME;
  process.env.CLAUDERIPPLE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDERIPPLE_HOME;
    else process.env.CLAUDERIPPLE_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const cli = path.join(home, "fake-cli.cjs");
  // This fixture never imports the installer or invokes a supervisor.
  fs.writeFileSync(cli, 'console.log(JSON.stringify({args:process.argv.slice(2), home:process.env.CLAUDERIPPLE_HOME, spec:process.env.CLAUDERIPPLE_PACKAGE})); process.exitCode=Number(process.argv[2]) || 0;');
  const paths = path.join(home, "paths.json");
  fs.writeFileSync(paths, JSON.stringify({ node: process.execPath, cli }));
  const result = await runCli(["check"], 1000);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output).args, ["check"]);
  assert.equal(JSON.parse(result.output).home, home);
  const log = path.join(home, "logs", "update.log");
  const child = startCliDetached(["7"], log, { CLAUDERIPPLE_PACKAGE: "clauderipple@1.2.3" });
  assert.ok(child.pid);
  assert.equal((await child.completion).ok, false);
  const output = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.equal(output.spec, "clauderipple@1.2.3");
  assert.equal(output.home, home);
  fs.writeFileSync(paths, JSON.stringify({ node: path.join(home, "missing-node"), cli }));
  const failed = await startCliDetached(["update"], log).completion;
  assert.equal(failed.ok, false); assert.match(failed.output, /ENOENT/);
  fs.writeFileSync(paths, "invalid runtime");
  await assert.rejects(runCli(["check"]));
});
test("update parser rejects malformed values instead of trusting CLI noise", () => {
  for (const value of ["null", "[]", "{}", '{"current":1}', "network down"]) assert.equal(parseUpdateCheck(value), null);
  assert.deepEqual(parseUpdateCheck('warning\n{"current":"1.0.0","latest":"1.1.0","newer":true,"kind":"npm"}\n'), { current: "1.0.0", latest: "1.1.0", newer: true, kind: "npm" });
});
