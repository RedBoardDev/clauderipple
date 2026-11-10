// Chunk transport: splitting a large host frame and rejoining it exactly on the phone.
import test from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { BOX_OVERHEAD, hostAccept, phoneFinish, phoneHello } from "../src/e2ee.ts";
import { CHUNK_DATA_BYTES, CHUNK_MESSAGE_MAX, CHUNK_TIMEOUT_MS, FRAME_CAP, RELAY_FRAME_CAP } from "../src/protocol.ts";
import type { ChunkFrame } from "../src/protocol.ts";
import { CHUNK_MAX_CHUNKS, CHUNK_MAX_DONE, CHUNK_MAX_PENDING, FrameAssembler, chunkFrames, isChunkFrame, isHostFrame } from "../src/chunks.ts";

function bigFrame(extra = 0): string {
  return JSON.stringify({
    t: "ready",
    host: { name: "한글😀\"\\\n\t", version: "0", routerOk: true },
    sessions: [{ id: "s", note: "y".repeat(FRAME_CAP + extra) }],
  });
}

const last = (frames: ChunkFrame[]): ChunkFrame => frames[frames.length - 1]!;

test("an over-cap frame is split into frames that fit the direct and relay wires, and rejoins exactly", () => {
  const frame = bigFrame(4096);
  const frames = [...chunkFrames(frame, "a".repeat(64))];
  assert.ok(frames.length > 1);
  for (const chunk of frames) {
    const bytes = Buffer.byteLength(JSON.stringify(chunk));
    assert.ok(bytes <= FRAME_CAP, `${bytes} bytes`);
    assert.ok(bytes + BOX_OVERHEAD <= RELAY_FRAME_CAP, "the encrypted wrapper stays under the relay's cap");
    assert.ok(Buffer.from(chunk.data, "base64").length <= CHUNK_DATA_BYTES);
    assert.equal(chunk.total, frames.length);
    assert.equal(chunk.bytes, Buffer.byteLength(frame));
    assert.equal(isChunkFrame(chunk), true);
  }
  const assembler = new FrameAssembler(() => 0);
  let assembled = "";
  for (const chunk of frames) {
    const result = assembler.push(chunk);
    if (result.kind === "assembled") assembled = result.text;
  }
  assert.equal(assembled, frame, "the exact serialized frame, not a re-encoding");
});

test("every chunk is whole inside the encrypted relay frame and opens to the same text", () => {
  const hostKey = nacl.box.keyPair();
  const hello = phoneHello(nacl);
  const accepted = hostAccept(nacl, hostKey, hello.text);
  const phone = phoneFinish(nacl, hello.eph, hostKey.publicKey, accepted.text);
  for (const chunk of chunkFrames(bigFrame(4096), "relay")) {
    const text = JSON.stringify(chunk);
    const sealed = accepted.channel.seal(text);
    assert.ok(sealed.length <= RELAY_FRAME_CAP, `${sealed.length} bytes did not fit the relay`);
    assert.equal(phone.open(sealed), text);
  }
});

test("slices of two messages may interleave and each rejoins byte for byte", () => {
  const a = JSON.stringify({ t: "sessions", sessions: [{ id: "a", note: "가".repeat(120_000) }] });
  const b = JSON.stringify({ t: "events", session: "s", epoch: "e", events: [{ kind: "user", text: "\"\\".repeat(150_000) }] });
  const as = [...chunkFrames(a, "aaa")];
  const bs = [...chunkFrames(b, "bbb")];
  const assembler = new FrameAssembler(() => 0);
  const done = new Map<string, string>();
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    for (const chunk of [as[i], bs[i]]) {
      if (!chunk) continue;
      const result = assembler.push(chunk);
      if (result.kind === "assembled") done.set(chunk.id, result.text);
    }
  }
  assert.equal(done.get("aaa"), a);
  assert.equal(done.get("bbb"), b);
});

test("UTF-8 and JSON escapes survive a slice boundary; no character is split", () => {
  const tricky = `앞${"a".repeat(CHUNK_DATA_BYTES - 4)}😀뒤"\\\u0000\n${"\u{1F600}".repeat(50)}`;
  const frame = JSON.stringify({ t: "res", reqId: "r", ok: true, data: { text: tricky } });
  const assembler = new FrameAssembler(() => 0);
  let assembled = "";
  for (const chunk of chunkFrames(frame, "utf8")) {
    const result = assembler.push(chunk);
    if (result.kind === "assembled") assembled = result.text;
  }
  assert.equal(assembled, frame);
  assert.equal(assembled.includes("�"), false);
  assert.equal(JSON.parse(assembled).data.text, tricky, "the emoji that straddles the first slice is whole");
});

