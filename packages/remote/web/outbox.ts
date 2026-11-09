// Unsent messages, kept per computer.
//
// A phone can be paired through one relay with more than one computer, and session ids come from
// each host's own space: the same id can name different work on two machines. While the outbox was
// one shared list, re-pairing handed what a person wrote for one computer to whichever computer the
// phone connected to next (B05). Storage is now keyed by the computer the pairing names.
//
// Entries written before this split carry no provenance. They stay in `rr.outbox` untouched, are
// never deleted and are never sent on their own: which computer they were meant for cannot be
// known, so sending them would be a guess. The same holds for every bucket a replaced host key left
// behind: they are shown to the person (`preserved`), never sent from here.
//
// What is stored is the person's own words, so a list that cannot be read back whole is never
// written over: the raw value stays where it is and is shown as text, never parsed back into
// messages.
import type { Effort } from "../src/protocol.ts";
import type { Outgoing } from "./timeline.ts";

/**
 * How this phone keeps a message, outbox-only so neither the shared timeline types nor the native
 * app has to know about it:
 * - `queued` (also: absent, for entries saved before this field existed) goes out on the next
 *   connect like any queued message;
 * - `held` must not be sent, or re-addressed, until the person decides; `hold` says why;
 * - `recovered` was imported from a preserved bucket: it waits in the unsent queue until the person
 *   sends it themselves, and nothing sends it on their behalf.
 */
export type Delivery = "queued" | "held" | "recovered";

/** Why a message is held. Both mean "the host may already have it": see refuse(). */
export type HoldReason = "unknown_outcome" | "maybe_created";

/** One message a person wrote that the host has not acknowledged; `text` is their exact words. */
export interface OutboxEntry extends Outgoing {
  /** the session it belongs to; null until the host acknowledges the `create` that started it */
  session: string | null;
  create?: { cwd: string; model: string; effort: Effort | null };
  delivery?: Delivery;
  hold?: HoldReason;
}

/**
 * Which computer a pairing names. A relay serves every host behind it from one origin, so the page
 * origin cannot tell them apart there: the relay's server id does, and the host's public key from
 * the pairing QR proves which host answered (a reused id or a replaced config cannot take over the
 * previous host's unsent words). A host that serves the app itself has no such proof, so it is
 * named by its origin plus a one-way fingerprint of the pairing token — two hosts at one address,
 * or one host after a token change, never share a queue.
 */
export type HostIdentity =
  | { kind: "relay"; relay: string; server: string; key: string }
  | { kind: "direct"; origin: string; fingerprint: string };

/** A relay pairing as the pairing link carries it (url, server id, host public key). */
export interface RelayPairingInput { url: string; server: string; hpk: string }

