// Screens as strings of markup. The app and the screenshot fixtures both call these, so the
// mockups in docs/media/remote are the shipped UI, not a drawing of it.
import type { BrowseResult, Effort, FolderEntry, HostInfo, ProviderGroup, SessionSummary, Text, ImagePart } from "../src/protocol.ts";
import type { LinkStatus } from "./conn.ts";
import type { PushAvail } from "./pushstate.ts";
import { clock, duration, esc, folderName, icon, relTime, shortPath, toolIcon } from "./dom.ts";
import { t, lang } from "./i18n.ts";
import { activitySummary } from "../src/tool-details.ts";
import type { Key } from "./i18n.ts";
import { markdown } from "./md.ts";
import { ripple, stateRing } from "./mascot.ts";
import { sidebarSections, sidebarState } from "./sidebar.ts";
import type { TimelineItem, SessionView, ToolView } from "./timeline.ts";

export interface Draft { cwd: string | null; model: string | null; effort: Effort | null }

export type Sheet =
  | { kind: "folder"; recent: FolderEntry[]; browse: BrowseResult | null; filter: string; loading: boolean }
  | { kind: "model"; groups: ProviderGroup[]; recent: string[]; model: string | null; effort: Effort | null; forSession: string | null };

export interface UI {
  now: number;
  link: LinkStatus;
  host: HostInfo | null;
  home: string | undefined;
  sessions: SessionSummary[];
  groups?: string[] | undefined;
  draft: Draft;
  models: ProviderGroup[];
  sheet: Sheet | null;
  /** expanded tool outputs, by tool-use id, with the text once fetched */
  expanded: Map<string, string | null>;
  workersOpen: boolean;
  permOpen: Set<string>;
  toast: string | null;
  /** whether notifications can work here, and are on; null until known */
  push?: PushAvail | null;
  /** the person said "later" to the notification card */
  pushLater?: boolean;
}

// ---- small helpers -----------------------------------------------------------------------------

export function modelName(models: ProviderGroup[], id: string | null): string {
  if (!id) return t("chip.model");
  for (const g of models) for (const m of g.models) if (m.model === id) return m.name;
  return id;
}

function effortLabel(e: Effort | null): string {
  return e ? t(`effort.${e}` as Key) : "";
}

function textOf(v: Text): string {
  return typeof v === "string" ? v : v.preview + "…";
}

/** A link is "lost" (not merely reconnecting) once it has been down for 30 s: say so plainly. */
export function linkKind(link: LinkStatus, now: number): "open" | "connecting" | "waiting" | "offline" | "denied" | "lost" {
  if (link.state === "open" || link.state === "denied" || link.state === "offline") return link.state;
  // A phone that slept or switched networks is often silent for half a minute; saying "lost" then
  // alarmed people over nothing (Discord, 2026-10-22). It is a calm wait, not an error, either way.
  if (link.downSince !== null && now - link.downSince > 60_000) return "lost";
  return link.state;
}

/** What copy calls the connected computer: its name once known, the neutral fallback before that. */
export function hostName(ui: UI): string {
  return ui.host?.name ?? t("host.fallback");
}

export function linkPill(ui: UI): string {
  const kind = linkKind(ui.link, ui.now);
  const host = hostName(ui);
  let label: string;
  if (kind === "open") label = t("conn.open");
  else if (kind === "offline") label = t("conn.offline");
  else if (kind === "denied") label = t("conn.denied.title");
  else if (ui.link.state === "waiting" && ui.link.nextAt) label = t("conn.retryIn", { s: Math.max(1, Math.ceil((ui.link.nextAt - ui.now) / 1000)) });
  else label = ui.link.attempt > 0 ? t("conn.retrying") : t("conn.connecting");
  return `<button class="link ${kind}" data-act="retry" aria-live="polite"><span class="dot"></span><span class="host">${esc(host)}</span><span>${esc(label)}</span></button>`;
}

