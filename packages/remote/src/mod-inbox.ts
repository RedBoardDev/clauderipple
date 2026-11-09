export interface ModOffer { sessionId: string; itemId: string; text: string; offeredAt: number }
export type ModOutcome = "submitted" | "failed";

type OfferState = { offer: ModOffer; claimed: boolean; resolve: (state: "claimed" | "withdrawn" | "expired") => void; timer: ReturnType<typeof setTimeout> };

/** In-memory arbitration; the claim callback must persist before the winner is told. */
export class ModInbox {
  private offers = new Map<string, OfferState>();
  private persist: (offer: ModOffer) => boolean;
  private finish: (offer: ModOffer, outcome: ModOutcome) => void;
  private resultMs: number;
  private onError: (error: unknown) => void;
  /** Two minutes: a slow submit hook reported failed while it still runs would invite a resend (2026-10-27). */
  constructor(persist: (offer: ModOffer) => boolean, finish: (offer: ModOffer, outcome: ModOutcome) => void, resultMs = 120_000, onError: (error: unknown) => void = console.error) {
    this.persist = persist; this.finish = finish; this.resultMs = resultMs; this.onError = onError;
  }

  offer(offer: ModOffer, waitMs: number): Promise<"claimed" | "withdrawn" | "expired"> | null {
    if (this.offers.has(offer.itemId)) return null;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.offers.delete(offer.itemId);
        resolve("expired");
      }, waitMs);
      this.offers.set(offer.itemId, { offer, claimed: false, resolve, timer });
    });
  }

  pending(sessionId: string): ModOffer[] {
    return [...this.offers.values()].filter(state => !state.claimed && state.offer.sessionId === sessionId).map(state => ({ ...state.offer }));
  }

  claim(itemId: string): boolean {
    const state = this.offers.get(itemId);
    if (!state || state.claimed) return false;
    state.claimed = true;
    clearTimeout(state.timer);
    try {
      if (!this.persist(state.offer)) {
        state.claimed = false;
        this.offers.delete(itemId);
        state.resolve("withdrawn");
        return false;
      }
    } catch (error) {
      // Persistence may have reached disk before failing: never fall back to a second writer.
      state.timer = setTimeout(() => { try { this.result(itemId, "failed"); } catch (failure) { this.onError(failure); } }, this.resultMs);
      state.resolve("claimed");
      throw error;
    }
    state.timer = setTimeout(() => { try { this.result(itemId, "failed"); } catch (error) { this.onError(error); } }, this.resultMs);
    state.resolve("claimed");
    return true;
  }

  withdraw(itemId: string): boolean {
    const state = this.offers.get(itemId);
    if (!state || state.claimed) return false;
    clearTimeout(state.timer);
    this.offers.delete(itemId);
    state.resolve("withdrawn");
    return true;
  }

  result(itemId: string, outcome: ModOutcome): boolean {
    const state = this.offers.get(itemId);
    if (!state?.claimed) return false;
    this.finish(state.offer, outcome);
    clearTimeout(state.timer);
    this.offers.delete(itemId);
    return true;
  }

  close(): void {
    for (const [id, state] of this.offers) {
      clearTimeout(state.timer);
      if (!state.claimed) state.resolve("withdrawn");
      this.offers.delete(id);
    }
  }
}
