// Isolated tests for what the phone tells the host it is looking at (B17). The host holds an
// attached session open and counts it as read; a phone that only attaches goes on silencing every
// session it walked through.
import test from "node:test";
import assert from "node:assert/strict";
import { watchFrames } from "../web/watch.ts";

test("opening a session from the list tells the host to follow it", () => {
  assert.deepEqual(watchFrames(null, "s-1"), { detach: null, attach: "s-1" });
});

test("moving from one session to the next detaches the one being left", () => {
  assert.deepEqual(watchFrames("s-1", "s-2"), { detach: "s-1", attach: "s-2" });
});

// The reported case: A → B → home left both A and B attached, so their pushes were suppressed for
// as long as the app stayed open.
test("A → B → home leaves nothing attached, in that order", () => {
  let watching: string | null = null;
  const sent: { detach: string | null; attach: string | null }[] = [];
  for (const screen of ["s-a", "s-b", null] as (string | null)[]) {
    const frames = watchFrames(watching, screen);
    sent.push(frames);
    if (frames.detach !== null) watching = null;
    if (frames.attach !== null) watching = frames.attach;
  }
  assert.deepEqual(sent, [
    { detach: null, attach: "s-a" },
    { detach: "s-a", attach: "s-b" },
    { detach: "s-b", attach: null },
  ]);
  assert.equal(watching, null, "nothing is left attached once the app is back on the list");
});

test("staying on the same session sends nothing, however often the screen re-renders", () => {
  assert.deepEqual(watchFrames("s-1", "s-1"), { detach: null, attach: null });
  assert.deepEqual(watchFrames(null, null), { detach: null, attach: null });
});

test("a fresh socket knows nothing, so the session on screen is attached again", () => {
  // The host drops every attachment with the socket it was made on: after a reconnect the app
  // forgets what it had told the host and says it again, without a detach for a socket that is gone.
  assert.deepEqual(watchFrames(null, "s-1"), { detach: null, attach: "s-1" });
});