/** The connection banner. Nothing when all is well; a slim line while retrying briefly; a card once it is a real outage. */
export function banner(ui: UI): string {
  const kind = linkKind(ui.link, ui.now);
  const seen = ui.link.lastRx ? t("conn.lastSeen", { time: clock(ui.link.lastRx) }) : "";
  if (kind === "open") {
    if (ui.host && !ui.host.routerOk) return `<div class="banner warn">${ripple("uneasy", 34)}<div class="txt">${esc(t("conn.router", { host: hostName(ui) }))}</div></div>`;
    if (ui.host?.desktopProblem) return `<div class="banner warn">${ripple("uneasy", 34)}<div class="txt">${esc(t("conn.desktop", { problem: ui.host.desktopProblem }))}</div></div>`;
    return "";
  }
  if (kind === "denied") {
    return `<div class="banner bad">${ripple("sorry", 40)}<div class="txt"><b>${esc(t("conn.denied.title"))}</b>${esc(t("conn.denied.body", { host: hostName(ui) }))}</div></div>`;
  }
  if (kind === "offline") {
    return `<div class="banner bad">${ripple("sleepy", 40)}<div class="txt"><b>${esc(t("conn.offline.title"))}</b>${esc(t("conn.offline.body"))}${seen ? `<small>${esc(seen)}</small>` : ""}</div></div>`;
  }
  if (kind === "lost") {
    const ago = duration(ui.now - (ui.link.downSince ?? ui.now));
    return `<div class="banner warn">${ripple("sleepy", 40)}<div class="txt"><b>${esc(t("conn.lost.title", { host: hostName(ui) }))}</b>${esc(t("conn.lost.body", { ago, host: hostName(ui) }))}${seen ? `<small>${esc(seen)}</small>` : ""}<div class="act"><button class="btn primary" data-act="retry">${esc(t("conn.retryNow"))}</button></div></div></div>`;
  }
  if (ui.link.attempt === 0) return "";
  return `<div class="banner slim">${icon.clock(16)}<span>${esc(ui.link.lastRx ? t("conn.stale", { time: clock(ui.link.lastRx) }) : t("conn.connecting"))}</span></div>`;
}

// ---- home --------------------------------------------------------------------------------------

function sessionRow(s: SessionSummary, ui: UI): string {
  const tag = s.pending > 0
    ? `<span class="tag">${esc(t("state.waiting"))}${s.pending > 1 ? ` ${s.pending}` : ""}</span>`
    : s.state === "running" || s.state === "starting" ? `<span class="tag run">${esc(t("state.running"))}</span>` : "";
  return `<button class="row" data-act="open" data-id="${esc(s.id)}">${s.state === "error" && !s.pending ? ripple("sorry", 24) : stateRing(sidebarState(s), 24)}<div class="body"><div class="t1">${esc(s.title)}</div><div class="t2"><span>${esc(folderName(s.cwd, ui.home))}</span><span class="sep">·</span><span class="m">${esc(modelName(ui.models, s.model))}</span><span class="sep">·</span><span>${esc(relTime(s.updatedAt, ui.now))}</span></div></div>${tag}</button>`;
}

export function homeMain(ui: UI): string {
  const sections = sidebarSections(ui.sessions, ui.groups);
  // While the link is down the states below are the last ones seen, and look it.
  const stale = ui.link.state === "open" ? "" : " stale";
  const sec = (title: string, list: SessionSummary[]): string =>
    list.length ? `<div class="sec">${esc(title)}</div><div class="list${stale}">${list.map((s) => sessionRow(s, ui)).join("")}</div>` : "";
  const empty = ui.sessions.length === 0
    ? `<div class="empty">${ripple("calm", 84)}<b>${esc(t("home.empty.title"))}</b><p>${esc(t("home.empty.body", { host: hostName(ui) }))}</p><div class="hint">${icon.down(22)}</div></div>`
    : "";
  return `<div class="lt">${esc(t("home.title"))}</div>${banner(ui)}${sections.map(g => sec(g.name, g.sessions)).join("")}${empty}${pushCard(ui)}<div style="height:12px"></div>`;
}

/** Below the list, near the thumb: turn notifications on, or what it takes on this phone. Gone once on or dismissed. */
export function pushCard(ui: UI): string {
  const p = ui.push;
  if (!p || p === "on" || p === "unsupported" || ui.pushLater) return "";
  const later = `<button class="btn ghost" data-act="push-later">${esc(t("push.later"))}</button>`;
  const body = p === "off" ? t("push.body") : p === "install" ? t("push.install") : p === "denied" ? t("push.denied") : t("push.insecure", { host: hostName(ui) });
  const action = p === "off" ? `<button class="btn primary" data-act="push-on">${icon.bell(18)}${esc(t("push.on"))}</button>` : "";
  return `<div class="banner push">${icon.bell(22)}<div class="txt"><b>${esc(t("push.title"))}</b>${esc(body)}<div class="act">${action}${later}</div></div></div>`;
}

