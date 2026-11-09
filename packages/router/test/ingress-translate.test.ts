import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ResponsesEventMapper,
  claudeSupportsEffort,
  chatToAnthropic,
  responsesEventsToChatChunks,
  responsesToAnthropic,
} from "../src/ingress/translate.ts";

const request = {
  model: "claude-sonnet-5",
  instructions: "Be concise.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { type: "function_call", call_id: "call_a", name: "Read", arguments: '{"file_path":"a.ts"}' },
    { type: "function_call_output", call_id: "call_a", output: "file contents" },
    { type: "reasoning", summary: [] },
  ],
  tools: [{ type: "function", name: "Read", description: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } }],
  tool_choice: { type: "function", name: "Read" },
  reasoning: { effort: "high" },
  max_output_tokens: 123,
  temperature: 0.2,
  stream: true,
};

test("Responses request becomes cache-friendly Anthropic Messages request", () => {
  const out = responsesToAnthropic(request, "claude-sonnet-5");
  assert.equal(out.system?.[0]?.text, "Be concise.");
  assert.deepEqual(out.system?.[0]?.cache_control, { type: "ephemeral" });
  assert.equal(out.messages.length, 3, "reasoning item is deliberately dropped");
  assert.equal(out.messages[0]?.content[1]?.type, "image");
  assert.deepEqual(out.messages[1]?.content[0], { type: "tool_use", id: "call_a", name: "Read", input: { file_path: "a.ts" } });
  assert.equal(out.messages[2]?.content[0]?.type, "tool_result");
  assert.deepEqual((out.messages[2]?.content[0] as { cache_control?: unknown }).cache_control, { type: "ephemeral" });
  assert.equal(out.tools?.[0]?.cache_control?.type, "ephemeral");
  assert.deepEqual(out.tool_choice, { type: "tool", name: "Read" });
  assert.deepEqual(out.output_config, { effort: "high" });
  assert.equal(out.max_tokens, 123);
});

// Issue #104: Codex's remote compaction appends the control item `{"type":"compaction_trigger"}`
// after the whole transcript, so the transcript itself still ends with the assistant's last turn.
// Anthropic rejects that shape ("This model does not support assistant message prefill").
const compactRequest = {
  model: "claude-opus-5",
  instructions: "You are Codex.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "add a test" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "I added it." }] },
    { type: "compaction_trigger" },
  ],
  max_output_tokens: 16,
};

test("Codex compaction trigger becomes the user turn that asks for the summary", () => {
  const out = responsesToAnthropic(compactRequest, "claude-opus-5");
  assert.equal(out.messages.at(-1)?.role, "user");
  assert.deepEqual(out.messages[0]?.content, [{ type: "text", text: "add a test" }]);
  assert.deepEqual(out.messages[1]?.content, [{ type: "text", text: "I added it." }], "the assistant turn is kept as it was");
  const last = out.messages.at(-1)!;
  assert.equal(last.content.length, 1);
  assert.match((last.content[0] as { text: string }).text, /summar/i);
  assert.deepEqual((last.content[0] as { cache_control?: unknown }).cache_control, { type: "ephemeral" });
});

test("compaction combines text blocks once, preserves Unicode and restores at its input position", () => {
  const mapper = new ResponsesEventMapper("claude-opus-5", undefined, true);
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "요약\n" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "constraints remain" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 4 } },
    { type: "message_stop" },
  ].flatMap((event) => mapper.feed(event));
  assert.deepEqual(events.map((event) => event.type), ["response.created", "response.output_item.added", "response.output_item.done", "response.completed"]);
  assert.equal(mapper.output.length, 1);
  assert.equal(mapper.output[0]!.type, "compaction");
  assert.deepEqual(mapper.finish(), [], "completion cannot emit a second compaction item");
  assert.equal(mapper.usage.output_tokens, 4);
  const restored = responsesToAnthropic({ input: [
    { type: "message", role: "user", content: "before" },
    ...mapper.output,
    { type: "message", role: "user", content: "after" },
  ] }, "claude-opus-5");
  assert.deepEqual(restored.messages.map((message) => message.content[0]), [
    { type: "text", text: "before" },
    { type: "text", text: "Summary of the earlier conversation: 요약\nconstraints remain" },
    { type: "text", text: "after", cache_control: { type: "ephemeral" } },
  ]);
});

test("foreign compaction is dropped with a diagnostic; malformed owned summaries fail visibly", () => {
  let ignored = 0;
  const out = responsesToAnthropic({ input: [
    { type: "compaction", encrypted_content: "opaque-openai-value" },
    { type: "message", role: "user", content: "continue" },
  ] }, "claude-opus-5", undefined, () => ignored++);
  assert.equal(ignored, 1);
  assert.equal(out.messages.length, 1);
  for (const payload of ["not-base64!", Buffer.from("not-json").toString("base64"), Buffer.from('{"summary":42}').toString("base64"), Buffer.from('{"summary":" "}').toString("base64")]) {
    assert.throws(() => responsesToAnthropic({ input: [{ type: "compaction", encrypted_content: `clauderipple:compaction:v1:${payload}` }] }, "claude-opus-5"));
  }
});

test("empty, interrupted, truncated and tool compactions never produce a successful item", () => {
  assert.throws(() => new ResponsesEventMapper("claude-opus-5", undefined, true).feed({ type: "message_stop" }), /complete summary/);
  const interrupted = new ResponsesEventMapper("claude-opus-5", undefined, true);
  interrupted.feed({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });
  assert.throws(() => interrupted.finish(), /complete summary/);
  assert.equal(interrupted.output.length, 0);
  assert.throws(() => new ResponsesEventMapper("claude-opus-5", undefined, true).feed({ type: "message_delta", delta: { stop_reason: "max_tokens" } }), /did not finish/);
  assert.throws(() => new ResponsesEventMapper("claude-opus-5", undefined, true).feed({ type: "content_block_start", content_block: { type: "tool_use" } }), /tool call/);
  assert.throws(() => new ResponsesEventMapper("claude-opus-5", undefined, true).feed({ type: "error" }), /upstream/);
});

