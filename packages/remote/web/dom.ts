import { t } from "./i18n.ts";

export { esc } from "./esc.ts";

const svg = (body: string, size = 20): string =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icon = {
  back: (s?: number) => svg(`<path d="M15 5l-7 7 7 7"/>`, s),
  chevron: (s?: number) => svg(`<path d="M9 6l6 6-6 6"/>`, s),
  down: (s?: number) => svg(`<path d="M6 9l6 6 6-6"/>`, s),
  folder: (s?: number) => svg(`<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>`, s),
  disk: (s?: number) => svg(`<rect x="3.5" y="6" width="17" height="12" rx="2.4"/><path d="M3.5 12.5h17"/><circle cx="7.6" cy="15.4" r="0.9" fill="currentColor"/>`, s),
  model: (s?: number) => svg(`<path d="M12 3.5l7.5 4.3v8.4L12 20.5l-7.5-4.3V7.8z"/><path d="M12 12l7.3-4.1M12 12v8.3M12 12L4.7 7.9"/>`, s),
  send: (s?: number) => svg(`<path d="M12 19V5M6 11l6-6 6 6"/>`, s),
  stop: (s?: number) => `<svg class="ic" width="${s ?? 20}" height="${s ?? 20}" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor"/></svg>`,
  gear: (s?: number) => svg(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>`, s),
  terminal: (s?: number) => svg(`<path d="M5 7l5 5-5 5M12 18h7"/>`, s),
  file: (s?: number) => svg(`<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/>`, s),
  pencil: (s?: number) => svg(`<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>`, s),
  search: (s?: number) => svg(`<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>`, s),
  globe: (s?: number) => svg(`<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.6 5.4 3.6 8.5s-1.2 5.9-3.6 8.5c-2.4-2.6-3.6-5.4-3.6-8.5s1.2-5.9 3.6-8.5z"/>`, s),
  check: (s?: number) => svg(`<path d="M5 12.5l4.5 4.5L19 7.5"/>`, s),
  x: (s?: number) => svg(`<path d="M6 6l12 12M18 6L6 18"/>`, s),
  clock: (s?: number) => svg(`<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`, s),
  shield: (s?: number) => svg(`<path d="M12 3.5l7 2.8v5.2c0 4.4-3 7.8-7 9-4-1.2-7-4.6-7-9V6.3z"/>`, s),
  task: (s?: number) => svg(`<path d="M8 6h11M8 12h11M8 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>`, s),
  home: (s?: number) => svg(`<path d="M4 11l8-6.5 8 6.5"/><path d="M6 9.5V19h12V9.5"/>`, s),
  bell: (s?: number) => svg(`<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>`, s),
  up: (s?: number) => svg(`<path d="M12 19V7M7 11l5-5 5 5"/><path d="M5 4.5h14"/>`, s),
  /** A row's own actions: three dots, so the row is not one button with a second button inside it. */
  more: (s?: number) => `<svg class="ic" width="${s ?? 20}" height="${s ?? 20}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="18.5" cy="12" r="1.7" fill="currentColor"/></svg>`,
  copy: (s?: number) => svg(`<path d="M8 8h12v12H8z"/><path d="M16 8V4H4v12h4"/>`, s),
};

export function toolIcon(name: string): string {
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") return icon.terminal(16);
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") return icon.pencil(16);
  if (name === "Read" || name === "Glob" || name === "Grep" || name === "LS") return name === "Read" ? icon.file(16) : icon.search(16);
  if (name === "WebFetch" || name === "WebSearch") return icon.globe(16);
  if (name === "Task" || name === "Agent") return icon.model(16);
  if (name === "TodoWrite") return icon.task(16);
  return icon.chevron(16);
}

export function relTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return t("time.now");
  if (s < 3600) return t("time.min", { n: Math.max(1, Math.round(s / 60)) });
  if (s < 86400) return t("time.hour", { n: Math.round(s / 3600) });
  return t("time.day", { n: Math.round(s / 86400) });
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t("dur.s", { n: s });
  // An hour and up reads as hours and minutes ("1시간 47분"), not "107분".
  if (s >= 3600) {
    const m = Math.round(s / 60);
    return m % 60 === 0 ? t("dur.h", { n: m / 60 }) : t("dur.hm", { h: Math.floor(m / 60), m: m % 60 });
  }
  if (s % 60 === 0 || s >= 600) return t("dur.m", { n: Math.round(s / 60) });
  return t("dur.ms", { m: Math.floor(s / 60), s: s % 60 });
}

export function clock(at: number): string {
  const d = new Date(at);
  // The phone's own 12/24-hour choice and language decide the shape; the fixed form is only a
  // fallback for a runtime without Intl data.
  try { return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(d); }
  catch { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
}

/** A file size on a phone: whole bytes below a kilobyte, then KB and MB with one decimal only
 * where the extra digit says something (8.4 MB, but 74 MB). */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export { folderName } from "./sidebar.ts";

export function shortPath(path: string, home?: string): string {
  return home && (path === home || path.startsWith(home + "/")) ? "~" + path.slice(home.length) : path;
}
