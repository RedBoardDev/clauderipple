// Pure tool presentation data. Shared by host serialization, web and native; no platform imports.
import type { Text, ToolCall } from "./protocol.ts";

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function toolInput(value: Text | undefined): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try { return record(JSON.parse(value)); } catch { return null; } // Legacy tools may store a plain prompt, not JSON.
}
export const stringField = (input: Record<string, unknown> | null, key: string): string => typeof input?.[key] === "string" ? input[key] : "";

export interface DiffLine { kind: "context" | "add" | "remove"; text: string; old: number | null; next: number | null }
export interface ChangeCount { added: number; removed: number }
export interface ToolDiff { path: string; header: string; lines: DiffLine[] }
function lines(text: string): string[] {
  if (!text) return [];
  const list = text.replace(/\r\n/g, "\n").split("\n");
  if (list.at(-1) === "") list.pop();
  return list;
}

/** A linear-space line diff. Common edges are peeled before finding the next shared line,
 * avoiding an N×M matrix for large writes. Equal-distance anchors prefer removals. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before), b = lines(after);
  const positions = new Map<string, number[]>();
  b.forEach((line, i) => { const at = positions.get(line) ?? []; at.push(i); positions.set(line, at); });
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  const remove = () => out.push({ kind: "remove", text: a[i]!, old: ++i, next: null });
  const add = () => out.push({ kind: "add", text: b[j]!, old: null, next: ++j });
  const context = () => out.push({ kind: "context", text: a[i]!, old: ++i, next: ++j });
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { context(); continue; }
    let anchor: { i: number; j: number; distance: number } | null = null;
    for (let k = i; k < a.length; k++) {
      if (anchor && k - i > anchor.distance) break;
      const candidates = positions.get(a[k]!);
      if (!candidates) continue;
      // Binary search: the same repeated line can occur thousands of times.
      let lo = 0, hi = candidates.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (candidates[mid]! < j) lo = mid + 1; else hi = mid; }
      const next = candidates[lo];
      if (next === undefined) continue;
      const distance = k - i + next - j;
      if (!anchor || distance < anchor.distance) anchor = { i: k, j: next, distance };
    }
    if (!anchor) { while (i < a.length) remove(); while (j < b.length) add(); break; }
    while (i < anchor.i) remove();
    while (j < anchor.j) add();
  }
  while (i < a.length) remove();
  while (j < b.length) add();
  // A changed final newline is a real edit, even if every visible line is equal.
  if (before !== after && before.endsWith("\n") !== after.endsWith("\n") && a.length && b.length && a.at(-1) === b.at(-1)) {
    const last = out.at(-1);
    if (last?.kind === "context") out.splice(out.length - 1, 1,
      { kind: "remove", text: last.text + (before.endsWith("\n") ? "" : "\n\\ No newline at end of file"), old: last.old, next: null },
      { kind: "add", text: last.text + (after.endsWith("\n") ? "" : "\n\\ No newline at end of file"), old: null, next: last.next });
  }
  return out;
}

export function toolDiffs(name: string, input: Record<string, unknown> | null): ToolDiff[] {
  if (!input || !["Edit", "MultiEdit", "Write"].includes(name)) return [];
  const path = stringField(input, "file_path") || stringField(input, "path") || "file";
  const edits = name === "MultiEdit" && Array.isArray(input.edits) ? input.edits.map(record).filter(e => e !== null) : [input];
  return edits.map(edit => {
    const before = name === "Write" ? stringField(edit, "old_content") : stringField(edit, "old_string");
    const after = name === "Write" ? stringField(edit, "content") : stringField(edit, "new_string");
    const diff = diffLines(before, after);
    return { path, header: `@@ -${before ? 1 : 0},${lines(before).length} +${after ? 1 : 0},${lines(after).length} @@`, lines: diff };
  });
}
export function changeCount(name: string, input: Record<string, unknown> | null): ChangeCount {
  return toolDiffs(name, input).flatMap(d => d.lines).reduce((sum, line) => ({
    added: sum.added + Number(line.kind === "add"), removed: sum.removed + Number(line.kind === "remove"),
  }), { added: 0, removed: 0 });
}

export interface ActivityTool extends ToolCall { result?: { ok: boolean } }
export type SummaryRow = { type: "tool"; tool: ActivityTool } | { type: "subagent"; status: "running" | "done" | "failed" };
// The kinds and their words follow the Claude desktop app's transcript bundle (read 2026-10-24),
// as the desktop mod's Agents pane does (packages/mod/hooks/ui/tools.ts `runSummary`). A Write is
// "created": a call's result does not tell a file it replaced.
type Kind = "command" | "read" | "write" | "edit" | "notebook" | "grep" | "glob" | "browse" | "fetch" | "agent" | "todo" | "other";
function kindOf(name: string): Kind {
  if (["Bash", "BashOutput", "KillShell"].includes(name)) return "command";
  if (name === "Read") return "read";
  if (name === "Write") return "write";
  if (["Edit", "MultiEdit"].includes(name)) return "edit";
  if (name === "NotebookEdit") return "notebook";
  if (name === "Grep") return "grep";
  if (name === "Glob") return "glob";
  if (name === "WebSearch") return "browse";
  if (name === "WebFetch") return "fetch";
  if (["Task", "Agent"].includes(name)) return "agent";
  if (name === "TodoWrite") return "todo";
  return "other";
}
/** Kinds counted by what they acted on (a file, a page), not by call. */
const byTarget: ReadonlySet<Kind> = new Set(["read", "write", "edit", "notebook", "fetch"]);
const plural = (n: number, one: string, many: string) => n === 1 ? one : `${n} ${many}`;
// The kinds the app words with no count ("검색함 코드") take none.
const completed: Record<"ko" | "en", Record<Kind, (n: number) => string>> = {
  ko: {
    command: n => `실행됨 명령 ${n}개`, read: n => `읽음 파일 ${n}개`, write: n => `생성됨 파일 ${n}개`, edit: n => `편집함 파일 ${n}개`,
    notebook: n => `편집함 노트북 ${n}개`, grep: () => "검색함 코드", glob: () => "찾음 파일", browse: () => "탐색함 웹",
    fetch: n => `가져옴 페이지 ${n}개`, agent: n => `실행됨 에이전트 ${n}개`, todo: () => "업데이트됨 할 일", other: n => `사용함 도구 ${n}개`,
  },
  en: {
    command: n => `ran ${plural(n, "a command", "commands")}`, read: n => `read ${plural(n, "a file", "files")}`,
    write: n => `created ${plural(n, "a file", "files")}`, edit: n => `edited ${plural(n, "a file", "files")}`,
    notebook: n => `edited ${plural(n, "a notebook", "notebooks")}`, grep: () => "searched code", glob: () => "found files",
    browse: () => "browsed the web", fetch: n => `fetched ${plural(n, "a page", "pages")}`, agent: n => `ran ${plural(n, "an agent", "agents")}`,
    todo: () => "updated todos", other: n => `used ${plural(n, "a tool", "tools")}`,
  },
};
const active = {
  ko: { command: "명령어 실행 중…", read: "파일 읽는 중…", edit: "파일 편집 중…", search: "검색 중…", web: "웹 검색 중…", agent: "에이전트 실행 중…", other: "도구 실행 중…" },
  en: { command: "Running command…", read: "Reading file…", edit: "Editing file…", search: "Searching…", web: "Searching the web…", agent: "Running agent…", other: "Running tool…" },
};
const activeOf: Record<Kind, keyof typeof active.ko> = {
  command: "command", read: "read", write: "edit", edit: "edit", notebook: "edit", grep: "search", glob: "search",
  browse: "web", fetch: "web", agent: "agent", todo: "other", other: "other",
};
/**
 * Like the Claude app: kinds in the order they first appear but the unnamed tools ("사용함 도구 N개")
 * last, every kind shown, a file or page counted once, the first word capitalised.
 */
