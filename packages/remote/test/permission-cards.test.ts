import test from "node:test";
import assert from "node:assert/strict";
import { reduce } from "../web/timeline.ts";
import { item, type UI } from "../web/views.ts";
import type { SessionEvent } from "../src/protocol.ts";

const ui = (): UI => ({ now: 1, link: { state: "open", attempt: 0, nextAt: null, lastRx: 1, downSince: null }, host: null, home: undefined, sessions: [], draft: { cwd: null, model: null, effort: null }, models: [], sheet: null, expanded: new Map(), workersOpen: false, permOpen: new Set(), toast: null, pins: [], folded: [], query: "", homeLimit: 60 });

for (const decision of ["allow", "deny", "expired"] as const) test(`a ${decision} plan can be reviewed repeatedly without presenting approval controls`, () => {
  const text = "# Exact plan\n\nFirst line\n\nLast line";
  const events: SessionEvent[] = [{ seq: 1, at: 1, kind: "permission", id: "p", tool: "ExitPlanMode", title: "Review the plan", summary: "summary", input: text, canAlways: false, requestKind: "plan" }, { seq: 2, at: 2, kind: "permission_decided", id: "p", decision }];
  const view = reduce(events);
  assert.equal(view.open.length, 0);
  const permission = view.items[0]!;
  const state = ui();
  for (const expanded of [false, true, false, true]) {
    if (expanded) state.expanded.set("p", null); else state.expanded.delete("p");
    const html = item(permission, state);
    assert.equal(html.includes("Last line"), expanded);
    assert.equal(/data-act="(?:allow|deny|always)"/.test(html), false);
    assert.ok(html.includes(`aria-expanded="${expanded}"`));
  }
});

test("a fetched completed-plan blob replaces the preview without clipping its last line", () => {
  const state = ui();
  const full = "全文\n".repeat(10000) + "END";
  state.expanded.set("p", full);
  const view = reduce([{ seq: 1, at: 1, kind: "permission", id: "p", tool: "ExitPlanMode", title: "", summary: "", input: { blob: "b", bytes: full.length, preview: "preview only" }, canAlways: false, requestKind: "plan" }, { seq: 2, at: 2, kind: "permission_decided", id: "p", decision: "allow" }]);
  const html = item(view.items[0]!, state);
  assert.ok(html.includes("END"));
  assert.ok(!html.includes("preview only"));
});
