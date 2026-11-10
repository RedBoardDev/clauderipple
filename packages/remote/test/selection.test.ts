// A selection made in a streaming answer must survive its repaint. The text arrives delta by delta,
// so the row is replaced again and again; patchList now carries the person's selection across that
// replacement by character offsets. These tests drive the real patchList and the real offsets
// through a small stand-in for the DOM the browser would provide.
import test from "node:test";
import assert from "node:assert/strict";

class FakeNode {
  nodeType = 1 as number;
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  dataset: Record<string, string> = {};
  get textContent(): string { return this.childNodes.map(child => child.textContent).join(""); }
  get children(): FakeNode[] { return this.childNodes.filter(child => child.nodeType === 1); }
  get firstElementChild(): FakeNode | null { return this.children[0] ?? null; }
  get nextElementSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    const at = siblings.indexOf(this);
    return at < 0 ? null : siblings.slice(at + 1).find(child => child.nodeType === 1) ?? null;
  }
  contains(node: FakeNode | null): boolean {
    if (!node) return false;
    return node === this || this.childNodes.some(child => child.contains(node));
  }
  remove(): void {
    const siblings = this.parentNode?.childNodes;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceWith(next: FakeNode): void {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) return;
    siblings[siblings.indexOf(this)] = next;
    next.parentNode = this.parentNode;
  }
  insertBefore(node: FakeNode, reference: FakeNode | null): void {
    const at = reference ? this.childNodes.indexOf(reference) : -1;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node);
    node.parentNode = this;
  }
}

class FakeText extends FakeNode {
  data: string;
  constructor(data: string) { super(); this.nodeType = 3; this.data = data; }
  override get textContent(): string { return this.data; }
}

/** The rendered markup in these tests is a single `<div>` around text, which is all patchList needs. */
function template(): { content: { firstElementChild: FakeNode | null }; innerHTML: string } {
  const box = {
    content: { firstElementChild: null as FakeNode | null },
    set innerHTML(html: string) {
      const text = html.replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");
      const element = new FakeNode();
      const node = new FakeText(text);
      element.childNodes.push(node);
      node.parentNode = element;
      box.content.firstElementChild = element;
    },
  };
  return box;
}

interface Placed { anchor: FakeNode | null; anchorOffset: number; focus: FakeNode | null; focusOffset: number }

/** The browser's Selection, as much of it as the code under test touches. */
interface FakeSelection {
  anchorNode: FakeNode | null; anchorOffset: number;
  focusNode: FakeNode | null; focusOffset: number;
  collapsed: boolean;
  readonly isCollapsed: boolean;
  rangeCount: number;
  setBaseAndExtent(anchor: FakeNode, anchorOffset: number, focus: FakeNode, focusOffset: number): void;
}

function installDom(): { selection: { placed: Placed[]; current: FakeSelection }; nodes: Map<string, FakeNode> } {
  const placed: Placed[] = [];
  const current: FakeSelection = {
    anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, collapsed: true,
    get isCollapsed(): boolean { return this.collapsed; },
    rangeCount: 1,
    setBaseAndExtent(anchor: FakeNode, anchorOffset: number, focus: FakeNode, focusOffset: number): void {
      const entry = { anchor, anchorOffset, focus, focusOffset };
      placed.push(entry);
      Object.assign(this, entry, { collapsed: anchor === focus && anchorOffset === focusOffset });
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true, writable: true,
    value: {
      getSelection: () => current,
      createElement: (tag: string) => tag === "template" ? template() : new FakeNode(),
    },
  });
  return { selection: { placed, current }, nodes: new Map() };
}

interface HtmlModule {
  patchList: (parent: unknown, items: readonly { key: string; ver: string }[], render: (item: { key: string; ver: string }) => string) => void;
  selectionSpan: (root: unknown) => { start: number; end: number; backward: boolean } | null;
  restoreSelection: (root: unknown, span: { start: number; end: number; backward: boolean }) => void;
}

/** html.ts touches the browser's DOM; it is loaded untyped here so this Node program (no DOM lib)
 * does not try to type-check it, exactly as the app tests load app.ts. */
