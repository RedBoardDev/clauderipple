// Which session this phone tells the host it is looking at.
//
// An attached session is what the host keeps open for this phone: it streams events to it and counts
// it as being looked at for push purposes, so nothing buzzes a phone that is already reading. A
// phone that only ever attaches silences every session it walks through: the screen moves on, the
// host still believes the old session has an eye on it (B17). Leaving one has to be said, and it is
// only said when the screen actually moves.

export interface WatchFrames {
  /** session to detach, when the host must be told it is no longer being looked at */
  detach: string | null;
  /** session to attach, when the host must be told about the one that is */
  attach: string | null;
}

/**
 * The frames that make the host's idea of the screen match it. `watching` and `next` are session
 * ids; null means no session (another screen, or a fresh socket the host knows nothing about yet).
 */
export function watchFrames(watching: string | null, next: string | null): WatchFrames {
  return watching === next ? { detach: null, attach: null } : { detach: watching, attach: next };
}