export function homeTop(ui: UI): string {
  return `${linkPill(ui)}<span class="spacer"></span><button class="icon-btn" data-act="settings" aria-label="${esc(t("a11y.settings"))}">${icon.gear(21)}</button>`;
}

export function chips(ui: UI): string {
  const folder = ui.draft.cwd ? folderName(ui.draft.cwd, ui.home) : t("chip.folder");
  const eff = ui.draft.effort ? `<span class="eff">${esc(effortLabel(ui.draft.effort))}</span>` : "";
  return `<div class="chips"><button class="chip folder" data-act="pick-folder">${icon.folder(18)}<span class="lbl">${esc(folder)}</span></button><button class="chip model" data-act="pick-model">${icon.model(18)}<span class="lbl">${esc(modelName(ui.models, ui.draft.model))}</span>${eff}<span class="down">${icon.down(16)}</span></button></div>`;
}

export function composer(placeholder: string, mode: "send" | "stop", value = ""): string {
  const btn = mode === "stop"
    ? `<button class="send stop" data-act="stop" aria-label="${esc(t("composer.stop"))}">${icon.stop(18)}</button>`
    : `<button class="send" data-act="send" aria-label="${esc(t("composer.send"))}" ${value.trim() ? "" : "disabled"}>${icon.send(20)}</button>`;
  return `<div class="composer"><textarea id="input" rows="1" placeholder="${esc(placeholder)}" enterkeyhint="send" autocomplete="off">${esc(value)}</textarea>${btn}</div>`;
}

// ---- session -----------------------------------------------------------------------------------

export function sessionTop(ui: UI, s: SessionSummary | undefined, view: SessionView): string {
  const model = view.model ?? s?.model ?? null;
  const eff = view.effort ?? s?.effort ?? null;
  const state = s?.desktopBridge ? s.state : view.open.length ? "waiting" : view.state ?? s?.state ?? "stopped";
  if (s?.readOnly) return `<button class="icon-btn" data-act="home" aria-label="${esc(t("a11y.back"))}">${icon.back(22)}</button><div class="title"><b>${esc(s.title || folderName(s.cwd, ui.home))}</b><span>${esc(modelName(ui.models, model))}</span></div>${stateRing("stopped", 24)}`;
  return `<button class="icon-btn" data-act="home" aria-label="${esc(t("a11y.back"))}">${icon.back(22)}</button><div class="title"><b>${esc(s ? s.title || folderName(s.cwd, ui.home) : "")}</b><button data-act="pick-model-session"><span>${esc(modelName(ui.models, model))}${eff ? ` · ${esc(effortLabel(eff))}` : ""}</span>${icon.down(14)}</button></div><span class="icon-btn${ui.link.state === "open" ? "" : " stale"}" aria-label="${esc(t(`state.${state}` as Key))}">${stateRing(state, 24)}</span>`;
}

function pct(v: number | null): string {
  return v === null ? `<div class="v na">—</div>` : `<div class="v">${Math.round(v)}%</div>`;
}

