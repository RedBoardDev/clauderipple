import { test } from "node:test";
import assert from "node:assert/strict";
import { ENVELOPE_PREFIX, decodeEnvelope, encodeEnvelope, envelopeFor, isOurSignature, refusesReplayedReasoning, replayableReasoning, requiresThinkingReplay } from "../src/reasoning.ts";
import { dropForeignThinking } from "../src/thinking.ts";

// The carrier is a thinking block's signature (measured 2026-10-14 against a fake upstream: the CLI
// keeps it and replays it byte-identically, an empty thinking text included). It has to be plain
// ASCII whatever the vendor's sealed blob holds, and decoding it has to give back exactly what went in.
test("an envelope round-trips, and its base64url is ASCII whatever the vendor's blob holds", () => {
  const item = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAABbéあz+/=" };
  const signature = encodeEnvelope({ w: "responses", p: "opencode-go", m: "muse-spark-1.3-contributor", r: item });
  assert.match(signature, /^clauderipple\.v1:[A-Za-z0-9_-]+$/);
  const decoded = decodeEnvelope(signature);
  assert.deepEqual(decoded, { w: "responses", p: "opencode-go", m: "muse-spark-1.3-contributor", r: item });
  assert.equal(isOurSignature(signature), true);
  // Anthropic's own signature is base64 and never starts with the prefix.
  assert.equal(isOurSignature("EqQBCkgIBxABGAIiQ"), false);
  assert.equal(decodeEnvelope("EqQBCkgIBxABGAIiQ"), null);
});

// A signature is client-visible text: a broken one must be reported, not parsed into nonsense, and a
// foreign one must pass through as not ours rather than throwing.
test("a signature carrying our prefix that does not decode throws; a foreign one does not", () => {
  assert.throws(() => decodeEnvelope(`${ENVELOPE_PREFIX}not base64 !!!`), /did not decode/);
  assert.throws(() => decodeEnvelope(ENVELOPE_PREFIX + Buffer.from("{}").toString("base64url")), /recognizable shape/);
  assert.equal(decodeEnvelope("signature-from-anthropic"), null);
  assert.equal(decodeEnvelope(undefined), null);
});

// Reasoning is state, and state from another model is the thing a 400 is reliably about: a blob
// sealed by one model is not sent to another, whichever way the conversation arrived there.
test("a carrier is only used where it came from", () => {
  const block = { type: "thinking", thinking: "", signature: encodeEnvelope({ w: "responses", p: "opencode-go", m: "muse-spark-1.3", r: { type: "reasoning", encrypted_content: "x" } }) };
  const drops: string[] = [];
  assert.ok(envelopeFor(block, "responses", { p: "opencode-go", m: "muse-spark-1.3" }, (r) => drops.push(r)));
  assert.equal(envelopeFor(block, "responses", { p: "opencode-go", m: "muse-spark-2" }, (r) => drops.push(r)), null);
  assert.equal(envelopeFor(block, "responses", { p: "chatgpt", m: "muse-spark-1.3" }, (r) => drops.push(r)), null);
  // The other wire's carrier is not ours to unwrap here.
  assert.equal(envelopeFor(block, "chat", { p: "opencode-go", m: "muse-spark-1.3" }, (r) => drops.push(r)), null);
  // The drop names where the reasoning actually came from, which is what makes the two cases tellable
  // apart in the log: a different model, then a different provider on the same model.
  assert.deepEqual(drops, ["reasoning came from opencode-go/muse-spark-1.3", "reasoning came from opencode-go/muse-spark-1.3"]);
  // An unreadable carrier says so rather than passing as someone else's.
  assert.equal(envelopeFor({ type: "thinking", signature: `${ENVELOPE_PREFIX}zzzz` }, "responses", undefined, (r) => drops.push(r)), null);
  assert.equal(drops[2], "the envelope did not decode");
});

// A Chat vendor's reasoning has no sealed blob — the block's own text is the reasoning — so the
// envelope only has to name the field to send it back under.
test("a chat envelope carries the field name, and a Responses item without a blob is not replayed", () => {
  const chat = decodeEnvelope(encodeEnvelope({ w: "chat", p: "opencode-go", m: "deepseek-v4.1-flash", f: "reasoning_content" }));
  assert.deepEqual(chat, { w: "chat", p: "opencode-go", m: "deepseek-v4.1-flash", f: "reasoning_content" });
  assert.equal(replayableReasoning({ type: "reasoning", summary: [{ type: "summary_text", text: "x" }] }), null);
  assert.deepEqual(replayableReasoning({ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "blob", internal_chat_message_metadata_passthrough: { turn_id: "t" } }), {
    type: "reasoning",
    id: "rs_1",
    summary: [],
    encrypted_content: "blob",
  });
});

// `thinking.ts` is the only thing standing between a conversation that carries our reasoning and
// Anthropic, which refuses both an unsigned thinking block and a block signed by something else.
test("our envelopes are dropped before a request reaches Anthropic; Anthropic's own blocks stay", () => {
  const ours = { type: "thinking", thinking: "", signature: encodeEnvelope({ w: "chat", p: "opencode-go", m: "deepseek-v4.1-flash", f: "reasoning_content" }) };
  const signed = { type: "thinking", thinking: "plan", signature: "EqQBCkgIBxABGAIiQ" };
  const json: Record<string, unknown> = {
    model: "claude-opus-5-5",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [ours, { type: "tool_use", id: "call_1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "hi" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
      { role: "assistant", content: [signed, { type: "text", text: "done" }] },
    ],
  };
  assert.equal(dropForeignThinking(json), 2);
  assert.deepEqual(json.messages, [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "hi" }] },
    { role: "assistant", content: [signed, { type: "text", text: "done" }] },
  ]);
});

test("missing mandatory thinking is narrowly recognised, not a refusal of replay (#109)", () => {
  const message = "Upstream request failed: The `content[].thinking` in the thinking mode must be passed back to the API. (reasoning signature required)";
  assert.equal(requiresThinkingReplay(400, message), true);
  assert.equal(refusesReplayedReasoning(400, message), false);
  assert.equal(requiresThinkingReplay(500, message), false);
  assert.equal(requiresThinkingReplay(400, "reasoning_content must be provided"), false);
  assert.equal(requiresThinkingReplay(400, "Invalid content[].thinking signature"), false);
});

test("only a 4xx that says reasoning earns the retry without it", () => {
  assert.equal(refusesReplayedReasoning(400, "Invalid value for 'input[3].encrypted_content'"), true);
  assert.equal(refusesReplayedReasoning(400, "parameter reasoning is not supported"), true);
  assert.equal(refusesReplayedReasoning(422, "unprocessable"), true);
  assert.equal(refusesReplayedReasoning(401, "invalid api key"), false);
  assert.equal(refusesReplayedReasoning(429, "rate limited"), false);
  assert.equal(refusesReplayedReasoning(500, "encrypted_content blew up"), false);
});
