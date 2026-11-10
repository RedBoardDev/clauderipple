import test from "node:test";
import assert from "node:assert/strict";
import { TaskPlan, nextPlan } from "../src/task-plan.ts";
import { BackgroundTasks } from "../src/desktop.ts";
import { plan } from "../web/views.ts";
import type { SessionSummary } from "../src/protocol.ts";

function accepted(tracker: TaskPlan, id: string, name: string, input: Record<string, unknown>, result = "ok", ok = true): void {
  tracker.call(id, name, input);
  tracker.result(id, ok, result);
}

test("TaskCreate, Update, List and deletion normalize exact subjects only after a successful result", () => {
  const state = new TaskPlan();
  state.call("c1", "TaskCreate", { subject: "한글 작업\n둘째 줄" });
  assert.equal(state.list.length, 0);
  state.result("c1", true, "Task #1 created successfully: 한글 작업");
  accepted(state, "c2", "TaskCreate", { subject: "Second" }, JSON.stringify({ task: { id: "2", subject: "Second", status: "pending" } }));
  accepted(state, "failed", "TaskUpdate", { taskId: "1", status: "completed" }, "failed", false);
  assert.equal(state.list[0]?.status, "pending");
  accepted(state, "start", "TaskUpdate", { taskId: "1", status: "in_progress" });
  assert.equal(state.list[0]?.text, "한글 작업\n둘째 줄");
  assert.equal(state.list[0]?.status, "in_progress");
  state.newTurn();
  assert.equal(state.list.length, 2, "session tasks survive a new human turn");
  accepted(state, "done", "TaskUpdate", { taskId: "1", status: "completed", subject: "확인한 전체 제목" });
  accepted(state, "delete", "TaskUpdate", { taskId: "2", status: "deleted" });
  assert.deepEqual(state.list, [{ id: "1", text: "확인한 전체 제목", status: "completed" }]);
  accepted(state, "list", "TaskList", {}, '{"tasks":[{"id":"3","subject":"Restored","status":"in_progress"}]}');
  assert.deepEqual(state.list, [{ id: "3", text: "Restored", status: "in_progress" }]);
  accepted(state, "bad-list", "TaskList", {}, '{"tasks":[null]}');
  assert.equal(state.list.length, 1, "unreadable results do not pretend the authoritative list is empty");
  accepted(state, "empty", "TaskList", {}, "No tasks found");
  assert.equal(state.list.length, 0);
});

test("a new turn invalidates late per-turn plan results but retains session-scoped task acknowledgements", () => {
  const state = new TaskPlan();
  state.call("old-plan", "update_plan", { plan: [{ step: "Old turn", status: "pending" }] });
  state.call("session-task", "TaskCreate", { subject: "Session task" });
  state.newTurn();
  state.result("old-plan", true, "ok");
  assert.equal(state.list.length, 0);
  accepted(state, "old-plan", "update_plan", { plan: [{ step: "Old turn again", status: "pending" }] });
  assert.equal(state.list.length, 0, "replayed calls from the retired turn remain retired");
  state.result("session-task", true, "Task #1 created successfully: Session task");
  assert.deepEqual(state.list, [{ id: "1", text: "Session task", status: "pending" }]);
});

test("TaskList understands native text output and duplicate results cannot recreate deleted tasks", () => {
  const state = new TaskPlan();
  accepted(state, "list", "TaskList", {}, "#1 [pending] First\n#2 [completed] Second");
  assert.deepEqual(state.list.map(step => [step.id, step.status]), [["1", "pending"], ["2", "completed"]]);
  accepted(state, "delete", "TaskUpdate", { taskId: "1", status: "deleted" });
  accepted(state, "list", "TaskList", {}, "#1 [pending] First\n#2 [completed] Second");
  assert.deepEqual(state.list.map(step => step.id), ["2"]);
  const copy = state.list; copy[0]!.text = "mutated";
  assert.equal(state.list[0]!.text, "Second");
});