/** The only WebCrypto call used here, kept structural so this file needs no DOM types. */
export interface Digest {
  digest(algorithm: string, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
}

/** A one-way fingerprint of the pairing token: SHA-256, hex, with a domain separator. */
export async function tokenFingerprint(token: string, subtle: Digest | undefined = globalThis.crypto?.subtle): Promise<string> {
  if (!subtle) throw new Error("This browser cannot fingerprint the pairing token (no WebCrypto).");
  const bytes = new TextEncoder().encode(`clauderipple.outbox.v1\u0000${token}`);
  const hash = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The computer this page is paired with, or null when a direct pairing's token cannot be
 * fingerprinted (no WebCrypto). Null means the app cannot tell which computer it is talking to, so
 * it neither stores nor sends: a message that cannot be tied to one computer is exactly what B05
 * was.
 */
export async function hostIdentity(
  pairing: { relay: RelayPairingInput | null; origin: string; token: string },
  fingerprint: (token: string) => Promise<string> = tokenFingerprint,
): Promise<HostIdentity | null> {
  const relay = pairing.relay;
  if (relay !== null && relay.url === pairing.origin) return { kind: "relay", relay: relay.url, server: relay.server, key: relay.hpk };
  try {
    return { kind: "direct", origin: pairing.origin, fingerprint: await fingerprint(pairing.token) };
  } catch {
    return null;
  }
}

/** The pre-identity key. Nothing reads it for sending; see the file comment. */
export const OUTBOX_KEY = "rr.outbox";

export function outboxKey(identity: HostIdentity): string {
  return identity.kind === "relay"
    ? `${OUTBOX_KEY}.relay:${identity.relay}|${identity.server}|${identity.key}`
    : `${OUTBOX_KEY}.direct:${identity.origin}|${identity.fingerprint}`;
}

/**
 * The storage calls this needs; tests pass a Map-backed object. Every call may throw (quota, private
 * mode, blocked storage) and the failure is reported, never hidden.
 */
export interface OutboxStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Every key this origin holds, for finding the buckets other computers left behind. */
  keys?(): string[];
}

/**
 * What reading one computer's queue found. `partial` and `unreadable` both mean the stored value is
 * not something this app can send in full, so it is left untouched and never written over; `raw` is
 * carried out so the person can read and copy exactly what is there.
 */
export type OutboxLoad =
  | { status: "empty" }
  | { status: "ok"; entries: OutboxEntry[] }
  | { status: "partial"; entries: OutboxEntry[]; raw: string }
  | { status: "unreadable"; raw: string }
  | { status: "unavailable" };

const DELIVERIES: readonly Delivery[] = ["queued", "held", "recovered"];
const HOLDS: readonly HoldReason[] = ["unknown_outcome", "maybe_created"];

/** A stored entry, or null when it cannot be read back as one (words with no id cannot be sent). */
function entryOf(value: unknown): OutboxEntry | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  if (typeof e.clientMsgId !== "string" || !e.clientMsgId) return null;
  if (typeof e.text !== "string" || !e.text.trim()) return null;
  if (typeof e.at !== "number" || !Number.isFinite(e.at)) return null;
  if (e.state !== "pending" && e.state !== "sending") return null;
  if (e.session !== null && typeof e.session !== "string") return null;
  const create = e.create === undefined ? undefined : createOf(e.create);
  if (e.create !== undefined && create === null) return null;
  if (e.delivery !== undefined && !DELIVERIES.includes(e.delivery as Delivery)) return null;
  if (e.hold !== undefined && !HOLDS.includes(e.hold as HoldReason)) return null;
  const error = typeof e.error === "string" && e.error ? e.error : undefined;
  const delivery = e.delivery as Delivery | undefined;
  const hold = e.hold as HoldReason | undefined;
  return {
    clientMsgId: e.clientMsgId, text: e.text, at: e.at, state: e.state, session: e.session,
    ...(create ? { create } : {}),
    ...(error ? { error } : {}),
    ...(delivery ? { delivery } : {}),
    ...(hold ? { hold } : {}),
  };
}

function createOf(value: unknown): { cwd: string; model: string; effort: Effort | null } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (typeof c.cwd !== "string" || !c.cwd) return null;
  if (typeof c.model !== "string" || !c.model) return null;
  if (c.effort !== null && typeof c.effort !== "string") return null;
  return { cwd: c.cwd, model: c.model, effort: c.effort as Effort | null };
}

export function loadOutbox(store: OutboxStore, key: string): OutboxLoad {
  let raw: string | null;
  try { raw = store.getItem(key); } catch { return { status: "unavailable" }; }
  if (raw === null) return { status: "empty" };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { status: "unreadable", raw }; }
  if (!Array.isArray(parsed)) return { status: "unreadable", raw };
  const entries: OutboxEntry[] = [];
  let dropped = false;
  for (const value of parsed) {
    const entry = entryOf(value);
    if (entry) entries.push(entry);
    else dropped = true;
  }
  return dropped ? { status: "partial", entries, raw } : { status: "ok", entries };
}

/** Only a list that was read back whole may be written over: anything else would drop words unread. */
export function writable(load: OutboxLoad): boolean {
  return load.status === "empty" || load.status === "ok";
}

/**
 * What the app holds for this pairing: the key, the messages it may send, whether it may write, and
 * what (if anything) it must say about the stored value. `no-identity` is a direct pairing whose
 * token this browser cannot fingerprint: nothing is stored for it, and the app refuses to send,
 * because a message that cannot be tied to one computer is how B05 happened.
 */
export type OutboxStart = {
  key: string | null;
  entries: OutboxEntry[];
  writable: boolean;
  notice: "no-identity" | "partial" | "unreadable" | "unavailable" | null;
};

export function outboxStart(identity: HostIdentity | null, store: OutboxStore): OutboxStart {
  if (identity === null) return { key: null, entries: [], writable: false, notice: "no-identity" };
  const key = outboxKey(identity);
  const load = loadOutbox(store, key);
  if (load.status === "empty" || load.status === "ok") {
    return { key, entries: load.status === "ok" ? load.entries : [], writable: true, notice: null };
  }
  return { key, entries: load.status === "partial" ? load.entries : [], writable: writable(load), notice: load.status };
}

export type OutboxWrite = { ok: true } | { ok: false; error: string };

