import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bridgeFixture, bridgeId, line, tick } from "./bridge-fixture.ts";
import { Sessions, type CanUseTool, type QueryFn } from "../src/sessions.ts";
import { PermissionQueue } from "../src/permissions.ts";
import type { SessionEvent } from "../src/protocol.ts";
import { reduce, timelineItems } from "../web/timeline.ts";

const preamble = "The screen is borderless fullscreen (3440×1440). Please approve the next step.";
const input = { questions: [
  { question: "Which screen mode?", header: "Mode", multiSelect: false, options: [{ label: "Windowed", description: "Use a window" }, { label: "Fullscreen", description: "Keep fullscreen" }] },
  { question: "Continue?", header: "Confirm", multiSelect: false, options: [{ label: "Yes", description: "Continue" }, { label: "No", description: "Stop" }] },
] };
const text = { type: "text", text: preamble };
const tool = { type: "tool_use", id: "ask-tool", name: "AskUserQuestion", input };
const question = { type: "control_request", request_id: "ask-request", request: { subtype: "can_use_tool", tool_name: tool.name, tool_use_id: tool.id, input } };

function assertPreamble(events: SessionEvent[]): void {
  const card = events.findIndex(event => event.kind === "permission" && event.tool === tool.name);
  assert.ok(card >= 0, "the phone receives the question card");
  assert.ok(events.slice(0, card).some(event => event.kind === "assistant" && event.text === preamble), "the phone must receive the preamble before the question card, without a later transcript poll");
  const items = timelineItems(reduce(events));
  const assistant = items.findIndex(item => item.type === "assistant" && item.text === preamble);
  const permission = items.findIndex(item => item.type === "permission");
  assert.ok(assistant >= 0 && assistant < permission, "grouping preserves the paragraph above the question");
  assert.equal(items.filter(item => item.type === "assistant" && item.text === preamble).length, 1);
  const cardItem = items[permission];
  assert.ok(cardItem?.type === "permission");
  assert.deepEqual(cardItem.questions, input.questions);
}

for (const delivery of ["live", "replay"] as const) for (const split of [false, true]) {
  test(`desktop bridge emits the question preamble before approval (${delivery}, ${split ? "per-block" : "mixed"} transcript)`, async t => {
    const emitted: SessionEvent[] = [];
    const f = bridgeFixture(t, { onEvent: (_session, event) => emitted.push(event), watchTranscript: () => null });
    f.sessions.log(bridgeId);
    await tick(); await tick();
    // Desktop writes completed assistant blocks while its Remote Control permission stream
    // reaches the host before the next transcript poll (or the 80 ms watch callback).
    const record = (uuid: string, content: unknown[]) => line({ type: "assistant", uuid, sessionId: bridgeId, message: { id: "api-message", model: "claude-test", content, stop_reason: "tool_use" } });
    fs.appendFileSync(f.file, split ? record("text-record", [text]) + record("tool-record", [tool]) : record("mixed-record", [text, tool]));
    if (delivery === "live") f.emit(question);
    else {
      f.history.push({ source: "worker", payload: question });
      await f.sessions.syncBridge(bridgeId);
    }
    await tick();
    assertPreamble(emitted);
    assertPreamble(f.sessions.log(bridgeId).readAfter(0).events);
    await f.sessions.pollDesktop();
    assertPreamble(f.sessions.log(bridgeId).readAfter(0).events);
    assert.equal(emitted.filter(event => event.kind === "assistant" && event.text === preamble).length, 1, "the later poll must not emit the paragraph twice");
  });
}

for (const split of [false, true]) {
  test(`host SDK emits the question preamble before approval (${split ? "per-block" : "mixed"} assistant)`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "question-preamble-"));
    const emitted: SessionEvent[] = [];
    const waiting = Promise.withResolvers<void>();
    const queryFn: QueryFn = params => ({
      async *[Symbol.asyncIterator]() {
        for await (const _user of params.prompt) {
          yield { type: "stream_event", event: { type: "message_start", message: { id: "api-message" } } };
          yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: preamble } } };
          const message = (content: unknown[]) => ({ type: "assistant", message: { id: "api-message", model: "claude-test", content } });
          if (split) { yield message([text]); yield message([tool]); }
          else yield message([text, tool]);
          const canUseTool = params.options.canUseTool as CanUseTool;
          const abort = params.options.abortController;
          assert.ok(abort instanceof AbortController);
          const answer = canUseTool(tool.name, input, { signal: abort.signal, toolUseID: tool.id });
          waiting.resolve();
          await answer;
        }
      },
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, close() {},
    });
    const sessions = new Sessions({ dir: root, permissions: PermissionQueue.open(path.join(root, "permissions.json")), queryFn,
      router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => { throw new Error("unused"); } },
      onEvent: (_session, event) => emitted.push(event), onSessions() {},
    });
    t.after(async () => { sessions.shutdown(); await tick(); fs.rmSync(root, { recursive: true, force: true }); });
    const id = await sessions.create({ clientMsgId: "create-question", cwd: root, model: "claude-test", effort: null, text: "Change screen mode" });
    await waiting.promise;
    assertPreamble(emitted);
    assertPreamble(sessions.log(id).readAfter(0).events);
  });
}
