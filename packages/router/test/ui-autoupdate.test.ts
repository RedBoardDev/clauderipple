import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8");
const block = source.slice(source.indexOf("let autoUpdateSaving ="), source.indexOf("function versionRow("));
type Harness = {
  status: { autoUpdate?: { enabled: boolean } };
  input: { disabled: boolean; checked: boolean };
  errors: string[];
  writes: Record<string, unknown>[];
  failRead: boolean;
  failWrite: boolean;
  reads: number;
  refreshes: number;
};
function ui(h: Harness): { toggleAutoUpdate(enabled: boolean): Promise<void>; autoUpdateRow(): unknown } {
  // The browser boundaries are stubbed; the production save/restore function itself runs unchanged.
  return new Function("h", `
    const status = h.status, t = key => key, document = { querySelector: () => h.input };
    let currentConfig = { stale: true };
    const api = async () => { h.reads++; if (h.failRead) throw new Error('offline'); return { providers: { untouched: true }, routes: { keep: 'me' } }; };
    const configRequest = async next => { if (h.failWrite) throw new Error('save failed'); h.writes.push(next); };
    const refreshHealth = async () => { h.refreshes++; };
    const toast = (message, error) => { if (error) h.errors.push(message); };
    const modSwitch = (key, checked) => { h.input.checked = checked; return { querySelector: () => h.input }; };
    const cell = (label, control, help) => ({label, control, help});
    ${block}
    return { toggleAutoUpdate, autoUpdateRow };
  `)(h) as { toggleAutoUpdate(enabled: boolean): Promise<void>; autoUpdateRow(): unknown };
}
function harness(): Harness {
  return { status: { autoUpdate: { enabled: true } }, input: { disabled: false, checked: true }, errors: [], writes: [], failRead: false, failWrite: false, reads: 0, refreshes: 0 };
}
test("dashboard saves only autoUpdate on a freshly read config and applies the result", async () => {
  const h = harness(); const view = ui(h);
  view.autoUpdateRow(); assert.equal(h.input.checked, true);
  const saving = view.toggleAutoUpdate(false); assert.equal(h.input.disabled, true);
  await view.toggleAutoUpdate(true); // ignored while the first save is in flight
  await saving;
  assert.equal(h.reads, 1);
  assert.deepEqual(h.writes, [{ providers: { untouched: true }, routes: { keep: "me" }, autoUpdate: false }]);
  assert.equal(h.status.autoUpdate?.enabled, false); assert.equal(h.input.checked, false); assert.equal(h.input.disabled, false);
  assert.equal(h.refreshes, 1);
});
for (const failure of ["failRead", "failWrite"] as const) {
  test(`dashboard restores the switch on ${failure} without writing stale config`, async () => {
    const h = harness(); h[failure] = true;
    await ui(h).toggleAutoUpdate(false);
    assert.deepEqual(h.writes, []); assert.deepEqual(h.errors, ["common.saveFailed"]);
    assert.equal(h.input.checked, true); assert.equal(h.input.disabled, false);
  });
}
test("a dashboard connected to a pre-feature router does not offer an ineffective switch", () => {
  const h = harness(); delete h.status.autoUpdate; ui(h).autoUpdateRow(); assert.equal(h.input.disabled, true);
});
test("all six dashboard languages provide automatic update label and help", () => {
  const translations = fs.readFileSync(new URL("../../ui/i18n.js", import.meta.url), "utf8");
  const dictionaries = new Function(`${translations.slice(0, translations.indexOf("const LANGUAGES"))}; return I18N;`)() as Record<string, Record<string, string>>;
  for (const lang of ["en", "ko", "zh", "ja", "es", "pt"]) {
    assert.ok(dictionaries[lang]?.["update.auto"]);
    assert.ok(dictionaries[lang]?.["update.autoHelp"]);
  }
  assert.equal(dictionaries.ko?.["update.auto"], "자동 업데이트");
});