export function writeOutbox(store: OutboxStore, key: string, entries: readonly OutboxEntry[]): OutboxWrite {
  try {
    store.setItem(key, JSON.stringify(entries));
    return { ok: true };
  } catch (e) {
    // The browser refused (quota, private mode). The words stay in memory; the app says so, and it
    // is not reported as kept.
    return { ok: false, error: e instanceof Error && e.name ? e.name : "storage" };
  }
}

/**
 * What the host's refusal means for a message it did not run. Nothing is dropped: the words and the
 * clientMsgId are what the person needs to try again, and the host acknowledges a repeated id
 * instead of running it twice.
 *
 * - `host_updating`: the host answered before running anything — transient, so the message goes back
 *   to `queued` and the reconnect after the update sends it again.
 * - `outcome_unknown`: the attempt may have run. It is `held` with `unknown_outcome`: the same id may
 *   be retried (the host acknowledges a repeat), but nothing re-addresses it by itself.
 * - any other refusal: a `send` may simply be retried, but a `create` may already have saved its
 *   session (sessions.ts persists it before handing the text to the SDK), so a create is `held` with
 *   `maybe_created` until the person decides.
 */
export function refuse(entries: OutboxEntry[], clientMsgId: string, code: string, message: string): OutboxEntry[] {
  if (!entries.some((entry) => entry.clientMsgId === clientMsgId)) return entries;
  return entries.map((entry) => {
    if (entry.clientMsgId !== clientMsgId) return entry;
    if (code === "host_updating") return rebuild(entry, "pending", { delivery: "queued" });
    if (code === "outcome_unknown") return rebuild(entry, "sending", { delivery: "held", hold: "unknown_outcome" });
    return entry.session === null
      ? rebuild(entry, "pending", { error: message, delivery: "held", hold: "maybe_created" })
      : rebuild(entry, "pending", { error: message, delivery: "queued" });
  });
}

function rebuild(entry: OutboxEntry, state: Outgoing["state"], next: { error?: string; delivery?: Delivery; hold?: HoldReason }): OutboxEntry {
  return {
    clientMsgId: entry.clientMsgId, text: entry.text, at: entry.at, state, session: entry.session,
    ...(entry.create ? { create: entry.create } : {}),
    ...(next.error ? { error: next.error } : {}),
    ...(next.delivery ? { delivery: next.delivery } : {}),
    ...(next.hold ? { hold: next.hold } : {}),
  };
}

/** True only for a message that may go out on its own: queued, and not refused by the host. */
export function autoSend(entry: OutboxEntry): boolean {
  return (entry.delivery ?? "queued") === "queued" && entry.error === undefined;
}

/**
 * What a reconnect may send by itself. Nothing goes from a queue this browser is not keeping (a
 * write it refused), and nothing held, refused or recovered goes without the person saying so.
 */
export function autoSendable(entries: readonly OutboxEntry[], keeping: boolean): OutboxEntry[] {
  return keeping ? entries.filter(autoSend) : [];
}

/** Exactly the messages a person named (a send, a retry), and nothing else in the queue with them. */
export function named(entries: readonly OutboxEntry[], ids: readonly string[]): OutboxEntry[] {
  const wanted = new Set(ids);
  return entries.filter((entry) => wanted.has(entry.clientMsgId) && autoSend(entry));
}

/**
 * What a send from a screen still waiting on its `create` means for that create's id.
 *
 * The states are not interchangeable proofs:
 * - `queued` without `error` means this phone never got the frame out (no socket) or the host
 *   refused before running it (`host_updating`), so changed words may be re-addressed.
 * - Same words are always the same message: the id is reused, which the host answers with the
 *   session it already has instead of starting a second one.
 * - Held, or `sending`, or a refused create: the host may already have it. Re-using the id would
 *   drop the new words; a new id could start a second session. The person decides (`held`), with the
 *   retry still on the message itself.
 */
export type CreateSend =
  | { kind: "retry"; clientMsgId: string }
  | { kind: "new"; clientMsgId: string }
  | { kind: "held" };

export function createSend(held: OutboxEntry | undefined, text: string, newId: () => string): CreateSend {
  if (held === undefined) return { kind: "new", clientMsgId: newId() };
  if (held.text.trim() === text.trim()) return { kind: "retry", clientMsgId: held.clientMsgId };
  if (held.state === "sending" || (held.delivery ?? "queued") !== "queued") return { kind: "held" };
  if (held.error !== undefined) return { kind: "held" };
  return { kind: "new", clientMsgId: newId() };
}