export function band(ui: UI, view: SessionView): string {
  const f = view.figures;
  const ctx = f?.contextPct ?? null;
  const five = f?.fiveHourPct ?? null;
  const tone = (v: number | null): string => (v === null ? "" : v >= 85 ? "bad" : v >= 65 ? "warn" : "");
  const bar = (v: number | null): string => `<div class="bar ${tone(v)}"><i style="width:${v === null ? 0 : Math.min(100, Math.max(2, v))}%"></i></div>`;
  const cells = `<div class="cell"><div class="k">${esc(t("band.effort"))}</div>${f?.effort ? `<div class="v">${esc(effortLabel(f.effort))}</div>` : `<div class="v na">—</div>`}</div>` +
    `<div class="cell"><div class="k">${esc(t("band.cache"))}</div>${pct(f?.cachePct ?? null)}</div>` +
    `<div class="cell"><div class="k">${esc(t("band.context"))}</div>${pct(ctx)}${bar(ctx)}</div>` +
    `<div class="cell"><div class="k">${esc(t("band.fiveHour"))}</div>${pct(five)}${bar(five)}</div>`;
  let workers = "";
  if (ui.workersOpen) {
    const list = f?.workers ?? [];
    const rows = list.length
      ? list.map((w) => `<div class="w"><span>${esc(w.model)}</span><span>${esc(t("band.workerLine", { n: w.requests }))}</span></div>`).join("")
      : `<div class="none">${esc(t("band.workersNone"))}</div>`;
    const foot = [f?.fiveHourResetAt ? t("band.resetsAt", { time: clock(f.fiveHourResetAt) }) : "", f ? t("band.updated", { time: clock(f.at) }) : ""].filter(Boolean).join(" · ");
    workers = `<div class="workers"><div class="k" style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:4px">${esc(t("band.workers"))}</div>${rows}${foot ? `<div class="foot">${esc(foot)}</div>` : ""}</div>`;
  }
  return `<button class="band${ui.link.state === "open" ? "" : " stale"}" data-act="workers" aria-expanded="${ui.workersOpen}">${cells}</button>${workers}`;
}

function images(parts?: ImagePart[]): string {
  return (parts ?? []).map(part => part.blob
    ? `<button class="conversation-image" data-act="image" data-blob="${esc(part.blob)}" data-media="${esc(part.mediaType)}" aria-label="${esc(t('image.view'))}"><span>${esc(t('tool.loading'))}</span><img hidden alt="${esc(t('image.view'))}" /></button>`
    : `<div class="image-unavailable">${esc(t('image.unavailable'))}</div>`).join('');
}

function toolRow(tool: ToolView, ui: UI): string {
  const open = ui.expanded.has(tool.id);
  const st = !tool.result ? `<span class="st run">${icon.clock(15)}</span>` : tool.result.ok ? `<span class="st">${icon.check(15)}</span>` : `<span class="st bad">${icon.x(15)}</span>`;
  const row = `<button class="tool" data-act="tool" data-id="${esc(tool.id)}" aria-expanded="${open}">${toolIcon(tool.name)}<span class="nm">${esc(tool.name)}</span><span class="sm">${esc(tool.summary)}</span>${st}</button>`;
  if (!open) return row;
  const fetched = ui.expanded.get(tool.id);
  const body = fetched ?? [tool.input ? textOf(tool.input) : "", tool.result ? textOf(tool.result.text) : ""].filter(Boolean).join("\n\n────\n\n");
  return row + (body ? `<details class="tool-details"><summary>${esc(t("perm.showAll"))}</summary><div class="tool-out">${esc(body)}</div></details><div class="tool-preview tool-out">${esc(body.slice(0, 1200).split("\n").slice(0, 12).join("\n"))}${body.length > 1200 || body.split("\n").length > 12 ? "\n…" : ""}</div>` : "") + images(tool.result?.images);
}

