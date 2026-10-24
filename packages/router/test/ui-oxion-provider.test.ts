// The provider chooser is browser code; it is evaluated from source with a minimal element stub.
// Fixed here: Oxion AI is a named tile in the OpenAI-compatible group, and opening it hands the form
// the preset whose URL/auth/wire the form prefills (no model list is fabricated).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRESETS } from "../src/presets.ts";

type Node = { tag: string; attrs: Record<string, unknown>; children: Node[]; text?: string; click?: () => void; listeners: Record<string, () => void>; addEventListener: (name: string, fn: () => void) => void; appendChild: (child: Node) => void };
type Preset = { id: string; name: string; kind?: string; anthropicBaseUrl: string; authHeader: string; modelsUrl?: string; wire?: string; fallbackModels: unknown[] };

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(here, "../../ui/app.js"), "utf8");
const fallbackSource = fs.readFileSync(path.join(here, "../../ui/presets-fallback.js"), "utf8");

function chooser(presets: Preset[]): { names: string[]; open: (name: string) => unknown } {
  const start = appSource.indexOf("function openProviderChooser");
  const end = appSource.indexOf("function inputRow");
  assert.ok(start > 0 && end > start, "app.js no longer contains the provider chooser");
  const tiles: { name: string; options: unknown }[] = [];
  const node = (tag: string, attrs: Record<string, unknown> = {}, children: (Node | null)[] = []): Node => {
    const n: Node = {
      tag, attrs, children: children.filter((c): c is Node => c !== null), listeners: {},
      addEventListener(name, fn) { n.listeners[name] = fn; },
      appendChild(child) { n.children.push(child); },
    };
    if (typeof attrs.text === "string") n.text = attrs.text;
    return n;
  };
  let openedWith: unknown;
  const make = new Function("presets", "el", "t", "chevronIcon", "showModal", "hint", "openProviderForm", `${appSource.slice(start, end)}; return openProviderChooser;`) as (...args: unknown[]) => () => void;
  const root: { grid?: Node } = {};
  make(
    presets,
    (tag: string, attrs?: Record<string, unknown>, children?: (Node | null)[]) => { const n = node(tag, attrs, children); if (attrs?.class === "chooser-grid") root.grid = n; return n; },
    (key: string) => key, () => null, () => undefined, () => null,
    (options: unknown) => { openedWith = options; },
  )();
  const walk = (n: Node): Node[] => [n, ...n.children.flatMap(walk)];
  for (const n of walk(root.grid!)) if (n.tag === "button" && n.attrs.class === "chooser-tile") {
    const title = walk(n).find((c) => c.tag === "strong")?.text ?? "";
    tiles.push({ name: title, options: n });
  }
  return {
    names: tiles.map((tile) => tile.name),
    open(name) {
      const tile = tiles.find((entry) => entry.name === name);
      assert.ok(tile, `no tile named ${name}`);
      (tile.options as Node).listeners.click?.();
      return openedWith;
    },
  };
}

test("the chooser offers Oxion AI as a named tile that opens the form with its preset", () => {
  const view = chooser(PRESETS);
  assert.ok(view.names.includes("Oxion AI"));
  const opened = view.open("Oxion AI") as { preset: Preset };
  assert.equal(opened.preset.id, "oxion");
  assert.equal(opened.preset.kind, "openai-compatible");
  assert.equal(opened.preset.anthropicBaseUrl, "https://oxionai.com/v1");
  assert.equal(opened.preset.authHeader, "authorization-bearer");
  assert.equal(opened.preset.wire, "chat");
  assert.deepEqual(opened.preset.fallbackModels, []);
});

test("the checked-in fallback catalog also yields the Oxion AI tile before /api/presets answers", () => {
  const fallback = new Function(`${fallbackSource}; return FALLBACK_PRESETS;`)() as Preset[];
  const view = chooser(fallback);
  assert.ok(view.names.includes("Oxion AI"));
  assert.equal((view.open("Oxion AI") as { preset: Preset }).preset.modelsUrl, "https://oxionai.com/v1/models");
});

test("the provider form prefills URL, auth and wire from the preset and probes /models on the preset", () => {
  assert.match(appSource, /\(preset && preset\.anthropicBaseUrl\)/);
  assert.match(appSource, /\(preset && preset\.wire\) \|\| "chat"/);
  assert.match(appSource, /d\.modelsUrl = preset\.modelsUrl; d\.modelsAuthHeader = preset\.modelsAuthHeader/);
});
