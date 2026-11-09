// A translated reasoning model's own turn, carried through Claude Code's transcript.
//
// The Responses wire hands its model an opaque reasoning item — `{type:"reasoning", id, summary,
// encrypted_content}` — and expects it back, byte for byte, in the position it came from, beside the
// function calls of that same turn. That is not an optimisation: measured 2026-10-14 with Muse Spark
// 1.3 at xhigh on a real tool loop, runs whose previous reasoning was not returned spent
// 9.5k–24.5k reasoning tokens each (2,197 per step past 80k context) and one of three ran out of
// context without ever answering, where the same loop with the items returned spent 3.2k–4.3k per
// run (725 per step past 80k), answered in all three, and read 94% prompt cache. Dropping the reasoning is why a routed worker "thinks from
// scratch on every tool call" and then dies. DeepSeek's own Chat API states the same rule for
// `reasoning_content`: with `tools` present it "must be fully passed back to the API in all
// subsequent requests", even for turns that made no tool call, and the API answers a 400 otherwise
// (https://api-docs.deepseek.com/guides/thinking_mode/, read 2026-10-14).
//
// The router keeps no state of its own here. Claude Code resends the whole conversation every turn,
// so the transcript is the storage. The carrier is a `thinking` block's `signature`, which is a
// free-form string on the wire and is replayed with the block [measured 2026-10-14 against a fake
// upstream: a thinking block carrying our signature comes back on the next request of a tool loop
// with the signature byte-identical, and an *empty* thinking text is kept too — which is what a
// Responses reasoning item with no summary looks like]. Anthropic's own signature is opaque base64
// this router cannot forge; ours is a small envelope that names the wire, the provider, the model
// and the vendor's own reasoning, and it is decoded and dropped by `thinking.ts` before a request
// reaches Anthropic.
//
// opencodex (github.com/lidge-jun/opencodex, devlog/_fin/260711_claude_inbound/003_evidence.md
// lines 93-118) reached the same conclusion and the same carrier — a signature on a thinking block,
// read back out of the client's own conversation — and we rely on that as a behavioral
// specification only; no code was copied.
//
// `encrypted_content` is the vendor's own sealed blob. It goes in the envelope untouched and comes
// back untouched: re-encoding or re-signing it would be the "re-signed reasoning" mistake that cost
// an earlier translator 12–20% cache hit (ARCHITECTURE §4, "Cache-safety decisions").
//
// `include:["reasoning.encrypted_content"]` is asked for on every turn where the vendor is known to
// take it — the ChatGPT backend, as Codex asks, and a preset marked `sealedReasoning` (presets.ts),
// as OpenCode's own client asks. A `store: false` backend that is not asked hands back nothing, so
// waiting until a conversation already carried reasoning would never start one. For any other
// Responses vendor it is asked for only once the conversation already carries that vendor's
// reasoning, so a vendor never measured keeps the request it had. Measured 2026-10-14 against
// OpenCode Go (`muse-spark-1.3-contributor`, one tool-bearing turn): the sealed item came back with
// `include` and without it, both 1426 bytes, and replaying it in place answered 200. The same vendor
// also accepted a tampered blob and a turn with the item dropped entirely (both 200), so the 4xx
// retry below is a safety net for a vendor or an account that is stricter.

/** Names an envelope as ours. Anthropic's own signatures never start with it. */
export const ENVELOPE_PREFIX = "clauderipple.v1:";

/**
 * An envelope: which wire and which model a piece of reasoning came from, and the reasoning itself.
 * `r` is the vendor's own Responses item, `f` the field a Chat vendor sent reasoning text under.
 */
export type Envelope =
  | { w: "responses"; p: string; m: string; r: Record<string, unknown> }
  | { w: "chat"; p: string; m: string; f: string };

/** Full reasoning text is replayable too; a display-only summary is not a substitute for it. */
export type ReplayedReasoning = { type: "reasoning"; id?: string; summary?: unknown; encrypted_content?: string; content?: { type: "reasoning_text"; text: string }[] };

/** Thrown when a signature looks like ours and does not decode. */
export class UndecodableEnvelope extends Error {}

/**
 * Our marker on a block, without decoding it: the cheap test `thinking.ts` and the request builders
 * need before doing any work. Anthropic's own signatures are base64 and never carry this prefix.
 */
export function isOurSignature(signature: unknown): boolean {
  return typeof signature === "string" && signature.startsWith(ENVELOPE_PREFIX);
}

