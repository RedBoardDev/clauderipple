import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";

const installer = path.resolve(import.meta.dirname, "../../../scripts/install.sh");

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-sh-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, "prefix");
  const bin = path.join(root, "tools");
  const payload = path.join(root, "payload", "node-test");
  const archive = path.join(root, "download", "node.tar.gz");
  const home = path.join(root, "home");
  for (const dir of [bin, home, path.dirname(archive), path.join(payload, "bin"), path.join(payload, "lib/node_modules/npm/bin"), path.join(prefix, "runtime/bin"), path.join(root, "tmp")]) fs.mkdirSync(dir, { recursive: true });
  const script = (file: string, body: string) => fs.writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  script(path.join(prefix, "runtime/bin/node"), 'case "$1" in -e) printf 1;; -v) printf old;; *) exit 70;; esac');
  fs.writeFileSync(path.join(prefix, "runtime/identity"), "previous-runtime");
  script(path.join(bin, "node"), "printf 0");
  script(path.join(payload, "bin/node"), 'case "$1" in -e) case "$2" in *process.versions*) printf 24;; *) /usr/bin/touch "$TEST_PREFIX/clauderipple-install.json";; esac;; -v) printf v24.0.0;; *) exec /bin/sh "$@";; esac');
  script(path.join(payload, "lib/node_modules/npm/bin/npm-cli.js"), 'if [ "$FAIL_POINT" = npm ]; then exit 74; fi\nmkdir -p "$TEST_PREFIX/bin" "$TEST_PREFIX/lib/node_modules/clauderipple/bin"\nprintf "#!/bin/sh\\nexit 99\\n" > "$TEST_PREFIX/bin/clauderipple"\nchmod +x "$TEST_PREFIX/bin/clauderipple"\ntouch "$TEST_PREFIX/lib/node_modules/clauderipple/bin/clauderipple.js"');
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", path.dirname(payload), path.basename(payload)]);
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  script(path.join(bin, "curl"), 'url=""; out=""\nwhile [ "$#" -gt 0 ]; do case "$1" in -o) shift; out="$1";; https:*) url="$1";; esac; shift; done\ncase "$url" in */index.json) printf \'[{"version":"v24.0.0"}]\';; */SHASUMS256.txt) printf "%s  node-v24.0.0-%s-%s.tar.gz\\n" "$TEST_CHECKSUM" "$TEST_OS" "$TEST_ARCH" > "$out";; *.tar.gz) /bin/cp "$TEST_ARCHIVE" "$out";; *) exit 90;; esac');
  script(path.join(bin, "mv"), 'case "$1" in *.new.*) if [ "$FAIL_POINT" = second-rename ]; then exit 73; fi;; esac\n/bin/mv "$@"\ncase "$2" in *.old.*) if [ "$FAIL_POINT" = first-rename ]; then exit 73; fi;; esac');
  script(path.join(bin, "rm"), 'case "$*" in *runtime.old.*) if [ "$FAIL_POINT" = backup-cleanup ]; then for arg in "$@"; do case "$arg" in *runtime.old.*) /bin/rm -f "$arg/bin/node";; esac; done; exit 75; fi;; esac\nexec /bin/rm "$@"');
  script(path.join(bin, "tar"), 'if [ "$FAIL_POINT" = extract ]; then exit 72; fi\nexec /usr/bin/tar "$@"');
  const osName = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const env = { HOME: home, SHELL: "/bin/sh", PATH: `${bin}:/usr/bin:/bin`, CLAUDERIPPLE_HOME: prefix, CLAUDERIPPLE_PREFIX: prefix, CLAUDE_CONFIG_DIR: path.join(root, "claude"), TMPDIR: path.join(root, "tmp"), CLAUDERIPPLE_NO_SETUP: "1", CLAUDERIPPLE_NO_TRAY: "1", TEST_PREFIX: prefix, TEST_ARCHIVE: archive, TEST_CHECKSUM: checksum, TEST_OS: osName, TEST_ARCH: arch };
  const run = (point: string) => spawnSync("/bin/sh", [installer], { env: { ...env, FAIL_POINT: point }, encoding: "utf8" });
  const preserved = () => {
    assert.equal(fs.readFileSync(path.join(prefix, "runtime/identity"), "utf8"), "previous-runtime");
    assert.equal(fs.existsSync(path.join(prefix, "runtime/bin/node")), true);
    assert.deepEqual(fs.readdirSync(prefix).filter(name => /^runtime\.(old|new)\./.test(name)), []);
  };
  return { root, prefix, home, run, preserved };
}

test("install.sh keeps the committed runtime after partial backup cleanup fails", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const result = f.run("backup-cleanup");
  // The backup is garbage beside a working install: reported on stderr, but not a reason to skip
  // PATH setup and the rest of the run.
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(f.prefix, "runtime/bin/node")), true);
  assert.equal(fs.existsSync(path.join(f.prefix, "runtime/identity")), false);
  assert.match(fs.readFileSync(path.join(f.prefix, "bin/clauderipple"), "utf8"), /exec/);
  const leftovers = fs.readdirSync(f.prefix).filter(name => name.startsWith("runtime.old."));
  assert.equal(leftovers.length, 1);
  assert.ok(result.stderr.includes(path.join(f.prefix, leftovers[0]!)), result.stderr);
  assert.match(result.stdout, /Installed\. Finish with: clauderipple install/);
  const profile = fs.readFileSync(path.join(f.home, ".profile"), "utf8");
  assert.ok(profile.includes(path.join(f.prefix, "bin")), profile);
});

for (const point of ["first-rename", "second-rename", "npm", "extract"]) {
  test(`install.sh restores the previous runtime after ${point} failure`, { skip: process.platform === "win32" }, t => {
    const f = fixture(t);
    const result = f.run(point);
    assert.equal(result.status, point === "npm" ? 74 : point.endsWith("rename") ? 73 : 1, result.stdout + result.stderr);
    f.preserved();
  });
}

test("install.sh recovers an old-only runtime on the next invocation and completes an isolated install", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  fs.renameSync(path.join(f.prefix, "runtime"), path.join(f.prefix, "runtime.old.123"));
  const result = f.run("extract");
  assert.notEqual(result.status, 0);
  f.preserved();
  const success = f.run("none");
  assert.equal(success.status, 0, success.stdout + success.stderr);
  assert.equal(fs.existsSync(path.join(f.prefix, "bin/clauderipple")), true);
  assert.deepEqual(fs.readdirSync(f.prefix).filter(name => /^runtime\.(old|new)\./.test(name)), []);
});