test("TodoWrite and both update_plan contracts preserve long text, clear lists and separate turn scope", () => {
  const state = new TaskPlan();
  const text = "  전체 원문\n".repeat(200);
  accepted(state, "todo", "TodoWrite", { todos: [{ content: text, status: "in_progress" }] });
  assert.equal(state.list[0]?.text, text);
  state.newTurn(); assert.equal(state.list.length, 1);
  accepted(state, "todo-empty", "TodoWrite", { todos: [] }); assert.equal(state.list.length, 0);
  accepted(state, "openai-plan", "update_plan", { plan: [{ step: text, status: "pending" }] });
  assert.equal(state.list[0]?.text, text);
  state.newTurn(); assert.equal(state.list.length, 0);
  accepted(state, "code-plan", "mcp__ccd_turn__update_plan", { items: Array.from({ length: 30 }, (_, i) => ({ content: `${i} ${text}`, status: "pending" })) });
  assert.equal(state.list.length, 30);
  accepted(state, "advance", "mcp__ccd_turn__update_plan", { advance: true });
  assert.equal(state.list[0]?.status, "in_progress");
  accepted(state, "finish", "mcp__ccd_turn__update_plan", { done: [1], start: 2 });
  assert.deepEqual(state.list.slice(0, 2).map(step => step.status), ["completed", "in_progress"]);
  accepted(state, "plan-empty", "mcp__ccd_turn__update_plan", { items: [] }); assert.equal(state.list.length, 0);
  assert.equal(nextPlan(null, { advance: true }), null);
});

test("the Code tab's wrap_up checks its plan off, and only its plan", () => {
  // 2026-10-27 맘보: a plan set once, then wrap_up with no last advance; the phone kept "1 in progress, 0/3".
  const state = new TaskPlan();
  accepted(state, "plan", "mcp__ccd_turn__update_plan", { items: [{ content: "A", status: "in_progress" }, { content: "B", status: "pending" }, { content: "C", status: "pending" }] });
  state.call("wrap", "mcp__ccd_turn__wrap_up", { recap: "done" });
  assert.equal(state.list[0]?.status, "in_progress", "nothing moves before the wrap_up succeeds");
  state.result("wrap", true, "Shown in the next-step box.");
  assert.deepEqual(state.list.map(step => step.status), ["completed", "completed", "completed"]);
  const tasks = new TaskPlan();
  accepted(tasks, "c1", "TaskCreate", { subject: "Session task" }, "Task #1 created successfully: Session task");
  accepted(tasks, "wrap", "mcp__ccd_turn__wrap_up", { recap: "done" });
  assert.equal(tasks.list[0]?.status, "pending", "session-scoped tasks are not the Code tab's plan");
  const late = new TaskPlan();
  accepted(late, "plan", "mcp__ccd_turn__update_plan", { items: [{ content: "A", status: "in_progress" }] });
  late.call("old-wrap", "mcp__ccd_turn__wrap_up", { recap: "old" });
  late.newTurn();
  accepted(late, "next", "mcp__ccd_turn__update_plan", { items: [{ content: "Next turn", status: "in_progress" }] });
  late.result("old-wrap", true, "ok");
  assert.equal(late.list[0]?.status, "in_progress", "a retired turn's wrap_up does not finish the next turn's plan");
});

test("desktop transcript replay uses the same confirmed task lifecycle and excludes child tools", () => {
  const tracker = new BackgroundTasks();
  const lines: string[] = [];
  const send = (value: unknown) => { const line = JSON.stringify(value); lines.push(line); tracker.accept(line); };
  send({ type: "assistant", message: { content: [{ type: "tool_use", id: "create", name: "TaskCreate", input: { subject: "Exact subject" } }] } });
  send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "create", content: "Task #7 created successfully: Exact subject" }] } });
  send({ type: "assistant", isSidechain: true, message: { content: [{ type: "tool_use", id: "child", name: "TodoWrite", input: { todos: [] } }] } });
  send({ type: "user", origin: { kind: "human" }, message: { content: "Next" } });
  const replay = new BackgroundTasks(); for (const line of lines) replay.accept(line);
  assert.deepEqual(replay.plan, [{ id: "7", text: "Exact subject", status: "pending" }]);
  assert.deepEqual(replay.plan, tracker.plan);
});

test("web task snapshot displays every confirmed row and escapes exact task text", () => {
  const s: SessionSummary = { id: "s", title: "", cwd: "/", model: "m", effort: null, state: "idle", pending: 0, createdAt: 0, updatedAt: 0, lastSeq: 0, epoch: "e", plan: [{ id: "a", text: "<script>원문</script>\n둘째 줄", status: "completed" }, { id: "b", text: "Next", status: "pending" }] };
  const html = plan(s, true);
  assert.ok(html.includes("&lt;script&gt;원문&lt;/script&gt;\n둘째 줄"));
  assert.ok(html.includes('aria-expanded="true"'));
  assert.ok(html.includes("1/2"));
  assert.equal(plan({ ...s, plan: [] }, true), "");
});