test("a duplicate, malformed or misdeclared slice is refused, never guessed", () => {
  const frames = [...chunkFrames(bigFrame(), "dup")];
  const duplicate = new FrameAssembler(() => 0);
  assert.equal(duplicate.push(frames[0]!).kind, "pending");
  assert.deepEqual(duplicate.push(frames[0]!), { kind: "error", reason: "duplicate chunk" });
  assert.deepEqual(new FrameAssembler(() => 0).push({ ...frames[0]!, data: "!!" }), { kind: "error", reason: "bad chunk data" });
  assert.deepEqual(new FrameAssembler(() => 0).push({ ...frames[0]!, index: frames[0]!.total }), { kind: "error", reason: "bad chunk index" });
  assert.deepEqual(new FrameAssembler(() => 0).push({ ...frames[0]!, total: CHUNK_MAX_CHUNKS + 1 }), { kind: "error", reason: "bad chunk count" });
  assert.deepEqual(new FrameAssembler(() => 0).push({ ...frames[0]!, bytes: CHUNK_MESSAGE_MAX + 1 }), { kind: "error", reason: "bad chunk size" });
  assert.deepEqual(new FrameAssembler(() => 0).push({ ...frames[0]!, id: "" }), { kind: "error", reason: "bad chunk id" });
  const three = Buffer.from("abc").toString("base64");
  const frame = (index: number, bytes: number): ChunkFrame => ({ t: "chunk", id: "z", index, total: 2, bytes, data: three });
  const under = new FrameAssembler(() => 0);
  assert.equal(under.push(frame(0, 10)).kind, "pending");
  assert.deepEqual(under.push(frame(1, 10)), { kind: "error", reason: "chunks under declared size" });
  const over = new FrameAssembler(() => 0);
  assert.equal(over.push(frame(0, 5)).kind, "pending");
  assert.deepEqual(over.push(frame(1, 5)), { kind: "error", reason: "chunks over declared size" });
  const changed = new FrameAssembler(() => 0);
  assert.equal(changed.push(frame(0, 10)).kind, "pending");
  assert.deepEqual(changed.push({ ...frame(1, 10), total: 3 }), { kind: "error", reason: "chunk shape changed" });
  const oversized = Buffer.alloc(CHUNK_DATA_BYTES + 1).toString("base64");
  assert.deepEqual(new FrameAssembler(() => 0).push({ t: "chunk", id: "big", index: 0, total: 1, bytes: CHUNK_DATA_BYTES + 1, data: oversized }), { kind: "error", reason: "chunk over budget" });
});

test("a lost slice expires instead of waiting forever, and the whole message can be fetched again", () => {
  let now = 0;
  const assembler = new FrameAssembler(() => now);
  const frames = [...chunkFrames(bigFrame(), "lost")];
  for (const chunk of frames.slice(0, -1)) assert.equal(assembler.push(chunk).kind, "pending");
  assert.equal(assembler.expire(), false, "the last slice only just arrived");
  now = CHUNK_TIMEOUT_MS + 1;
  assert.equal(assembler.expire(), true);
  assert.equal(assembler.expire(), false, "nothing left to drop");
  let assembled = "";
  for (const chunk of frames) {
    const result = assembler.push(chunk);
    if (result.kind === "assembled") assembled = result.text;
  }
  assert.equal(assembled, bigFrame(), "a fresh complete message still arrives");
});

test("partial messages are bounded in count and in declared bytes", () => {
  const one = { ...[...chunkFrames(bigFrame(), "pad")][0]!, id: "huge", bytes: CHUNK_MESSAGE_MAX };
  const bounded = new FrameAssembler(() => 0);
  assert.equal(bounded.push({ ...one, data: Buffer.from("ab").toString("base64") }).kind, "pending");
  assert.deepEqual(bounded.push({ ...one, id: "next", bytes: 1 }), { kind: "error", reason: "partial messages over budget" });
  const many = new FrameAssembler(() => 0);
  const byte = Buffer.from("a").toString("base64");
  for (let i = 0; i < CHUNK_MAX_PENDING; i++) assert.equal(many.push({ t: "chunk", id: `p${i}`, index: 0, total: 2, bytes: 2, data: byte }).kind, "pending");
  assert.deepEqual(many.push({ t: "chunk", id: "overflow", index: 0, total: 2, bytes: 2, data: byte }), { kind: "error", reason: "too many partial messages" });
});

