import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLimitsAccount, weeklyPace, type UsageWindow } from "../src/limits.ts";

const WEEK = 7 * 24 * 60 * 60_000;
const now = Date.parse("2026-10-21T12:00:00Z");
const weekly = (usedPercent: number, resetAt = now + WEEK / 2): UsageWindow => ({ usedPercent, resetAt, windowMinutes: 10080 });

test("weekly pace compares consumption with elapsed time and does not clamp usage above 100%", () => {
  assert.deepEqual(weeklyPace(weekly(70), now), { expectedPercent: 50, paceDelta: 20 });
  assert.deepEqual(weeklyPace(weekly(20), now), { expectedPercent: 50, paceDelta: -30 });
  assert.deepEqual(weeklyPace(weekly(125), now), { expectedPercent: 50, paceDelta: 75 });
  assert.deepEqual(weeklyPace(weekly(30, now + WEEK * 2), now), { expectedPercent: 0, paceDelta: 30 });
  assert.deepEqual(weeklyPace(weekly(30, now - 1), now), { expectedPercent: 100, paceDelta: -70 });
  assert.equal(weeklyPace(undefined, now), null);
  assert.equal(weeklyPace({ usedPercent: 10, windowMinutes: 10080 }, now), null);
  assert.equal(weeklyPace(weekly(10, NaN), now), null);
  assert.equal(weeklyPace(weekly(Infinity), now), null);
});

test("the additive projection preserves legacy windows and identifies durations, not their position", () => {
  const windows = [
    { kind: "seven_day" as const, used_percent: 125, window_minutes: 10080, reset_at: (now + WEEK / 2) / 1000 },
    { kind: "five_hour" as const, used_percent: 23, window_minutes: 300, reset_at: (now + 3600_000) / 1000 },
    { kind: "scoped" as const, label: "Fable", used_percent: 2, window_minutes: 10080 },
  ];
  const account = buildLimitsAccount({ id: "work", label: "Work", preferred: true, active: false, health: { state: "cooling", pausedUntil: now + 60_000 } }, 1, windows, { at: now }, now, 300_000);
  assert.deepEqual(account.windows, windows);
  assert.equal(account.account, 1);
  assert.equal(account.at, now);
  assert.equal(account.id, "work");
  assert.equal(account.preferred, true);
  assert.equal(account.active, false);
  assert.equal(account.health?.state, "paused-until");
  assert.equal(account.health?.pausedUntil, now + 60_000);
  assert.equal(account.usageWindows?.fiveHour?.usedPercent, 23);
  assert.equal(account.usageWindows?.fiveHour?.resetAt, now + 3600_000);
  assert.equal(account.usageWindows?.weekly?.usedPercent, 125, "a scoped weekly never replaces the account's weekly");
  assert.deepEqual(account.weeklyPace, { expectedPercent: 50, paceDelta: 75 });
  assert.equal(account.fetchedAt, now);
  assert.equal(account.stale, false);
  assert.equal(account.unknown, false);
});

test("accounts without data remain unknown/stale; failures and old snapshots remain stale", () => {
  const details = { id: "empty", label: "Other account", preferred: false, active: true, health: { state: "quarantined" } };
  const empty = buildLimitsAccount(details, 0, [], null, now, 300_000);
  assert.deepEqual(empty.usageWindows, {});
  assert.deepEqual(empty.windows, []);
  assert.equal(empty.fetchedAt, null);
  assert.equal(empty.weeklyPace, null);
  assert.equal(empty.unknown, true);
  assert.equal(empty.stale, true);
  assert.equal(empty.health?.state, "needs-login");
  const windows = [{ kind: "seven_day" as const, used_percent: 12, window_minutes: 10080 }];
  const build = (quota: Record<string, unknown>) => buildLimitsAccount(details, 0, windows, quota, now, 300_000);
  assert.equal(build({ at: now - 300_000 }).stale, true);
  assert.equal(build({ at: now, stale: true }).stale, true);
  assert.equal(build({ at: NaN }).fetchedAt, null);
  assert.equal(build({ at: now }).weeklyPace, null, "no guessed pace without resetAt");
});
