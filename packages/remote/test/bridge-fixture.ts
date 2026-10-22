import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sessions } from "../src/sessions.ts";
import { BridgeClient } from "../src/bridge-client.ts";
import { PermissionQueue } from "../src/permissions.ts";
import type { DesktopProcess } from "../src/desktop.ts";

export const bridgeId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const tick = () => new Promise(resolve => setImmediate(resolve));
export const line = (value: unknown) => JSON.stringify(value) + "\n";

export interface BridgeFixture {
  root: string; file: string; registry: Map<string, DesktopProcess>;
  sessions: Sessions; posts: Record<string, unknown>[]; permissions: PermissionQueue;
  emit: (payload: unknown, source?: string) => void;
  closeStream: () => void;
  history: unknown[];
  stateReads: () => number;
  onSessions: () => number;
  advance: () => void;
  status: (value: string) => void;
  setNow: (value: number) => void;
  now: () => number;
}

/** A Mac session in bridge mode with a scripted Remote Control transport. */
export function bridgeFixture(t: import("node:test").TestContext, opts: { streamBodyless?: () => boolean; registry?: () => Map<string, DesktopProcess> } = {}): BridgeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-redteam-"));
  const projects = path.join(root, "projects");
  fs.mkdirSync(path.join(projects, "project"), { recursive: true });
  const file = path.join(projects, "project", `${bridgeId}.jsonl`);
  fs.writeFileSync(file, line({ type: "user", uuid: "old", cwd: root, message: { content: "old prompt" } }));
  const registry = opts.registry?.() ?? new Map<string, DesktopProcess>([[bridgeId, { sessionId: bridgeId, pid: 42, status: "idle", bridgeSessionId: "bridge" }]]);
  const posts: Record<string, unknown>[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let now = Date.now(), workerStatus = "idle", stateReads = 0, sessionsCalls = 0;
  const history: unknown[] = [];
  const client = new BridgeClient({ auth: () => ({ accessToken: "private-token", organizationUuid: "org", expiresAt: Date.now() + 60_000 }), fetch: async (url, options) => {
    if (options?.method === "POST") {
      posts.push(JSON.parse(String(options.body)));
      return new Response("{}", { status: 200 });
    }
    if (String(url).endsWith("/sessions/bridge")) {
      stateReads++;
      return Response.json({ worker_status: workerStatus });
    }
    if (String(url).includes("/events?sort_order=asc")) return Response.json({ data: history });
    if (String(url).includes("/events?sort_order=desc")) return Response.json({ data: [] });
    if (opts.streamBodyless?.()) return new Response(null, { status: 200 });
    return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; options?.signal?.addEventListener("abort", () => { try { c.close(); } catch { /* already closed */ } }, { once: true }); } }));
  } });
  const permissions = PermissionQueue.open(path.join(root, "permissions.json"));
  const sessions = new Sessions({ now: () => now, log() {}, dir: path.join(root, "host"), desktopProjects: projects, desktopRegistry: () => registry, desktopProcesses: () => "", bridgeClient: client, permissions,
    router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => { throw new Error("unused"); } },
    queryFn: () => { throw new Error("must not spawn SDK"); }, onEvent() {}, onSessions: () => { sessionsCalls++; } });
  t.after(async () => { sessions.shutdown(); await tick(); fs.rmSync(root, { recursive: true, force: true }); });
  let sequence = 0;
  return { root, file, registry, sessions, posts, permissions, history,
    emit: (payload, source = "worker") => controller!.enqueue(new TextEncoder().encode(`event: client_event\ndata: ${JSON.stringify({ source, event_id: `e${++sequence}`, sequence_num: sequence, payload })}\n\n`)),
    closeStream: () => controller!.close(),
    stateReads: () => stateReads, onSessions: () => sessionsCalls,
    advance: () => { now += 4000; }, setNow: (value: number) => { now = value; }, now: () => now,
    status: (value: string) => { workerStatus = value; } };
}

export const approval = (requestId: string, extra: Record<string, unknown> = {}) => ({
  type: "control_request", request_id: requestId,
  request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: `tool-${requestId}`, input: { command: "true" }, ...extra },
});
