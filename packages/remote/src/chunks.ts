// Transport chunking for host frames larger than FRAME_CAP. No Node imports: the host serves
// this file to the browser (as /src/chunks.ts) and the app bundles it, so the sender (server.ts)
// and the shared Link (web/conn.ts) run these same lines.
//
// A chunk carries a slice of the original frame's UTF-8 bytes, base64. Slices are cut on byte
// boundaries and joined as bytes before one UTF-8 decode, so a character is never split. The
// assembled text is the exact JSON the host serialized — nothing is truncated, re-escaped or
// recomputed — and the Link hands it to the same handling a one-frame message gets.
import { CHUNK_DATA_BYTES, CHUNK_MESSAGE_MAX, CHUNK_TIMEOUT_MS } from "./protocol.ts";
import type { ChunkFrame, HostMsg } from "./protocol.ts";

/** The most chunks one message may claim (a fixed bound for a malformed or hostile sender). */
export const CHUNK_MAX_CHUNKS = Math.ceil(CHUNK_MESSAGE_MAX / CHUNK_DATA_BYTES);
/** How many different messages may be assembling at once. The host sends one at a time. */
export const CHUNK_MAX_PENDING = 8;
/** Finished message ids remembered for late duplicates: fixed, so the same clock instant cannot grow it. */
export const CHUNK_MAX_DONE = 32;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Base64 text longer than this cannot decode to a chunk within CHUNK_DATA_BYTES: reject before atob. */
const CHUNK_DATA_B64 = Math.ceil(CHUNK_DATA_BYTES / 3) * 4;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  if (typeof text !== "string" || !BASE64.test(text) || text.length % 4 !== 0) throw new Error("bad chunk data");
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The frames that carry `text` whole. `id` names this message so slices of two messages can
 * interleave without mixing; the caller makes it unique per message.
 */
export function* chunkFrames(text: string, id: string): Generator<ChunkFrame> {
  if (!ID.test(id)) throw new Error("bad chunk id");
  const bytes = enc.encode(text);
  if (bytes.length > CHUNK_MESSAGE_MAX) throw new RangeError(`message over ${CHUNK_MESSAGE_MAX} bytes`);
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK_DATA_BYTES));
  for (let index = 0; index < total; index++) {
    const slice = bytes.subarray(index * CHUNK_DATA_BYTES, Math.min(bytes.length, (index + 1) * CHUNK_DATA_BYTES));
    yield { t: "chunk", id, index, total, bytes: bytes.length, data: toBase64(slice) };
  }
}

/** True for the envelope only; the fields are checked when it is pushed. */
export function isChunkFrame(value: unknown): value is ChunkFrame {
  return typeof value === "object" && value !== null && (value as { t?: unknown }).t === "chunk";
}

/**
 * True for a frame the app handles: an object with a string `t`, but never a chunk envelope (a
 * completed message is a whole frame, not transport). An unknown `t` still passes, as before.
 */
export function isHostFrame(value: unknown): value is HostMsg {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const t = (value as { t?: unknown }).t;
  return typeof t === "string" && t !== "chunk";
}

export type ChunkPush =
  | { kind: "pending" }
  | { kind: "assembled"; text: string }
  /** The link must drop this socket and reconnect: a message it waits for cannot be completed. */
  | { kind: "error"; reason: string };

interface Assembly {
  total: number;
  bytes: number;
  /** decoded bytes received so far, so a lying `bytes` cannot grow memory */
  receivedBytes: number;
  chunks: (Uint8Array | undefined)[];
  received: number;
  at: number;
}

/**
 * Reassembles chunk frames for one socket. The Link feeds every `chunk` frame here; a partial
 * assembly is dropped on `reset()` (a new socket, stop, denial) and after CHUNK_TIMEOUT_MS of no
 * progress (`expire()` from the link's existing ping loop). `done` remembers finished ids for the
 * same window so a duplicated last slice is ignored rather than read as a new message.
 */
