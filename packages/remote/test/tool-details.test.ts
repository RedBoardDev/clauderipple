import test from "node:test";
import assert from "node:assert/strict";
import { activitySummary, changeCount, diffLines, numberedRead, toolDiffs, toolInput, webLinks, type SummaryRow } from "../src/tool-details.ts";
import { reduce, timelineItems } from "../web/timeline.ts";
import type { EventBody, SessionEvent } from "../src/protocol.ts";

const tool = (name: string, input: Record<string, unknown> = {}, ok: boolean | null = true): SummaryRow => ({ type: "tool", tool: { id: name, name, summary: name, input: JSON.stringify(input), ...(ok === null ? {} : { result: { ok } }) } });
const edit = (path: string, old_string: string, new_string: string): SummaryRow => ({ type: "tool", tool: { id: path, name: "Edit", summary: path, input: JSON.stringify({ file_path: path, old_string, new_string }), result: { ok: true } } });
const events = (...bodies: EventBody[]): SessionEvent[] => bodies.map((body, i) => ({ ...body, seq: i + 1, at: i }));

test("a group of two edits and two commands yields the official summary line and its +/− badge", () => {
  // Two distinct files edited (+7/−2 then +2/−1 → +9/−3) and two Bash calls.
  const rows = [edit("a.ts", "a\nb", "1\n2\n3\n4\n5\n6\n7"), edit("b.ts", "x", "y\nz"), tool("Bash"), tool("Bash")];
  assert.deepEqual(activitySummary(rows, false, "ko"), { text: "편집함 파일 2개, 실행됨 명령 2개", added: 9, removed: 3, failed: false });
  // No edits or line changes: the summary carries no badge (added = removed = 0).
  assert.deepEqual(activitySummary([tool("Bash"), tool("Read")], false, "ko"), { text: "실행됨 명령 1개, 읽음 파일 1개", added: 0, removed: 0, failed: false });
});

test("activity summary localizes kinds, running state and failure", () => {
  const rows = [tool("Bash"), tool("Read")];
  assert.deepEqual(activitySummary(rows, false, "ko"), { text: "실행됨 명령 1개, 읽음 파일 1개", added: 0, removed: 0, failed: false });
  assert.equal(activitySummary(rows, false, "en").text, "Ran a command, read a file");
  assert.equal(activitySummary([tool("Bash"), tool("Bash"), tool("Read", { file_path: "a" }), tool("Read", { file_path: "b" })], false, "en").text, "Ran 2 commands, read 2 files");
  const named = [tool("Grep"), tool("Grep"), tool("Glob"), tool("WebSearch"), tool("WebFetch", { url: "https://a" }), tool("Agent"), tool("Write", { file_path: "w" }), tool("NotebookEdit", { notebook_path: "n" }), tool("TodoWrite")];
  assert.equal(activitySummary(named, false, "ko").text, "검색함 코드, 찾음 파일, 탐색함 웹, 가져옴 페이지 1개, 실행됨 에이전트 1개, 생성됨 파일 1개, 편집함 노트북 1개, 업데이트됨 할 일");
  assert.equal(activitySummary(named, false, "en").text, "Searched code, found files, browsed the web, fetched a page, ran an agent, created a file, edited a notebook, updated todos");
  assert.equal(activitySummary([tool("Grep", {}, null)], true, "ko").text, "검색 중…");
  assert.equal(activitySummary([tool("Write", {}, null)], true, "en").text, "Editing file…");
  assert.equal(activitySummary([tool("Bash", {}, null)], true, "ko").text, "명령어 실행 중…");
  assert.equal(activitySummary([tool("Read", {}, null)], true, "en").text, "Reading file…");
  assert.equal(activitySummary([tool("Bash", {}, false)], false, "en").failed, true);
  assert.equal(activitySummary([{ type: "subagent", status: "failed" }], false, "ko").failed, true);
  assert.deepEqual(activitySummary([], false, "en"), { text: "", added: 0, removed: 0, failed: false });
});