export function item(it: TimelineItem, ui: UI): string {
  switch (it.type) {
    case "toolGroup": {
      const open = ui.expanded.has(it.key);
      const summary = activitySummary(it.rows, it.running, lang());
      const label = summary.text + (summary.added || summary.removed ? ` [+${summary.added} −${summary.removed}]` : "") + (summary.failed ? (lang() === "ko" ? " · 실패" : " · Failed") : "");
      return `<div class="tools"><button class="tool" data-act="tool-group" data-id="${esc(it.key)}" aria-expanded="${open}">${it.running ? stateRing("running", 16) : toolIcon("Bash")}<span class="sm">${esc(label)}</span><span style="transform:rotate(${open ? 90 : 0}deg)">${icon.chevron(16)}</span></button>${open ? it.rows.map(row => row.type === "tool" ? toolRow(row.tool, ui) : item(row, ui)).join("") : ""}</div>`;
    }
    case "start":
      return `<div class="start">${esc(t("history.start"))}</div>`;
    case "user": {
      const q = it.queued ? `<div class="q">${icon.clock(13)}${esc(it.queued === "pending" ? t("queue.pending") : t("queue.sending"))}</div>` : "";
      return `<div class="msg-user${it.queued ? " queued" : ""}">${esc(it.text)}${images(it.images)}${q}</div>`;
    }
    case "thinking":
      return `<details class="tool-details"><summary>${icon.clock(15)} ${lang() === "ko" ? "사고 과정" : "Thinking"}</summary><div class="tool-out">${esc(textOf(it.text))}</div></details>`;
    case "assistant": {
      const text = textOf(it.text);
      const caret = it.streaming ? `<span class="caret"></span>` : "";
      const html = text ? markdown(text) : "";
      const withCaret = caret ? (html.endsWith("</p>") ? html.slice(0, -4) + caret + "</p>" : html + caret) : html;
      const tools = it.tools.length ? `<div class="tools">${it.tools.map((tl) => toolRow(tl, ui)).join("")}</div>` : "";
      return `<div class="msg-asst">${withCaret}${images(it.images)}${tools}</div>`;
    }
    case "subagent": {
      const st = it.status === "running" ? t("sub.running") : it.status === "done" ? t("sub.done") : t("sub.failed");
      return `<button class="sub" data-act="sub" data-id="${esc(it.sub)}">${stateRing(it.status === "running" ? "running" : it.status === "done" ? "idle" : "error", 28)}<div class="body"><div class="k">${esc(t("sub.worker"))}${it.model ? `<span class="model">${esc(it.model)}</span>` : ""}<span>· ${esc(st)} · ${esc(t("sub.steps", { n: it.steps }))}</span></div><div class="d">${esc(it.description)}</div></div>${icon.chevron(18)}</button>`;
    }
    case "permission": {
      if (it.decision === null) return `<div class="perm-done open">${icon.shield(16)}<span class="nm">${esc(it.tool)}</span><span class="sm">${esc(it.summary)}</span><span>${esc(t("state.waiting"))}</span></div>`;
      const label = it.decision === "allow" ? t("perm.allowed") : it.decision === "allow_always" ? t("perm.allowedAlways") : it.decision === "deny" ? t("perm.denied") : t("perm.expired");
      const cls = it.decision === "allow_always" ? "allow" : it.decision;
      const why = it.decision === "expired" && it.reason ? `<span class="why">${esc(t(`perm.reason.${it.reason}` as Key, { host: hostName(ui) }))}</span>` : "";
      return `<div class="perm-done ${cls}">${it.decision === "allow" || it.decision === "allow_always" ? icon.check(16) : icon.x(16)}<span class="nm">${esc(it.tool)}</span><span class="sm">${esc(it.summary)}</span><span>${esc(label)}</span></div>${why ? `<div class="foot">${why}</div>` : ""}`;
    }
    case "result":
      if (!it.ok) return `<div class="foot bad">${icon.x(14)}${esc(t("turn.failed", { error: it.error ?? "" }))}</div>`;
      return `<div class="foot">${esc(t("turn.footer", { model: modelName(ui.models, it.model), effort: effortLabel(it.effort) || "—", dur: duration(it.ms) }))}</div>`;
    case "notice":
      return `<div class="notice">${esc(t(`notice.${it.code}` as Key, { text: it.text ?? "", host: hostName(ui) }))}</div>`;
  }
}

/** The open permission request, docked above the composer where the thumb already is. */
export function permCard(view: SessionView, ui: UI): string {
  const p = view.open[0];
  if (!p) return "";
  const open = ui.permOpen.has(p.id);
  const what = textOf(p.input) || p.summary;
  const long = what.split("\n").length > 5 || what.length > 280;
  return `<div class="perm" role="alertdialog" aria-label="${esc(t("perm.title", { tool: p.tool }))}"><div class="hd">${icon.shield(16)}<span>${esc(p.tool)}</span>${view.open.length > 1 ? `<span class="of">${esc(t("perm.of", { i: 1, n: view.open.length }))}</span>` : ""}</div><div class="q">${esc(p.title || t("perm.title", { tool: p.tool }))}</div><div class="what${open ? " open" : ""}">${esc(what)}</div>${long && !open ? `<button class="more" data-act="perm-more" data-id="${esc(p.id)}">${esc(t("perm.showAll"))}</button>` : ""}<div class="act"><button class="deny" data-act="deny" data-id="${esc(p.id)}">${esc(t("perm.deny"))}</button><button class="allow" data-act="allow" data-id="${esc(p.id)}">${icon.check(20)}${esc(t("perm.allow"))}</button></div>${p.canAlways ? `<button class="always" data-act="always" data-id="${esc(p.id)}">${esc(t("perm.always"))}</button>` : ""}</div>`;
}