export class FrameAssembler {
  private now: () => number;
  private pending = new Map<string, Assembly>();
  /**
   * Finished ids, so a late duplicate cannot start a new message. Bounded by count as well as
   * time: an id may name a new message once its entry is evicted, which is safe because the host
   * makes a fresh UUID per message — within this window a repeated id is always the same message.
   */
  private done = new Map<string, number>();
  private declared = 0;

  constructor(now: () => number) { this.now = now; }

  push(frame: ChunkFrame): ChunkPush {
    const now = this.now();
    this.forget(now);
    // A non-string would be coerced by the regex ("undefined", "null", "42" all read as valid ids).
    if (typeof frame.id !== "string" || !ID.test(frame.id)) return this.fail("bad chunk id");
    if (!Number.isSafeInteger(frame.index) || !Number.isSafeInteger(frame.total) || !Number.isSafeInteger(frame.bytes)) return this.fail("bad chunk shape");
    if (frame.total < 1 || frame.total > CHUNK_MAX_CHUNKS) return this.fail("bad chunk count");
    if (frame.index < 0 || frame.index >= frame.total) return this.fail("bad chunk index");
    if (frame.bytes < 0 || frame.bytes > CHUNK_MESSAGE_MAX) return this.fail("bad chunk size");
    if (this.done.has(frame.id)) return { kind: "pending" };
    // The encoded length is checked before decoding, so an oversized frame costs no temporary bytes.
    if (typeof frame.data !== "string") return this.fail("bad chunk data");
    if (frame.data.length > CHUNK_DATA_B64) return this.fail("chunk over budget");
    let data: Uint8Array;
    try { data = fromBase64(frame.data); } catch { return this.fail("bad chunk data"); }
    if (data.length > CHUNK_DATA_BYTES) return this.fail("chunk over budget");

    let part = this.pending.get(frame.id);
    if (!part) {
      if (this.pending.size >= CHUNK_MAX_PENDING) return this.fail("too many partial messages");
      if (this.declared + frame.bytes > CHUNK_MESSAGE_MAX) return this.fail("partial messages over budget");
      part = { total: frame.total, bytes: frame.bytes, receivedBytes: 0, chunks: new Array<Uint8Array | undefined>(frame.total), received: 0, at: now };
      this.pending.set(frame.id, part);
      this.declared += frame.bytes;
    } else if (part.total !== frame.total || part.bytes !== frame.bytes) {
      return this.fail("chunk shape changed");
    }
    if (part.chunks[frame.index]) return this.fail("duplicate chunk");
    if (part.receivedBytes + data.length > part.bytes) return this.fail("chunks over declared size");
    part.chunks[frame.index] = data;
    part.receivedBytes += data.length;
    part.received++;
    part.at = now;

    if (part.received < part.total) return { kind: "pending" };
    this.pending.delete(frame.id);
    this.declared -= part.bytes;
    if (part.receivedBytes !== part.bytes) return this.fail("chunks under declared size");
    const all = new Uint8Array(part.bytes);
    let offset = 0;
    for (const chunk of part.chunks) { all.set(chunk!, offset); offset += chunk!.length; }
    let text: string;
    try { text = dec.decode(all); } catch { return this.fail("chunks are not UTF-8"); }
    this.done.set(frame.id, now);
    // Fixed count as well as the time window: many tiny messages at one clock instant cannot grow it.
    while (this.done.size > CHUNK_MAX_DONE) this.done.delete(this.done.keys().next().value!);
    return { kind: "assembled", text };
  }

  /** Drops assemblies that stopped making progress; true when one was discarded. */
  expire(): boolean {
    const now = this.now();
    let dropped = false;
    for (const [id, part] of this.pending) {
      if (now - part.at <= CHUNK_TIMEOUT_MS) continue;
      this.pending.delete(id);
      this.declared -= part.bytes;
      dropped = true;
    }
    this.forget(now);
    return dropped;
  }

  /** Forget everything: the socket that started these assemblies is gone. */
  reset(): void {
    this.pending.clear();
    this.done.clear();
    this.declared = 0;
  }

  private forget(now: number): void {
    for (const [id, at] of this.done) if (now - at > CHUNK_TIMEOUT_MS) this.done.delete(id);
  }

  private fail(reason: string): ChunkPush {
    return { kind: "error", reason };
  }
}