test("activity summary counts a file or page once, shows every kind and puts the unnamed tools last", () => {
  assert.equal(activitySummary([tool("Read", { file_path: "a.ts" }), tool("Read", { file_path: "a.ts" }), tool("Read", { file_path: "b.ts" })], false, "ko").text, "읽음 파일 2개");
  assert.equal(activitySummary([tool("WebFetch", { url: "https://a" }), tool("WebFetch", { url: "https://a" })], false, "en").text, "Fetched a page");
  const kinds = [tool("mcp__x__y"), tool("Read", { file_path: "a.ts" }), tool("Bash"), tool("Grep"), tool("WebFetch", { url: "https://a" }), tool("Bash"), tool("Skill"), tool("Agent")];
  assert.equal(activitySummary(kinds, false, "ko").text, "읽음 파일 1개, 실행됨 명령 2개, 검색함 코드, 가져옴 페이지 1개, 실행됨 에이전트 1개, 사용함 도구 2개");
  assert.equal(activitySummary(kinds, false, "en").text, "Read a file, ran 2 commands, searched code, fetched a page, ran an agent, used 2 tools");
});

test("edit summaries count unique files and all supplied edits, including blob metadata", () => {
  const rows = [tool("Edit", { file_path: "a", old_string: "old\n", new_string: "new\n" }), tool("MultiEdit", { file_path: "a", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }), tool("Write", { file_path: "b", content: "" })];
  assert.deepEqual(activitySummary(rows, false, "ko"), { text: "편집함 파일 1개, 생성됨 파일 1개", added: 3, removed: 3, failed: false });
  assert.deepEqual(changeCount("Read", {}), { added: 0, removed: 0 });
  assert.deepEqual(changeCount("Write", { content: "a\nb\n" }), { added: 2, removed: 0 });
  assert.deepEqual(changeCount("Edit", { old_string: "a\nb\nc", new_string: "a\nx\nc" }), { added: 1, removed: 1 });
  const blob: SummaryRow = { type: "tool", tool: { id: "large", name: "Edit", summary: "large.ts", input: { blob: "b", preview: "{", bytes: 9000 }, changes: { added: 12, removed: 8 }, result: { ok: true } } };
  assert.deepEqual(activitySummary([blob], false, "en"), { text: "Edited a file", added: 12, removed: 8, failed: false });
});

test("unified diff preserves context, insertion/deletion line numbers and final newline changes", () => {
  assert.deepEqual(diffLines("a\nb\nc\n", "a\nx\nc\n"), [
    { kind: "context", text: "a", old: 1, next: 1 },
    { kind: "remove", text: "b", old: 2, next: null },
    { kind: "add", text: "x", old: null, next: 2 },
    { kind: "context", text: "c", old: 3, next: 3 },
  ]);
  assert.deepEqual(diffLines("", ""), []);
  assert.deepEqual(diffLines("a", ""), [{ kind: "remove", text: "a", old: 1, next: null }]);
  assert.equal(diffLines("", "a")[0]?.next, 1);
  assert.deepEqual(changeCount("Edit", { old_string: "a", new_string: "a\n" }), { added: 1, removed: 1 });
  assert.deepEqual(diffLines("a\r\nb\r\n", "a\nb\n").map(l => l.kind), ["context", "context"]);
  assert.equal(toolDiffs("MultiEdit", { file_path: "f", edits: [{ old_string: "", new_string: "x" }] })[0]?.header, "@@ -0,0 +1,1 @@");
  const before = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 1000\n", "changed\nextra\n");
  const diff = diffLines(before, after);
  assert.equal(diff.filter(l => l.kind !== "add").map(l => l.text).join("\n"), before);
  assert.equal(diff.filter(l => l.kind !== "remove").map(l => l.text).join("\n"), after);
});

test("Read offsets, legacy inputs and web titles survive presentation parsing", () => {
  assert.deepEqual(numberedRead("hello\nworld\n", { offset: 42 }), [{ number: 42, text: "hello" }, { number: 43, text: "world" }]);
  assert.deepEqual(numberedRead("  12→hello\n13\tworld", null), [{ number: 12, text: "hello" }, { number: 13, text: "world" }]);
  assert.equal(toolInput("legacy prompt"), null);
  assert.equal(toolInput("[]"), null);
  assert.deepEqual(webLinks(JSON.stringify({ results: [{ title: "Docs", url: "https://example.com/docs" }] })), [{ title: "Docs", url: "https://example.com/docs" }]);
  assert.deepEqual(webLinks("[Docs](https://example.com/docs) https://example.com/docs javascript:bad"), [{ title: "Docs", url: "https://example.com/docs" }]);
});