export function workingLine(view: SessionView, ui: UI, s?: SessionSummary): string {
  if (!(view.state === "running" || view.state === "starting") || view.open.length) return "";
  // Disconnected, a ticking "working for" would claim knowledge we do not have: say when it was last seen working.
  if (ui.link.state !== "open") return `<div class="working stale">${icon.clock(16)}<span>${esc(t("running.lastSeen", { time: clock(ui.link.lastRx ?? ui.now) }))}</span></div>`;
  const since = s?.turnStartedAt ?? view.turnStartedAt ?? ui.now;
  return `<div class="working">${stateRing("running", 16)}<span>${esc(t("running.for", { t: duration(ui.now - since) }))}</span></div>`;
}

/** The background-task chip; with a task list from the host it opens to show what is running. */
export function tasks(ui: UI, s: SessionSummary | undefined, open: boolean): string {
  if (!s?.tasks) return "";
  const list = s.taskList ?? [];
  const chip = esc(t("tasks.running", { n: s.tasks }));
  if (!list.length) return `<div class="tasks-chip" role="status">${chip}</div>`;
  const rows = open ? `<div class="tasks-list">${list.map(task => `<div class="task">${task.kind === "shell" ? icon.terminal(16) : icon.model(16)}<span>${esc(task.label)}</span>${task.startedAt === null ? "" : `<time>${esc(duration(ui.now - task.startedAt))}</time>`}</div>`).join("")}</div>` : "";
  return `${rows}<button class="tasks-chip" data-act="toggle-tasks" aria-expanded="${open}">${chip}${open ? icon.down(14) : icon.chevron(14)}</button>`;
}

// ---- sheets ------------------------------------------------------------------------------------