const loadHtml = async (): Promise<HtmlModule> => {
  const specifier = "../web/html.ts";
  return import(specifier) as Promise<HtmlModule>;
};

test("a selection inside a replaced row is put back, so a streaming delta does not drop it", async () => {
  const dom = installDom();
  const { patchList, selectionSpan } = await loadHtml();
  const parent = new FakeNode();
  const render = (text: string) => `<div class="msg-asst">${text}</div>`;

  patchList(parent, [{ key: "a1", ver: "d1" }], item => render(item.ver === "d1" ? "첫 문장" : "첫 문장 그리고 더"));
  const row = parent.children[0]!;
  const textNode = row.childNodes[0]!;
  assert.equal(textNode.textContent, "첫 문장");

  // The person drags over part of the answer, then the next delta arrives.
  const current = dom.selection.current;
  current.anchorNode = textNode; current.anchorOffset = 0;
  current.focusNode = textNode; current.focusOffset = 4;
  current.collapsed = false;
  assert.deepEqual(selectionSpan(row), { start: 0, end: 4, backward: false });

  patchList(parent, [{ key: "a1", ver: "d2" }], item => render(item.ver === "d1" ? "첫 문장" : "첫 문장 그리고 더"));
  const next = parent.children[0]!;
  assert.notEqual(next, row, "the row is redrawn for the new text");
  assert.equal(next.textContent, "첫 문장 그리고 더");
  assert.equal(dom.selection.placed.length, 1, "the selection is placed on the new node");
  assert.equal(dom.selection.placed[0]!.anchor, next.childNodes[0], "at the same words, in the new text");
  assert.equal(dom.selection.placed[0]!.anchorOffset, 0);
  assert.equal(dom.selection.placed[0]!.focusOffset, 4);

  // No selection, no work: an untouched row is replaced exactly as before.
  current.anchorNode = null; current.focusNode = null; current.collapsed = true;
  patchList(parent, [{ key: "a1", ver: "d3" }], item => render(item.ver === "d1" ? "첫 문장" : "첫 문장 그리고 더"));
  assert.equal(dom.selection.placed.length, 1, "a collapsed selection is not restored");
});

test("a selection reaching outside the row, or one elsewhere on the page, is left alone", async () => {
  const dom = installDom();
  const { selectionSpan, restoreSelection } = await loadHtml();
  const row = new FakeNode();
  const inside = new FakeText("안쪽 문장");
  row.childNodes.push(inside); inside.parentNode = row;
  const outside = new FakeText("다른 곳");
  const other = new FakeNode();
  other.childNodes.push(outside); outside.parentNode = other;
  const current = dom.selection.current;

  // Inside the row: two offsets, an element point included (the row's own child index).
  current.anchorNode = row; current.anchorOffset = 0;
  current.focusNode = inside; current.focusOffset = 2;
  current.collapsed = false;
  assert.deepEqual(selectionSpan(row), { start: 0, end: 2, backward: false });

  // Backwards: anchor after focus keeps its direction.
  current.anchorNode = inside; current.anchorOffset = 5;
  current.focusNode = inside; current.focusOffset = 1;
  assert.deepEqual(selectionSpan(row), { start: 1, end: 5, backward: true });

  // One end outside the row is not this row's selection at all.
  current.anchorNode = inside; current.anchorOffset = 1;
  current.focusNode = outside; current.focusOffset = 2;
  assert.equal(selectionSpan(row), null);

  // Collapsed and absent selections are nothing to protect.
  current.focusNode = inside; current.focusOffset = 1; current.collapsed = true;
  assert.equal(selectionSpan(row), null);
  assert.equal(selectionSpan(row), null, "and a selection with no range at all is nothing either");

  // Restoring past the end of the text stops at the end rather than throwing.
  restoreSelection(row, { start: 0, end: 400, backward: false });
  assert.equal(dom.selection.placed.at(-1)!.focusOffset, 5, "the end of the text is where an over-long offset lands");
  dom.selection.placed.length = 0;
  restoreSelection(row, { start: 2, end: 4, backward: false });
  assert.deepEqual(dom.selection.placed[0], { anchor: inside, anchorOffset: 2, focus: inside, focusOffset: 4 });
});