/** The `signature` of a block of ours: the envelope, base64url so it survives any signature field. */
export function encodeEnvelope(envelope: Envelope): string {
  return ENVELOPE_PREFIX + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function envelope(value: unknown): Envelope | null {
  if (!value || typeof value !== "object") return null;
  const e = value as { w?: unknown; p?: unknown; m?: unknown; r?: unknown; f?: unknown };
  if (typeof e.p !== "string" || typeof e.m !== "string") return null;
  if (e.w === "chat") return typeof e.f === "string" && e.f.length > 0 ? { w: "chat", p: e.p, m: e.m, f: e.f } : null;
  if (e.w === "responses") return e.r && typeof e.r === "object" ? { w: "responses", p: e.p, m: e.m, r: e.r as Record<string, unknown> } : null;
  return null;
}

/**
 * The envelope on a signature, or null when it is not ours. A signature that carries our prefix and
 * does not decode is a broken carrier, not a foreign one, so it throws rather than passing silently
 * as someone else's — the caller logs it and moves on.
 */
export function decodeEnvelope(signature: unknown): Envelope | null {
  if (!isOurSignature(signature)) return null;
  const text = (signature as string).slice(ENVELOPE_PREFIX.length);
  // Guard the decode: a signature is attacker-visible text and a gigabyte of base64 must not become
  // a gigabyte of JSON. A sealed reasoning blob runs a few KB.
  if (text.length > 512 * 1024) throw new UndecodableEnvelope("envelope too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw new UndecodableEnvelope("envelope did not decode");
  }
  const decoded = envelope(parsed);
  if (!decoded) throw new UndecodableEnvelope("envelope was not a recognizable shape");
  return decoded;
}

/**
 * Replay sealed state or full reasoning text, never a summary alone. Codex's sealed items need
 * `encrypted_content`; compatible Responses vendors can instead supply `reasoning_text` content.
 */
export function replayableReasoning(stored: Record<string, unknown>): ReplayedReasoning | null {
  if (stored.type !== "reasoning") return null;
  const encrypted = stored.encrypted_content;
  const content = Array.isArray(stored.content) && stored.content.every((part: unknown) => {
    if (!part || typeof part !== "object") return false;
    const value = part as { type?: unknown; text?: unknown };
    return value.type === "reasoning_text" && typeof value.text === "string";
  }) ? stored.content as { type: "reasoning_text"; text: string }[] : undefined;
  const sealed = typeof encrypted === "string" && encrypted.length > 0;
  if (!sealed && !content?.some((part) => part.text.length > 0)) return null;
  // Only wire fields go back, not vendor bookkeeping or client-injected metadata.
  const out: ReplayedReasoning = { type: "reasoning" };
  if (sealed) out.encrypted_content = encrypted;
  if (content) out.content = content.map(({ type, text }) => ({ type, text }));
  if (typeof stored.id === "string" && stored.id.length > 0) out.id = stored.id;
  if (Array.isArray(stored.summary)) out.summary = stored.summary;
  return out;
}

/**
 * The envelope on an assistant block, when it is ours *and* usable here: the right wire, and the
 * same provider and model that made it. Anything else returns null as if the block were foreign —
 * reasoning is state, and state from another model is not merely useless, it is the thing a vendor
 * refuses. A signature that is ours but broken, or names another model, reports through `onDrop` so
 * the caller can count it; neither is an error worth failing a turn over.
 */
export function envelopeFor<W extends Envelope["w"]>(
  block: unknown,
  wire: W,
  env: { p: string; m: string } | undefined,
  onDrop: (reason: string) => void,
): Extract<Envelope, { w: W }> | null {
  const b = block as { type?: unknown; signature?: unknown } | null;
  if (!b || typeof b !== "object" || b.type !== "thinking" || !isOurSignature(b.signature)) return null;
  let decoded: Envelope;
  try {
    const got = decodeEnvelope(b.signature);
    if (!got) return null;
    decoded = got;
  } catch {
    onDrop("the envelope did not decode");
    return null;
  }
  if (decoded.w !== wire) return null;
  if (env && (decoded.p !== env.p || decoded.m !== env.m)) {
    onDrop(`reasoning came from ${decoded.p}/${decoded.m}`);
    return null;
  }
  return decoded as Extract<Envelope, { w: W }>;
}

/** `type` matters as much as the wording: a vendor that says "reasoning" is answering about this. */
const REASONING_REFUSAL = /reasoning|encrypted|\binput\[\d+\]|\bitem\b|signature/i;

/**
 * Whether a 4xx refusal is about the reasoning that was replayed, and so is worth one retry without
 * it. Only a request that carried replayed reasoning can be refused for carrying it, and a sealed
 * blob minted on one account or one model is the thing most likely to be refused on another.
 */
export function refusesReplayedReasoning(status: number, message: string): boolean {
  return !requiresThinkingReplay(status, message) && status >= 400 && status < 500 && (status === 422 || REASONING_REFUSAL.test(message));
}

/** Missing mandatory history cannot be repaired by removing more reasoning or resending the body. */
export function requiresThinkingReplay(status: number, message: string): boolean {
  return status === 400 && /The `?content\[\]\.thinking`? in the thinking mode must be passed back to the API\./.test(message);
}