test("thinking deltas merge per message and block; final snapshots replace, not append", () => {
  const view = reduce(events(
    { kind: "state", state: "running" },
    { kind: "thinking", msg: "m", block: 2, text: "one", delta: true },
    { kind: "thinking", msg: "m", block: 2, text: " two", delta: true },
    { kind: "thinking", msg: "m", block: 3, text: "separate", delta: true },
    { kind: "thinking", msg: "m", block: 2, text: "complete" },
    { kind: "assistant", msg: "m", model: "test", text: "answer", tools: [] },
  ));
  assert.deepEqual(view.items.map(i => i.type), ["thinking", "thinking", "assistant"]);
  assert.ok(view.items[0]?.type === "thinking");
  assert.equal(view.items[0].text, "complete");
  assert.equal(view.items[0].streaming, false);
  assert.equal(view.items[1]?.type === "thinking" && view.items[1].text, "separate");
  const queued = reduce(events(
    { kind: "thinking", msg: "old", block: 0, text: "partial", delta: true },
    { kind: "result", ok: true, ms: 1, turns: 1 },
    { kind: "state", state: "running" },
    { kind: "thinking", msg: "new", block: 0, text: "new", delta: true },
  ));
  assert.equal(queued.items[0]?.type === "thinking" && queued.items[0].streaming, false);
  assert.equal(queued.items[2]?.type === "thinking" && queued.items[2].streaming, true);
});

test("open tool data tracks results through later assistant snapshots and worker grouping", () => {
  const call = { id: "agent", name: "Agent", summary: "Review", input: JSON.stringify({ prompt: "Review files" }) };
  const view = reduce(events(
    { kind: "assistant", msg: "m", model: "test", text: "", tools: [call] },
    { kind: "tool_result", toolUseId: "agent", ok: true, text: "first output" },
    { kind: "assistant", msg: "m", model: "test", text: "", tools: [call] },
    { kind: "tool_result", toolUseId: "agent", ok: false, text: "updated output" },
    { kind: "subagent", toolUseId: "agent", sub: "sub-agent", description: "Review", model: "test", status: "failed", steps: 2 },
  ));
  const group = timelineItems(view)[0];
  assert.ok(group?.type === "toolGroup");
  assert.equal(group.rows.length, 1);
  const row = group.rows[0];
  assert.ok(row?.type === "subagent");
  assert.equal(row.call?.input, call.input);
  assert.deepEqual(row.call?.result, { ok: false, text: "updated output" });
  assert.equal(activitySummary(group.rows, group.running, "en").text, "Ran an agent");
});

test("a widget call stands on its own between folded activity instead of joining the group", () => {
  const read = { id: "r", name: "Read", summary: "a.ts" };
  const widget = { id: "w", name: "mcp__visualize__show_widget", summary: "", input: JSON.stringify({ widget_code: "<svg></svg>" }) };
  const bash = { id: "b", name: "Bash", summary: "ls" };
  const items = timelineItems(reduce(events({ kind: "assistant", msg: "m", model: "test", text: "", tools: [read, widget, bash] })));
  assert.deepEqual(items.map(i => i.type), ["toolGroup", "assistant", "toolGroup"]);
  const shown = items[1];
  assert.ok(shown?.type === "assistant");
  assert.deepEqual(shown.tools.map(t => t.id), ["w"]);
  assert.equal(shown.text, "");
});

test("500 turns retain stable timeline keys when older pages are prepended", () => {
  const all = events(...Array.from({ length: 500 }, (_, i): EventBody[] => [
    { kind: "user", clientMsgId: `u${i}`, text: `question ${i}` },
    { kind: "assistant", msg: `a${i}`, model: "test", text: `answer ${i}`, tools: [] },
  ]).flat());
  const tail = timelineItems(reduce(all.slice(800)));
  const full = timelineItems(reduce(all));
  assert.deepEqual(full.slice(-tail.length).map(i => i.key), tail.map(i => i.key));
  assert.equal(full.length, 1000);
});