export function sheet(ui: UI): string {
  const s = ui.sheet;
  if (!s) return "";
  const head = (title: string): string => `<div class="grab"></div><div class="sh"><b>${esc(title)}</b><button class="icon-btn" data-act="close-sheet" aria-label="${esc(t("a11y.close"))}">${icon.x(20)}</button></div>`;
  if (s.kind === "folder") {
    const f = s.filter.trim().toLowerCase();
    const recent = s.recent.filter((r) => !f || r.name.toLowerCase().includes(f) || r.path.toLowerCase().includes(f)).slice(0, 6);
    const recentHtml = recent.length
      ? `<div class="sec">${esc(t("folder.recent"))}</div><div class="list">${recent.map((r) => `<button class="opt${ui.draft.cwd === r.path ? " on" : ""}" data-act="choose-folder" data-path="${esc(r.path)}">${icon.folder(20)}<div class="body"><div class="t1">${esc(r.name)}</div><div class="t2">${esc(shortPath(r.path, ui.home))}${r.lastUsed ? ` · ${esc(relTime(r.lastUsed, ui.now))}` : ""}</div></div>${ui.draft.cwd === r.path ? `<span class="tick">${icon.check(20)}</span>` : ""}</button>`).join("")}</div>`
      : "";
    let browse = "";
    if (s.browse) {
      const b = s.browse;
      const rel = shortPath(b.path, b.home);
      const parts = rel.split("/").filter(Boolean);
      const crumbs = parts.map((p, i) => {
        const full = rel.startsWith("~") ? b.home + "/" + parts.slice(1, i + 1).join("/") : "/" + parts.slice(0, i + 1).join("/");
        return `${i ? `<span class="sl">/</span>` : ""}<button data-act="browse" data-path="${esc(i === 0 && rel.startsWith("~") ? b.home : full.replace(/\/$/, ""))}">${esc(p)}</button>`;
      }).join("");
      const entries = b.entries.filter((e) => !f || e.name.toLowerCase().includes(f));
      browse = `<div class="sec">${esc(t("folder.browse"))}</div><div class="crumbs">${crumbs}</div><div class="list">${b.parent ? `<button class="opt" data-act="browse" data-path="${esc(b.parent)}">${icon.up(20)}<div class="body"><div class="t1">${esc(t("folder.up"))}</div></div></button>` : ""}${entries.map((e) => `<button class="opt" data-act="browse" data-path="${esc(e.path)}">${icon.folder(20)}<div class="body"><div class="t1">${esc(e.name)}</div></div>${icon.chevron(18)}</button>`).join("") || `<div class="opt"><div class="body"><div class="t2">${esc(t("folder.empty"))}</div></div></div>`}</div>${b.truncated ? `<div class="sec">${esc(t("folder.truncated", { n: b.entries.length }))}</div>` : ""}`;
    }
    const target = s.browse?.path ?? ui.draft.cwd;
    const foot = target ? `<div class="sfoot"><div class="path">${esc(shortPath(target, ui.home))}</div><button class="btn primary" data-act="choose-folder" data-path="${esc(target)}">${esc(t("folder.here"))}</button></div>` : "";
    return `<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog">${head(t("folder.title"))}<div class="filter">${icon.search(18)}<input id="folder-filter" placeholder="${esc(t("folder.filter"))}" value="${esc(s.filter)}" autocomplete="off"></div><div class="sbody">${recentHtml}${browse}</div>${foot}</div>`;
  }
  const chosen = s.groups.flatMap((g) => g.models).find((m) => m.model === s.model);
  const recentIds = s.recent.filter((id) => s.groups.some((g) => g.models.some((m) => m.model === id && m.usable))).slice(0, 3);
  const opt = (m: { model: string; name: string; usable: boolean }, sub: string): string =>
    `<button class="opt${s.model === m.model ? " on" : ""}" data-act="choose-model" data-model="${esc(m.model)}" ${m.usable ? "" : "disabled"}>${icon.model(20)}<div class="body"><div class="t1">${esc(m.name)}</div><div class="t2 mono">${esc(sub)}</div></div>${s.model === m.model ? `<span class="tick">${icon.check(20)}</span>` : m.usable ? "" : `<span class="badge">${esc(t("model.unusable"))}</span>`}</button>`;
  const recentHtml = recentIds.length
    ? `<div class="sec">${esc(t("model.recent"))}</div><div class="list">${recentIds.map((id) => { const m = s.groups.flatMap((g) => g.models.map((x) => ({ ...x, label: g.label }))).find((x) => x.model === id)!; return opt(m, `${m.label} · ${m.model}`); }).join("")}</div>`
    : "";
  const groups = s.groups.map((g) => `<div class="sec">${esc(g.label)}${g.usable ? "" : ` · ${esc(t("model.unusable"))}`}</div><div class="list">${g.models.map((m) => opt(m, m.model)).join("")}</div>`).join("");
  const efforts = chosen?.efforts ?? [];
  const seg = efforts.length
    ? `<div class="seg-label"><span>${esc(t("model.effort"))}</span></div><div class="seg">${efforts.map((e) => `<button class="${s.effort === e ? "on" : ""}" data-act="choose-effort" data-effort="${e}">${esc(effortLabel(e))}</button>`).join("")}</div>`
    : `<div class="seg-label"><span>${esc(t("model.noEffort"))}</span></div>`;
  return `<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog">${head(t("model.title"))}<div class="sbody">${recentHtml}${groups}</div><div class="sfoot">${seg}<div style="height:10px"></div><button class="btn primary" data-act="model-done" ${s.model ? "" : "disabled"}>${esc(t("model.done"))}</button></div></div>`;
}

// ---- pairing -----------------------------------------------------------------------------------

export function pairScreen(): string {
  return `<div class="pair">${ripple("calm", 96)}<h1>${esc(t("pair.title"))}</h1><ol><li><div>${esc(t("pair.step1"))}<code>${esc(t("pair.where"))}</code></div></li><li><div>${esc(t("pair.step2"))}</div></li><li><div>${esc(t("pair.step3"))}</div></li></ol><div class="paste"><label for="pair-link">${esc(t("pair.paste"))}</label><div class="row"><input id="pair-link" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…#pair=…"><button class="btn primary" data-act="pair-link">${esc(t("pair.connect"))}</button></div></div><div class="note">${esc(t("pair.note"))}</div></div>`;
}