/** Put a refused or held message back in the queue under its own id, so a retry cannot run twice. */
export function requeue(entries: OutboxEntry[], clientMsgId: string): OutboxEntry[] {
  const retryable = (entry: OutboxEntry): boolean =>
    entry.clientMsgId === clientMsgId && (entry.error !== undefined || (entry.delivery ?? "queued") !== "queued");
  if (!entries.some(retryable)) return entries;
  return entries.map((entry) => retryable(entry) ? rebuild(entry, "pending", { delivery: "queued" }) : entry);
}

/**
 * Everything saved for computers this phone is not paired with now: the pre-identity list and every
 * other bucket (a replaced host key leaves one behind). Read-only — nothing here is ever sent; the
 * person can read and copy the words and, if they choose, copy some into this computer's queue.
 * Values that cannot be read back are carried out as raw text and are never parsed into messages.
 */
export interface PreservedLoad {
  status: "ok" | "unavailable";
  /** readable messages, deduplicated, and not already waiting in this computer's queue */
  items: PreservedItem[];
  /** stored values this app cannot read: shown as text, never sent */
  raw: string[];
}

/**
 * One preserved message, with an opaque handle for the screen to select and copy by. The handle
 * covers the bucket, the id and the words, so two messages with the same id and different text stay
 * two separate choices — and nothing about the bucket that held them is shown.
 */
export interface PreservedItem {
  key: string;
  entry: OutboxEntry;
}

/** A stable, opaque handle. Not a security boundary: it only has to tell items apart and look like nothing. */
function opaqueKey(parts: readonly string[]): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const code = part.charCodeAt(i);
      a = Math.imul(a ^ code, 0x01000193) >>> 0;
      b = Math.imul(b + code, 0x85ebca6b) >>> 0;
    }
    a = Math.imul(a ^ 0x1f, 0x01000193) >>> 0;
    b = Math.imul(b ^ 0x2f, 0xc2b2ae35) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

export function preserved(store: OutboxStore, currentKey: string | null, current: readonly OutboxEntry[] = []): PreservedLoad {
  let keys: string[];
  try {
    keys = store.keys ? store.keys() : [];
  } catch {
    return { status: "unavailable", items: [], raw: [] };
  }
  if (!store.keys) return { status: "unavailable", items: [], raw: [] };
  const waiting = new Map(current.map((entry) => [entry.clientMsgId, entry.text]));
  const seen = new Set<string>();
  const items: PreservedItem[] = [];
  const raw: string[] = [];
  for (const key of keys) {
    if (key === currentKey) continue;
    if (key !== OUTBOX_KEY && !key.startsWith(`${OUTBOX_KEY}.`)) continue;
    const load = loadOutbox(store, key);
    if (load.status === "unavailable") return { status: "unavailable", items: [], raw: [] };
    if (load.status === "unreadable") { raw.push(load.raw); continue; }
    if (load.status === "empty") continue;
    if (load.status === "partial") raw.push(load.raw);
    for (const entry of load.entries) {
      if (waiting.get(entry.clientMsgId) === entry.text) continue;
      // The handle is the message, not the bucket: two identical copies are one item, and one id
      // with two different texts stays two items the person can choose between.
      const handle = opaqueKey([entry.clientMsgId, entry.text]);
      if (seen.has(handle)) continue;
      seen.add(handle);
      items.push({ key: handle, entry });
    }
  }
  items.sort((a, b) => a.entry.at - b.entry.at);
  return { status: "ok", items, raw };
}

/**
 * Copy chosen preserved messages into this computer's queue. The copy is `recovered`: it waits until
 * the person sends it, it is never bound to a session id from another computer, and a message id
 * already waiting here is never duplicated. The originals are not touched.
 *
 * A message whose id is already here with *different* words is a conflict: it is not imported and
 * the caller is told, rather than silently preferring one of the two texts.
 */
export function adopt(current: OutboxEntry[], picked: readonly OutboxEntry[]): { entries: OutboxEntry[]; added: number; conflicts: OutboxEntry[] } {
  const waiting = new Map(current.map((entry) => [entry.clientMsgId, entry.text]));
  const added: OutboxEntry[] = [];
  const conflicts: OutboxEntry[] = [];
  for (const entry of picked) {
    const text = waiting.get(entry.clientMsgId);
    if (text !== undefined) {
      if (text !== entry.text) conflicts.push(entry);
      continue;
    }
    waiting.set(entry.clientMsgId, entry.text);
    added.push({
      clientMsgId: entry.clientMsgId, text: entry.text, at: entry.at, state: "pending", session: null, delivery: "recovered",
      ...(entry.create ? { create: entry.create } : {}),
    });
  }
  return { entries: [...current, ...added], added: added.length, conflicts };
}