test("a transcript that ends with the assistant still ends with a user turn", () => {
  const out = responsesToAnthropic({
    model: "claude-opus-5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ],
  }, "claude-opus-5");
  assert.equal(out.messages.at(-1)?.role, "user");
  assert.deepEqual(out.messages[1]?.content, [{ type: "text", text: "hello" }], "nothing of the transcript is rewritten");
});

test("a transcript that ends with the user is left alone", () => {
  const out = responsesToAnthropic({
    model: "claude-opus-5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
    ],
  }, "claude-opus-5");
  assert.equal(out.messages.length, 3);
  assert.deepEqual(out.messages.at(-1)?.content, [{ type: "text", text: "again", cache_control: { type: "ephemeral" } }]);
});

test("Chat Completions: a transcript that ends with the assistant also ends with a user turn", () => {
  const out = chatToAnthropic({
    model: "claude-opus-5",
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
  }, "claude-opus-5");
  assert.equal(out.messages.at(-1)?.role, "user");
  assert.deepEqual(out.messages[1]?.content, [{ type: "text", text: "hello" }]);
});

test("Chat Completions maps system, tools, images and tool calls", () => {
  const out = chatToAnthropic({
    model: "claude-sonnet-5",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "https://example.test/a.png" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ],
    tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
  }, "claude-sonnet-5");
  assert.equal(out.system?.[0]?.text, "system");
  assert.equal(out.messages[0]?.content[1]?.type, "image");
  assert.equal(out.messages[1]?.content[0]?.type, "tool_use");
  assert.equal(out.messages[2]?.content[0]?.type, "tool_result");
});

test("Anthropic SSE maps to Responses and Chat stream events with usage", () => {
  const mapper = new ResponsesEventMapper("claude-sonnet-5");
  const source = [
    { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_x", name: "Read", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"p":"x"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", usage: { input_tokens: 12, cache_read_input_tokens: 90, output_tokens: 7 } },
    { type: "message_stop" },
  ];
  const events = source.flatMap((event) => mapper.feed(event));
  assert.equal(events[0]?.type, "response.created");
  assert.ok(events.some((event) => event.type === "response.output_text.delta" && event.delta === "ok"));
  assert.ok(events.some((event) => event.type === "response.function_call_arguments.done" && event.arguments === '{"p":"x"}'));
  const completed = events.find((event) => event.type === "response.completed")!;
  assert.deepEqual((completed.response as { usage: unknown }).usage, { input_tokens: 102, input_tokens_details: { cached_tokens: 90 }, output_tokens: 7, total_tokens: 109 });
  const chat = responsesEventsToChatChunks(events, mapper);
  assert.ok(chat.some((chunk) => JSON.stringify(chunk).includes('"content":"ok"')));
  assert.ok(chat.some((chunk) => JSON.stringify(chunk).includes('"finish_reason":"tool_calls"')));
});

test("borrowed login: system is the identity line only, client instructions become the first user block", () => {
  const out = responsesToAnthropic(
    { model: "claude-sonnet-5", instructions: "You are Codex. Long operator text.", input: [{ type: "message", role: "user", content: "hi" }], reasoning: { effort: "high" } },
    "claude-sonnet-5",
    "You are Claude Code, Anthropic's official CLI for Claude.",
  );
  assert.deepEqual(out.system, [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } }]);
  const first = out.messages[0]!;
  assert.equal(first.role, "user");
  const blocks = first.content as { type: string; text?: string; cache_control?: unknown }[];
  assert.equal(blocks[0]!.type, "text");
  assert.ok(blocks[0]!.text!.startsWith("<operator_instructions>\nYou are Codex."));
  assert.deepEqual(blocks[0]!.cache_control, { type: "ephemeral" });
  assert.deepEqual(out.output_config, { effort: "high" });
});

test("API key path keeps instructions as the system prompt; effort dropped for models that reject it", () => {
  const out = responsesToAnthropic(
    { model: "claude-haiku-4-5", instructions: "Be terse.", input: [{ type: "message", role: "user", content: "hi" }], reasoning: { effort: "low" } },
    "claude-haiku-4-5-20251001",
  );
  assert.deepEqual(out.system, [{ type: "text", text: "Be terse.", cache_control: { type: "ephemeral" } }]);
  assert.equal(out.output_config, undefined);
  assert.equal((out.messages[0]!.content as unknown[]).length, 1);
  assert.equal(claudeSupportsEffort("claude-opus-4-6"), true);
  assert.equal(claudeSupportsEffort("claude-fable-5-1"), true);
  assert.equal(claudeSupportsEffort("claude-mythos-5-1"), true);
  assert.equal(claudeSupportsEffort("claude-sonnet-4-5-20250929"), false);
});

test("chat completions: system messages folded into the first user block when a prefix is set", () => {
  const out = chatToAnthropic(
    { model: "claude-sonnet-5", messages: [{ role: "system", content: "Rule A" }, { role: "system", content: "Rule B" }, { role: "user", content: "go" }] },
    "claude-sonnet-5",
    "identity",
  );
  assert.deepEqual(out.system, [{ type: "text", text: "identity", cache_control: { type: "ephemeral" } }]);
  const text = (out.messages[0]!.content as { text?: string }[])[0]!.text!;
  assert.ok(text.includes("Rule A\n\nRule B"));
});
