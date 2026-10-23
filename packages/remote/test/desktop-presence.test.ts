import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { HostServer, type Peer } from "../src/server.ts";
import type { ClientMsg, HostMsg } from "../src/protocol.ts";
import { bridgeFixture, bridgeId, tick } from "./bridge-fixture.ts";

class Phone implements Peer {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  frames: HostMsg[] = [];
  private handlers = new Map<string, ((data?: unknown) => void)[]>();
  send(text: string): void { this.frames.push(JSON.parse(text) as HostMsg); }
  close(): void { this.terminate(); }
  terminate(): void { this.readyState = 3; for (const fn of this.handlers.get("close") ?? []) fn(); }
  on(event: "message" | "close" | "error", fn: (data?: unknown) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(fn);
    this.handlers.set(event, handlers);
  }
  request(msg: ClientMsg): void { for (const fn of this.handlers.get("message") ?? []) fn(JSON.stringify(msg)); }
}

test("hidden attached phones keep 3 s polling and share a watch until the last detach", async t => {
  let closed = 0;
  const f = bridgeFixture(t, { watchTranscript: () => () => { closed++; } });
  let polls = 0;
  const poll = f.sessions.pollDesktop.bind(f.sessions);
  f.sessions.pollDesktop = async () => { polls++; await poll(); };
  const server = new HostServer({ listen: "127.0.0.1", port: 0, token: "test", webDir: fileURLToPath(new URL("../web", import.meta.url)), sessions: f.sessions,
    router: { status: async () => ({ ok: true, proxyEnv: {} }), models: async () => [] }, hostName: "test", version: "test", recentCli: async () => [] });
  t.mock.timers.enable({ apis: ["setInterval"] });
  await server.listen();
  t.after(() => server.close());
  const phones = [new Phone(), new Phone()];
  for (const phone of phones) {
    server.connected(phone);
    phone.request({ t: "hello", token: "test", clientId: "phone" });
    phone.request({ t: "attach", session: bridgeId });
    phone.request({ t: "presence", visible: false });
  }
  await tick();
  assert.equal(server.someoneLooking(), false);
  for (let i = 0; i < 3; i++) {
    f.advance();
    t.mock.timers.tick(3000);
    await tick();
    assert.equal(polls, i + 1, "hidden attached session polls on every tick");
  }
  phones[0]!.request({ t: "detach", session: bridgeId });
  assert.equal(closed, 0, "the other phone still needs the watcher");
  phones[1]!.request({ t: "detach", session: bridgeId });
  assert.equal(closed, 1);
  for (const phone of phones) phone.request({ t: "attach", session: bridgeId });
  await tick();
  phones[0]!.terminate();
  assert.equal(closed, 1);
  phones[1]!.terminate();
  assert.equal(closed, 2, "disconnect closes the last watch too");
});
