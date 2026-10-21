import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeUsage, claudeUsageFromBody } from "../src/providers/anthropic-usage.ts";

// Shape measured 2026-09-28 from GET /api/oauth/usage.
const BODY = {
  five_hour: { utilization: 14.0, resets_at: "2026-09-28T08:30:00.581181+00:00", limit_dollars: null },
  seven_day: { utilization: 10.0, resets_at: "2026-10-01T11:00:00.581203+00:00" },
  seven_day_opus: null,
};

test("the usage body maps onto the Codex snapshot shape the GUI already reads", () => {
  const q = claudeUsageFromBody(BODY) as { type: string; rate_limits: { primary: Record<string, number>; secondary: Record<string, number> } };
  assert.equal(q.type, "claude.usage");
  assert.deepEqual(q.rate_limits.primary, { used_percent: 14, window_minutes: 300, reset_at: Math.round(Date.parse("2026-09-28T08:30:00.581Z") / 1000) });
  assert.equal(q.rate_limits.secondary.used_percent, 10);
  assert.equal(q.rate_limits.secondary.window_minutes, 7 * 24 * 60);
  assert.equal(claudeUsageFromBody({ five_hour: null, seven_day: null }), null);
  assert.equal(claudeUsageFromBody(null), null);
});

test("weekly_scoped entries ride beside rate_limits for the mod's per-model row", () => {
  const body = {
    ...BODY,
    limits: [
      // Shape measured 2026-10-15.
      { kind: "weekly_scoped", group: "weekly", percent: 2, severity: "normal", resets_at: "2026-10-15T10:59:59.851460+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 41, severity: "normal", resets_at: "2026-10-15T10:59:59.851460+00:00", scope: { model: { id: null, display_name: "Opus" }, surface: null }, is_active: true },
      // Other kinds, nameless models and unusable percents are left out.
      { kind: "daily_scoped", group: "daily", percent: 9, scope: { model: { display_name: "Daily" } } },
      { kind: "weekly_scoped", group: "weekly", percent: 3, scope: { model: { id: null, display_name: null } } },
      { kind: "weekly_scoped", group: "weekly", percent: "many", scope: { model: { display_name: "Vague" } } },
      null,
    ],
  };
  const q = claudeUsageFromBody(body) as { scoped: Record<string, number | string>[] };
  const resetAt = Math.round(Date.parse("2026-10-15T10:59:59.851460+00:00") / 1000);
  assert.deepEqual(q.scoped, [
    { name: "Fable", used_percent: 2, window_minutes: 10080, reset_at: resetAt },
    { name: "Opus", used_percent: 41, window_minutes: 10080, reset_at: resetAt },
  ]);
  // Without scoped entries the snapshot keeps its old shape exactly.
  const plain = claudeUsageFromBody(BODY) as Record<string, unknown>;
  assert.equal(Object.hasOwn(plain, "scoped"), false);
  assert.deepEqual(Object.keys(plain).sort(), ["at", "rate_limits", "type"]);
});

test("each account is asked once per interval with its own headers, and a failure keeps the last numbers", async () => {
  let now = 1_000_000;
  const calls: string[] = [];
  let fail = false;
  const usage = new ClaudeUsage(
    {
      credentials: async () => [
        { id: "current:aa", ownerId: "current", headers: { authorization: "Bearer one" } },
        { id: "acct:bb", ownerId: "acct", headers: { authorization: "Bearer two" } },
      ],
    },
    {
      upstream: () => "api.anthropic.com",
      now: () => now,
      ttlMs: 60_000,
      fetch: async (url, init) => {
        calls.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
        return fail ? new Response("no", { status: 500 }) : Response.json(BODY);
      },
    },
  );
  const first = await usage.snapshot();
  assert.deepEqual(Object.keys(first).sort(), ["acct", "current"]);
  assert.deepEqual(calls.sort(), ["https://api.anthropic.com/api/oauth/usage Bearer one", "https://api.anthropic.com/api/oauth/usage Bearer two"]);

  await usage.snapshot();
  assert.equal(calls.length, 2, "within the interval nothing is fetched");

  now += 61_000;
  fail = true;
  const kept = await usage.snapshot();
  assert.equal(calls.length, 4);
  assert.deepEqual(Object.keys(kept).sort(), ["acct", "current"], "a failed lookup keeps the last good numbers");
});

test("refresh bypasses TTL, shares in-flight work, and retries only the failed owner once after 15s", async () => {
  let now = 1_000_000;
  const calls: Record<string, number> = {};
  let fail = false;
  let release: (() => void) | undefined;
  let gate: Promise<void> = Promise.resolve();
  const usage = new ClaudeUsage({ credentials: async () => ["current", "other"].map((id) => ({ id, headers: { owner: id } })) }, {
    upstream: () => "api.anthropic.com", now: () => now,
    fetch: async (_url, init) => {
      const owner = (init.headers as Record<string, string>).owner!;
      calls[owner] = (calls[owner] ?? 0) + 1;
      await gate;
      return fail && owner === "other" ? new Response("no", { status: 503 }) : Response.json(BODY);
    },
  });
  const first = await usage.snapshot();
  assert.equal(first.other?.at, now);
  await usage.snapshot();
  assert.deepEqual(calls, { current: 1, other: 1 });
  fail = true;
  gate = new Promise<void>((resolve) => { release = resolve; });
  const forced = usage.snapshot(true);
  assert.equal(usage.snapshot(true), forced, "forced requests join one lookup");
  assert.equal(usage.snapshot(), forced, "ordinary polls join it too");
  release!();
  const failed = await forced;
  assert.equal(failed.other?.stale, true);
  assert.equal(failed.other?.at, first.other?.at, "a failure never changes the successful-fetch timestamp");
  now += 14_999;
  await usage.snapshot();
  assert.deepEqual(calls, { current: 2, other: 2 });
  now += 1;
  await usage.snapshot();
  assert.deepEqual(calls, { current: 2, other: 3 }, "only the failed owner is retried");
  now += 15_000;
  await usage.snapshot();
  assert.equal(calls.other, 3, "a second failure returns to the full TTL rather than looping");
  fail = false;
  now += 300_000;
  const recovered = await usage.snapshot();
  assert.equal(recovered.other?.stale, undefined);
  assert.equal(recovered.other?.at, now);
});

test("a credential-source failure also keeps stale data and gets one short retry", async () => {
  let now = 0;
  let fail = false;
  let calls = 0;
  const usage = new ClaudeUsage({ credentials: async () => {
    calls++;
    if (fail) throw new Error("unavailable");
    return [{ id: "current", headers: {} }];
  } }, { upstream: () => "api.anthropic.com", now: () => now, fetch: async () => Response.json(BODY) });
  await usage.snapshot();
  fail = true;
  now = 300_000;
  assert.equal((await usage.snapshot()).current?.stale, true);
  now += 15_000;
  await usage.snapshot();
  assert.equal(calls, 3);
  now += 15_000;
  await usage.snapshot();
  assert.equal(calls, 3);
});

test("a removed account drops out of the snapshot", async () => {
  let now = 0;
  let owners = ["current", "gone"];
  const usage = new ClaudeUsage(
    { credentials: async () => owners.map((ownerId) => ({ id: `${ownerId}:x`, ownerId, headers: {} })) },
    { upstream: () => "api.anthropic.com", now: () => now, ttlMs: 1, fetch: async () => Response.json(BODY) },
  );
  assert.deepEqual(Object.keys(await usage.snapshot()).sort(), ["current", "gone"]);
  owners = ["current"];
  now += 10;
  assert.deepEqual(Object.keys(await usage.snapshot()), ["current"]);
});
