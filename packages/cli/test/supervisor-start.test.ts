// #80: a supervisor that accepted "start" is not a router. On 2026-10-22 an update drained the
// router, Task Scheduler accepted the start, nothing came up, and the update still reported
// success — Claude had no router for 11h47m until the next sign-in. A start is judged by the
// process now, and when the supervisor produces none the router is started directly and said so.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startAgent as startScheduledTask } from "../src/schtasks.ts";
import { startRouter } from "../src/supervisor.ts";

/** A clock the injected waits advance, so a budget never becomes a real sleep. */
function clock(): { now: () => number; sleep: (ms: number) => void } {
  let t = 0;
  return { now: () => t, sleep: (ms: number) => void (t += ms) };
}

test("Start-ScheduledTask succeeding is 'started' only once the router's process exists", () => {
  let up = false;
  const accepted = { waitMs: 0, probe: { up: () => up, start: () => true } };
  assert.equal(startScheduledTask("ClaudeRippleCheck", accepted), "failed", "the request was accepted, the router never appeared");
  up = true;
  assert.equal(startScheduledTask("ClaudeRippleCheck", accepted), "already-running");

  // The process appears only after the request: this is the one case that is a real "started".
  let polls = 0;
  assert.equal(startScheduledTask("ClaudeRippleCheck", { waitMs: 0, probe: { up: () => polls++ > 0, start: () => true } }), "started");
  // A task whose start was refused is a failure without waiting for anything.
  assert.equal(startScheduledTask("ClaudeRippleCheck", { waitMs: 0, probe: { up: () => false, start: () => false } }), "failed");
});

test("a supervisor that says 'started' but leaves no router is caught, and the router is started directly", () => {
  const c = clock();
  const notes: string[] = [];
  const out = startRouter(
    {
      start: () => "started",
      up: () => false,
      fallback: () => 4242,
      alive: (pid) => pid === 4242,
      healthy: () => true,
      now: c.now,
      sleep: c.sleep,
    },
    { budgetMs: 2_000, onProgress: (m) => notes.push(m) },
  );
  assert.equal(out, "started-directly");
  assert.match(notes.join("\n"), /did not bring the router up; starting it directly/);
});

test("a direct child must survive startup and answer health within its budget", () => {
  for (const scenario of ["exit42", "no-health", "healthy", "dies-during-health", "late-health"]) {
    const c = clock();
    let died = false;
    let checked = 0;
    const result = startRouter({
      start: () => "failed",
      up: () => false,
      fallback: () => 42,
      alive: () => !died && (scenario !== "exit42" || c.now() < 500),
      healthy: (timeout) => {
        checked++;
        assert.ok(timeout > 0 && timeout <= 2_000 - c.now());
        if (scenario === "dies-during-health") died = true;
        if (scenario === "late-health") c.sleep(2_000);
        return scenario !== "no-health";
      },
      ...c,
    }, { budgetMs: 2_000 });
    assert.equal(result, scenario === "healthy" ? "started-directly" : "failed", scenario);
    if (scenario === "exit42") assert.equal(checked, 0, "a transient PID is not success");
  }
});

test("when the direct start also produces nothing, the start is a failure", () => {
  const c = clock();
  const ops = { start: () => "started" as const, up: () => false, fallback: () => 77, alive: () => false, now: c.now, sleep: c.sleep };
  assert.equal(startRouter(ops, { budgetMs: 0 }), "failed");

  // A supervisor that cannot even be asked is still worth trying the direct path for; if it is
  // refused too, the answer stays failure.
  const threw = { start: () => { throw new Error("access denied"); }, up: () => false, fallback: () => null, alive: () => false, now: c.now, sleep: c.sleep };
  assert.equal(startRouter(threw, { budgetMs: 0 }), "failed");
});

test("where the supervisor relaunches the router itself, a start that brings none up is a failure, never a second router", () => {
  const c = clock();
  const notes: string[] = [];
  // launchd and systemd: no fallback is offered, since a router beside them would fight their relaunch.
  const out = startRouter({ start: () => "started", up: () => false, alive: () => false, now: c.now, sleep: c.sleep }, { budgetMs: 1_000, onProgress: (m) => notes.push(m) });
  assert.equal(out, "failed");
  assert.deepEqual(notes, []);
});

test("a start the supervisor really made is not repeated", () => {
  const c = clock();
  let checks = 0;
  let fellBack = false;
  const out = startRouter(
    {
      start: () => "started",
      up: () => checks++ > 0,
      fallback: () => {
        fellBack = true;
        return null;
      },
      alive: () => true,
      now: c.now,
      sleep: c.sleep,
    },
    { budgetMs: 1_000 },
  );
  assert.equal(out, "started");
  assert.equal(fellBack, false);
});
