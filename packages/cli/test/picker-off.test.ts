import { test } from "node:test";
import assert from "node:assert/strict";
import { turnPickerOff, type PickerOffSteps } from "../src/picker.ts";

function steps(overrides: Partial<PickerOffSteps> = {}): { steps: PickerOffSteps; ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    steps: {
      removeAppProxy: () => (ran.push("app proxy"), true),
      disablePicker: () => (ran.push("config"), true),
      untrustCa: () => (ran.push("ca"), true),
      caStore: "the login keychain",
      ...overrides,
    },
  };
}

test("picker off removes the app proxy, turns picker.enabled off and untrusts the CA", () => {
  const t = steps();
  const lines: string[] = [];
  assert.equal(turnPickerOff(t.steps, (line) => lines.push(line)), true);
  assert.deepEqual(t.ran, ["app proxy", "config", "ca"]);
  assert.ok(lines.includes("✓ CA removed from the login keychain"));
});

// uninstall runs this before removing files: one failed step must not leave the CA trusted.
test("picker off tries every step when one fails, and says which failed", () => {
  const t = steps({ removeAppProxy: () => { throw new Error("EACCES"); } });
  const lines: string[] = [];
  assert.equal(turnPickerOff(t.steps, (line) => lines.push(line)), false);
  assert.deepEqual(t.ran, ["config", "ca"]);
  assert.ok(lines.some((line) => line.startsWith("✗ could not remove the Claude Desktop config library entry: EACCES")));
});

test("picker off with no config to change still untrusts the CA", () => {
  const t = steps({ disablePicker: () => false });
  const lines: string[] = [];
  assert.equal(turnPickerOff(t.steps, (line) => lines.push(line)), true);
  assert.deepEqual(t.ran, ["app proxy", "ca"]);
  assert.ok(!lines.includes("✓ picker.enabled = false"));
});