export function activitySummary(rows: readonly SummaryRow[], running: boolean, language: "ko" | "en"): ChangeCount & { text: string; failed: boolean } {
  const targets = new Map<Kind, Set<string>>();
  let added = 0, removed = 0, failed = false, pending: Kind | null = null;
  rows.forEach((row, i) => {
    const kind = row.type === "subagent" ? "agent" : kindOf(row.tool.name);
    const input = row.type === "tool" ? toolInput(row.tool.input) : null;
    const target = row.type === "tool" && byTarget.has(kind)
      ? stringField(input, "file_path") || stringField(input, "notebook_path") || stringField(input, "path") || stringField(input, "url") || row.tool.summary : "";
    const seen = targets.get(kind) ?? new Set<string>();
    seen.add(target || `#${i}`);
    targets.set(kind, seen);
    if (row.type === "subagent") { failed ||= row.status === "failed"; if (row.status === "running") pending = kind; return; }
    failed ||= row.tool.result?.ok === false;
    if (!row.tool.result) pending = kind;
    const changes = row.tool.changes ?? changeCount(row.tool.name, input);
    added += changes.added; removed += changes.removed;
  });
  // A stable sort: the named kinds keep the order they came in, the unnamed tools go after them.
  const kinds = [...targets.keys()].sort((a, b) => Number(a === "other") - Number(b === "other"));
  const line = kinds.map(kind => completed[language][kind](targets.get(kind)!.size)).join(", ");
  const text = running && pending ? active[language][activeOf[pending]] : line.charAt(0).toLocaleUpperCase(language) + line.slice(1);
  return { text, added, removed, failed };
}

export function numberedRead(text: string, input: Record<string, unknown> | null): { number: number; text: string }[] {
  const offset = typeof input?.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : 1;
  return lines(text).map((line, i) => {
    const match = /^\s*(\d+)[→\t](.*)$/.exec(line);
    return match ? { number: Number(match[1]), text: match[2]! } : { number: offset + i, text: line };
  });
}
export function pretty(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
export function webLinks(text: string): { title: string; url: string }[] {
  const out = new Map<string, string>();
  const add = (url: string, title: string) => { if (/^https?:\/\//.test(url)) out.set(url, title || url); };
  function walk(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const obj = record(value);
    if (!obj) return;
    const url = stringField(obj, "url") || stringField(obj, "link");
    if (url) add(url, stringField(obj, "title") || stringField(obj, "name"));
    Object.values(obj).forEach(v => { if (typeof v === "object") walk(v); });
  }
  try { walk(JSON.parse(text)); } catch { /* Text/Markdown output is normal. */ }
  for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) add(match[2]!, match[1]!);
  for (const match of text.matchAll(/https?:\/\/[^\s<>"\])]+/g)) { const url = match[0].replace(/[.,;]+$/, ""); if (!out.has(url)) add(url, url); }
  return [...out].map(([url, title]) => ({ title, url }));
}