test("a late duplicate after the message completed is ignored", () => {
  const assembler = new FrameAssembler(() => 0);
  const frames = [...chunkFrames(bigFrame(), "late")];
  let assembled = "";
  for (const chunk of frames) {
    const result = assembler.push(chunk);
    if (result.kind === "assembled") assembled = result.text;
  }
  assert.equal(assembled, bigFrame());
  assert.deepEqual(assembler.push(last(frames)), { kind: "pending" });
});

test("reset drops a half-received message; its surviving slices never mix with a new socket's", () => {
  const frames = [...chunkFrames(bigFrame(), "reset")];
  const assembler = new FrameAssembler(() => 0);
  assert.equal(assembler.push(frames[0]!).kind, "pending");
  assembler.reset();
  assert.equal(assembler.push(frames[1]!).kind, "pending");
  const result = assembler.push(frames[0]!);
  assert.equal(result.kind === "assembled" ? result.text : "", bigFrame(), "both slices came from this socket");
});

test("the sender refuses a message past the transport bound", () => {
  assert.throws(() => [...chunkFrames("x".repeat(CHUNK_MESSAGE_MAX + 1), "too-big")], RangeError);
  assert.throws(() => [...chunkFrames("x".repeat(FRAME_CAP), "bad id!")], /bad chunk id/);
});

test("a chunk id that is not a string is refused, not coerced into a valid one", () => {
  const base = [...chunkFrames(bigFrame(), "ok")][0]!;
  for (const id of [undefined, null, 42, {}]) {
    assert.deepEqual(new FrameAssembler(() => 0).push({ ...base, id: id as string }), { kind: "error", reason: "bad chunk id" });
  }
});

test("an oversized encoded slice is refused before it is decoded", () => {
  const encoded = Math.ceil(CHUNK_DATA_BYTES / 3) * 4 + 4;
  const frame: ChunkFrame = { t: "chunk", id: "big64", index: 0, total: 1, bytes: CHUNK_DATA_BYTES, data: "A".repeat(encoded) };
  assert.deepEqual(new FrameAssembler(() => 0).push(frame), { kind: "error", reason: "chunk over budget" });
});

test("finished ids are bounded by count; an evicted id may name a new message", () => {
  const assembler = new FrameAssembler(() => 0);
  const text = JSON.stringify({ t: "sessions", sessions: [{ id: "s", note: "x".repeat(300_000) }] });
  const frames = [...chunkFrames(text, "old")];
  let assembled = "";
  for (const chunk of frames) {
    const result = assembler.push(chunk);
    if (result.kind === "assembled") assembled = result.text;
  }
  assert.equal(assembled, text);
  assert.equal(assembler.push(frames[0]!).kind, "pending", "a late duplicate is still remembered");
  // Many tiny messages at one clock instant cannot grow the finished set past its fixed count.
  for (let i = 0; i < CHUNK_MAX_DONE; i++) {
    const result = assembler.push({ t: "chunk", id: `tiny-${i}`, index: 0, total: 1, bytes: 0, data: "" });
    assert.equal(result.kind === "assembled" ? result.text : "?", "");
  }
  assert.equal(assembler.push(frames[0]!).kind, "pending", "the evicted id starts a new message now");
  const again = assembler.push(frames[1]!);
  assert.equal(again.kind === "assembled" ? again.text : "", text, "the reused id carries the new message");
});

test("an assembled message must be one host frame, never another envelope", () => {
  assert.equal(isHostFrame({ t: "sessions" }), true);
  assert.equal(isHostFrame({ t: "some-future-frame" }), true, "an unknown type keeps the old pass-through");
  assert.equal(isHostFrame(null), false);
  assert.equal(isHostFrame([]), false);
  assert.equal(isHostFrame("ready"), false);
  assert.equal(isHostFrame({}), false);
  assert.equal(isHostFrame({ t: 1 }), false);
  assert.equal(isHostFrame({ t: "chunk" }), false);
});

test("only the chunk envelope is recognised", () => {
  assert.equal(isChunkFrame({ t: "chunk" }), true);
  assert.equal(isChunkFrame({ t: "ready" }), false);
  assert.equal(isChunkFrame(null), false);
  assert.equal(isChunkFrame("chunk"), false);
});
