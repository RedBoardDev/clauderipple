// Putting markup into the live document. Kept apart from dom.ts: everything in that file is a string
// builder with no browser at all, so the screens and their toasts/timelines can be rendered and
// checked in Node, and only the code that touches the document needs a document.

const lastHtml = new WeakMap<Element, string>();

/**
 * Replace a region only when its markup changed. Regions re-render every second for countdowns;
 * replacing an unchanged button under a thumb between touch-down and touch-up swallows the tap.
 */
export function setHTML(el: Element | null, html: string): void {
  if (!el || lastHtml.get(el) === html) return;
  lastHtml.set(el, html);
  el.innerHTML = html;
}

/** Where a selection sits, as text offsets inside the region that holds it. */
export interface SelectionSpan { start: number; end: number; backward: boolean }

/** Every text node under `node`, in reading order, with the character its text starts at. */
function textStarts(root: Node): { nodes: Text[]; starts: Map<Node, number>; total: number } {
  const nodes: Text[] = [];
  const starts = new Map<Node, number>();
  let total = 0;
  const walk = (node: Node): void => {
    starts.set(node, total);
    if (node.nodeType === 3) { nodes.push(node as Text); total += (node.textContent ?? "").length; }
    else for (const child of Array.from(node.childNodes ?? [])) walk(child);
  };
  walk(root);
  return { nodes, starts, total };
}

/** A DOM point (a node and an offset in it) as one character offset under `root`. */
function pointOffset(root: Node, target: Node, offset: number): number | null {
  const { starts } = textStarts(root);
  if (target.nodeType === 3) {
    const start = starts.get(target);
    return start === undefined ? null : start + offset;
  }
  // An element point names a child: the offset is that child's own start.
  const child = Array.from(target.childNodes ?? [])[offset];
  if (child) return starts.get(child) ?? null;
  const start = starts.get(target);
  return start === undefined ? null : start + (target.textContent ?? "").length;
}

/**
 * The person's selection inside `root`, as character offsets, or null when there is none (or it
 * reaches outside). Used to carry a selection across a redraw: the answer a person is selecting in
 * arrives delta by delta, and replacing the node would drop the selection made in it.
 */
export function selectionSpan(root: Node): SelectionSpan | null {
  const selection = typeof document !== "undefined" && typeof document.getSelection === "function" ? document.getSelection() : null;
  if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.anchorNode || !selection.focusNode) return null;
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const anchor = pointOffset(root, selection.anchorNode, selection.anchorOffset);
  const focus = pointOffset(root, selection.focusNode, selection.focusOffset);
  if (anchor === null || focus === null) return null;
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus), backward: anchor > focus };
}

/** Put that selection back on a freshly drawn `root`. Nothing happens when the text no longer holds it. */
export function restoreSelection(root: Node, span: SelectionSpan): void {
  const selection = typeof document !== "undefined" && typeof document.getSelection === "function" ? document.getSelection() : null;
  if (!selection || typeof selection.setBaseAndExtent !== "function") return;
  const { nodes, starts } = textStarts(root);
  const point = (index: number): { node: Text; offset: number } | null => {
    let last: { node: Text; offset: number } | null = null;
    for (const node of nodes) {
      const start = starts.get(node) ?? 0;
      const length = (node.textContent ?? "").length;
      if (index <= start + length) return { node, offset: Math.max(0, Math.min(length, index - start)) };
      last = { node, offset: length };
    }
    return last;
  };
  const anchor = point(span.backward ? span.end : span.start);
  const focus = point(span.backward ? span.start : span.end);
  if (!anchor || !focus) return;
  try { selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset); }
  catch { /* a browser that cannot place it keeps the old selection */ }
}

/**
 * Keyed list patch: nodes whose key and version are unchanged stay in place (scroll position,
 * text selection and expanded state survive a streaming update); changed ones are replaced.
 * A selection inside a node being replaced is carried over to the new one, so a person reading a
 * streaming answer does not lose the text they were selecting with every delta.
 */
export function patchList<T extends { key: string; ver: string }>(parent: HTMLElement, items: readonly T[], render: (item: T) => string): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(parent.children) as HTMLElement[]) {
    const k = child.dataset.key;
    if (k) existing.set(k, child);
    else child.remove();
  }
  let cursor: Element | null = parent.firstElementChild;
  const tpl = document.createElement("template");
  for (const item of items) {
    let node = existing.get(item.key);
    if (node && node.dataset.ver !== item.ver) {
      const held = selectionSpan(node);
      tpl.innerHTML = render(item).trim();
      const fresh = tpl.content.firstElementChild as HTMLElement;
      fresh.dataset.key = item.key;
      fresh.dataset.ver = item.ver;
      node.replaceWith(fresh);
      if (cursor === node) cursor = fresh;
      node = fresh;
      if (held) restoreSelection(fresh, held);
    } else if (!node) {
      tpl.innerHTML = render(item).trim();
      node = tpl.content.firstElementChild as HTMLElement;
      node.dataset.key = item.key;
      node.dataset.ver = item.ver;
    }
    existing.delete(item.key);
    if (node !== cursor) parent.insertBefore(node, cursor);
    else cursor = cursor.nextElementSibling;
  }
  for (const stale of existing.values()) stale.remove();
}
