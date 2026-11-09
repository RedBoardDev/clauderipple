// Thinking blocks another model left in a conversation that is now going to Anthropic.
//
// The translated providers hand the CLI their reasoning as `thinking` blocks, and an empty `thinking`
// when the upstream sent a reasoning item without a summary. The CLI keeps them in the transcript, so
// a session switched from such a model to a Claude model replays them, and Anthropic refuses the
// whole request: "messages.2.content.0.thinking: each thinking block must contain thinking" (measured
// 2026-09-28, gpt-6-astra → claude-opus-5-5, every retry of the turn).
//
// A block Anthropic wrote always carries a signature of Anthropic's own, a base64 string this router
// cannot produce. A translation provider cannot produce one either, so it signs with an envelope of
// its own naming where the reasoning came from (reasoning.ts) — which Anthropic would refuse just as
// fast, and which is why those go too. What is left that is signed is Anthropic's.
//
// The translated adapters themselves keep their own replayed reasoning (that is the point of the
// envelope), so this is the one place a translated provider's thinking must still be dropped: a
// CLI-side switch to a Claude model. Gemini and the other translators drop `thinking` on their own.
import crypto from "node:crypto";
import { isOurSignature } from "./reasoning.ts";

export type ThinkingBlock = { type?: unknown; signature?: unknown; data?: unknown };
type Block = ThinkingBlock;

/** Process-local provenance, bounded globally; only digests, never reasoning or signatures, survive. */
export class ThinkingOrigins {
  private readonly origins = new Map<string, Set<string>>();
  private readonly max: number;
  private firstProvider: string | undefined;
  private multipleProviders = false;
  constructor(max = 100_000) { this.max = max; }

  private key(block: ThinkingBlock): string | undefined {
    const value = block.type === "thinking" ? block.signature : block.type === "redacted_thinking" ? block.data : undefined;
    return typeof value === "string" && value.length > 0
      ? crypto.createHash("sha256").update(`${block.type}\0${value}`).digest("hex") : undefined;
  }

  remember(provider: string, block: ThinkingBlock): void {
    const key = this.key(block);
    if (!key) return;
    if (this.firstProvider === undefined) this.firstProvider = provider;
    else if (this.firstProvider !== provider) this.multipleProviders = true;
    const providers = this.origins.get(key) ?? new Set<string>();
    providers.add(provider);
    this.origins.set(key, providers);
    if (this.origins.size > this.max) this.origins.delete(this.origins.keys().next().value!);
  }

  /** Ordinary requests do no history hashing until another provider has minted a block. */
  dropKnownForeign(json: Record<string, unknown>, provider: string): number {
    if (!this.multipleProviders && (this.firstProvider === undefined || this.firstProvider === provider)) return 0;
    return dropForeignThinking(json, block => {
      const key = this.key(block);
      const owners = key === undefined ? undefined : this.origins.get(key);
      // Unknown/evicted origins survive recovery; a target observed minting the same block owns it too.
      return owners === undefined || owners.has(provider);
    });
  }

  owns(provider: string, block: ThinkingBlock): boolean {
    const key = this.key(block);
    return key !== undefined && this.origins.get(key)?.has(provider) === true;
  }
}
type Message = { role?: unknown; content?: unknown };

function foreign(block: unknown, belongsToTarget?: (block: ThinkingBlock) => boolean): boolean {
  const b = block as Block | null;
  if (!b || typeof b !== "object") return false;
  // Opaque vendor signatures (and encrypted redactions) cannot be validated by another provider.
  if (belongsToTarget && (b.type === "thinking" || b.type === "redacted_thinking")) return !belongsToTarget(b);
  if (b.type !== "thinking") return false;
  // Unsigned: a translated provider's reasoning with nothing to carry, or an empty reasoning item.
  // Ours: a translated provider's envelope, which only its own adapter can read back.
  return !(typeof b.signature === "string" && b.signature.length > 0) || isOurSignature(b.signature);
}

/**
 * Removes foreign thinking blocks from assistant turns, in place, and returns how many went.
 * A reroute keeps only blocks observed from its target; ordinary native signatures stay.
 * A turn left with no content is removed with them: Anthropic refuses an empty assistant turn,
 * and joins the two user turns that then meet.
 */
export function dropForeignThinking(json: Record<string, unknown>, belongsToTarget?: (block: ThinkingBlock) => boolean): number {
  const messages = json.messages;
  if (!Array.isArray(messages)) return 0;
  let removed = 0;
  const kept: unknown[] = [];
  for (const message of messages as Message[]) {
    if (message?.role !== "assistant" || !Array.isArray(message.content) || !message.content.some(block => foreign(block, belongsToTarget))) {
      kept.push(message);
      continue;
    }
    const content = message.content.filter((block) => !foreign(block, belongsToTarget));
    removed += message.content.length - content.length;
    if (content.length > 0) kept.push({ ...message, content });
  }
  if (removed > 0) json.messages = kept;
  return removed;
}
