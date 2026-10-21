#!/usr/bin/env node
// Regenerates every icon the desktop app and its launchers use. The desktop app wears the Ripple
// Remote phone app's icon (brand/remote-app-icon.svg, a copy of the phone app's assets/icon.svg:
// the remote with Claude's asterisk and its signal arcs), so both apps read as one product.
// Run: npm --workspace @clauderipple/app run icons
//
//   assets/trayWin*{,@2x}.png        Windows tray, 32/64px, coloured (Windows does not tint)
//   assets/icon.png                  1024 app icon on the existing grid (Linux .desktop, window icon)
//   assets/icon.ico                  Windows grid, 16–256 (window icon, Start Menu / Desktop shortcut)
//   build/icon.png                   Windows-grid render; not committed
// macOS uses apps/macos instead; no template tray icons or .icns are generated here.
//
// assets/ is committed and shipped in the npm package (scripts/build-npm.mjs), so publishing needs
// no browser. Rendering is headless Chrome screenshotting the SVGs (CHROME= to point at another
// Chromium; Chrome, Chromium and Edge are looked for). With no browser the committed PNG is
// copied into build/ and nothing is redrawn; the committed Windows .ico stays available.
//
// Tray states (menu bar and Windows alike): the remote as a one-colour glyph, drawn in the icon's
// own coordinates (the asterisk and the dots are cut out of a solid pill):
//   ok     : the remote and both signal arcs
//   warn   : the same with a "!" badge at the lower right, cut out of the pill
//   down   : switched off: a hollow pill, a dash for the asterisk, no arcs
//   direct : no arcs (nothing goes through the router) and an arrow badge: Claude goes straight out
// Windows does not tint its tray, so it carries the state in colour as well.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.resolve(app, "..", "..", "brand");
const assets = path.join(app, "assets");
const build = path.join(app, "build");
fs.mkdirSync(assets, { recursive: true });
fs.mkdirSync(build, { recursive: true });

function findBrowser(): string | null {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.find((p): p is string => !!p && fs.existsSync(p)) ?? null;
}

const browser = findBrowser();
if (!browser) {
  for (const file of ["icon.png"]) {
    const from = path.join(assets, file);
    if (!fs.existsSync(from)) throw new Error(`no Chrome/Chromium/Edge to render icons with (set CHROME=) and no committed assets/${file} to fall back on`);
    fs.copyFileSync(from, path.join(build, file));
  }
  console.log("no browser found: kept the committed icons in assets/ and copied the app icon into build/");
  process.exit(0);
}

// ---- rendering --------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-icons-"));
const run = promisify(execFile);
let seq = 0;
/** Screenshots `html` on a transparent `size`×`size` page into `out`. */
async function shoot(html: string, size: number, out: string): Promise<void> {
  const id = seq++;
  const page = path.join(tmp, `${id}.html`);
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}.i>svg{display:block;width:100%;height:100%}</style>${html}`);
  // No --user-data-dir: headless makes a throwaway profile per run already, and with a fresh
  // explicit one Chrome for Testing 155 cut the 128px icon to its top half (a smaller first viewport).
  await run(browser!, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--default-background-color=00000000", `--window-size=${size},${size}`, `--screenshot=${out}`, `file://${page}`]);
}
const jobs: (() => Promise<void>)[] = [];
const queue = (html: string, size: number, out: string) => jobs.push(() => shoot(html, size, out));
async function drain(width = 6): Promise<void> {
  const next = async (): Promise<void> => {
    const job = jobs.shift();
    if (!job) return;
    await job();
    await next();
  };
  await Promise.all(Array.from({ length: width }, next));
}
// Inline, not <img src=data:…>, so nothing decodes after load. Each page holds one SVG, so its
// ids cannot collide.
const img = (svg: string, size: number, style = "") => `<div class="i" style="width:${size}px;height:${size}px;${style}">${svg}</div>`;

// ---- the remote glyph, in pieces (brand/remote-app-icon.svg's coordinates) --------------------
// The icon's artwork sits in the square 140,250 → 300,410: the pill is 196,302 48×90, the arcs are
// centred on the pill's top (220,302). The tray glyph uses heavier strokes than the icon so it
// survives 22pt, and its square viewBox (TRAY_VIEW) is centred on the pill.

const C = "currentColor";
const TRAY_VIEW = "150 258 140 140";
const PILL = `<rect x="196" y="302" width="48" height="90" rx="24" fill="${C}"/>`;
const PILL_HOLLOW = `<rect x="200.5" y="306.5" width="39" height="81" rx="19.5" fill="none" stroke="${C}" stroke-width="9"/>`;
const ASTERISK_CUT = `<path d="M220 312V340M207.9 319L232.1 333M207.9 333L232.1 319" stroke="#000" stroke-width="8.5" stroke-linecap="round"/>`;
const DOTS_CUT = `<circle cx="220" cy="358" r="6" fill="#000"/><circle cx="220" cy="375" r="6" fill="#000"/>`;
const DOTS = `<circle cx="220" cy="358" r="5.5" fill="${C}"/><circle cx="220" cy="375" r="5.5" fill="${C}"/>`;
const DASH = `<path d="M210 326H230" stroke="${C}" stroke-width="9" stroke-linecap="round"/>`;
const ARCS = `<path d="M205.9 287.9A20 20 0 0 1 234.1 287.9" stroke="${C}" stroke-width="9.5" stroke-linecap="round" fill="none"/><path d="M194.5 276.5A36 36 0 0 1 245.5 276.5" stroke="${C}" stroke-opacity=".55" stroke-width="9.5" stroke-linecap="round" fill="none"/>`;
/** The solid remote: a pill with the asterisk and the dots cut out, so the background shows through. */
const REMOTE = `<mask id="p"><rect x="150" y="258" width="140" height="140" fill="#fff"/>${ASTERISK_CUT}${DOTS_CUT}</mask><g mask="url(#p)">${PILL}</g>`;
/**
 * A badge at the lower right, centred at x `cx`: the glyph is cut away around it so it reads as its
 * own shape. The "!" stands clear of the pill (a cut that only nicks the pill's edge reads as a
 * defect); the arrow cuts into it, as if leaving the remote.
 */
function badge(body: string, glyph: string, id: string, cx: number): string {
  return `<defs><mask id="${id}"><rect x="150" y="258" width="140" height="140" fill="#fff"/><circle cx="${cx}" cy="371" r="24" fill="#000"/></mask></defs><g mask="url(#${id})">${body}</g>${glyph}`;
}
const BANG = `<path d="M268 352v15" stroke="${C}" stroke-width="10" stroke-linecap="round"/><circle cx="268" cy="385" r="5.6" fill="${C}"/>`;
const ARROW = `<path d="M243 371h31M262 359l12 12-12 12" fill="none" stroke="${C}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`;

type State = "ok" | "warn" | "down" | "direct";
const STATES: State[] = ["ok", "warn", "down", "direct"];
function trayMark(state: State): string {
  if (state === "ok") return REMOTE + ARCS;
  if (state === "warn") return badge(REMOTE + ARCS, BANG, "w", 268);
  if (state === "down") return PILL_HOLLOW + DASH + DOTS;
  return badge(REMOTE, ARROW, "d", 261);
}
const traySvg = (body: string, color: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${TRAY_VIEW}" style="color:${color}">${body}</svg>`;

// Windows tray: coloured, since Windows does not tint. ok is the icon's own orange; the alarms keep
// tones that hold on both a light and a dark taskbar.
const WIN_NAME: Record<State, string> = { ok: "trayWin", warn: "trayWinWarn", down: "trayWinDown", direct: "trayWinDirect" };
const WIN_TONE: Record<State, string> = {
  ok: "#E2725B", // the remote's orange (asterisk and arcs on the app icon)
  warn: "#d9a21c", // amber, between warn #b5820a and #e0b436
  down: "#e04848", // between bad #c73434 and #ef5a5a
  direct: "#8a96a6", // slate: off on purpose, not an alarm
};
for (const s of STATES) {
  const svg = traySvg(trayMark(s), WIN_TONE[s]);
  queue(img(svg, 32), 32, path.join(assets, `${WIN_NAME[s]}.png`));
  queue(img(svg, 64), 64, path.join(assets, `${WIN_NAME[s]}@2x.png`));
}

// ---- app icon (brand/remote-app-icon.svg) -----------------------------------------------------

const ART = fs.readFileSync(path.join(brand, "remote-app-icon.svg"), "utf8").replace(/^\s*<svg[^>]*>|<\/svg>\s*$/g, "");
/**
 * The square artwork cut to the icon's rounded tile (rx 22.4% of the side, as the macOS template
 * and the previous tile). The phone icon is full-bleed because iOS masks it; the desktop draws the
 * mask itself.
 */
const rounded = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="140 250 160 160"><clipPath id="t"><rect x="140" y="250" width="160" height="160" rx="35.84"/></clipPath><g clip-path="url(#t)">${body}</g></svg>`;
/**
 * The tile for a given pixel size. From 48px up it is the phone icon as drawn. Below that the dots
 * and 6-wide strokes go to mush, so the remote loses its dots, gets a shorter pill and heavier
 * strokes and is drawn larger; at 16–24px the faint outer arc goes too.
 */
function tile(px: number): string {
  if (px >= 48) return rounded(ART);
  const outer = px > 24 ? `<path d="M194.5 276.5A36 36 0 0 1 245.5 276.5" stroke="#E2725B" stroke-opacity=".55" stroke-width="9" stroke-linecap="round" fill="none"/>` : "";
  const cy = px > 24 ? 318 : 326; // centre of what is drawn, scaled about the tile's centre
  const k = px > 24 ? 1.22 : 1.38;
  const remote =
    `<rect x="196" y="302" width="48" height="74" rx="24" fill="#FFFFFF"/>` +
    `<path d="M220 323V349M208.7 329.5L231.3 342.5M208.7 342.5L231.3 329.5" stroke="#E2725B" stroke-width="8" stroke-linecap="round" fill="none"/>` +
    `<path d="M205.9 287.9A20 20 0 0 1 234.1 287.9" stroke="#E2725B" stroke-width="9" stroke-linecap="round" fill="none"/>${outer}`;
  return rounded(`<rect x="140" y="250" width="160" height="160" fill="#2A2420"/><g transform="translate(220 330) scale(${k}) translate(-220 -${cy})">${remote}</g>`);
}
/** macOS grid: the tile is 824/1024 of the canvas, centred, with Apple's soft drop shadow. */
function macIcon(size: number): string {
  const t = Math.round((size * 824) / 1024);
  const shadow = size >= 64 ? `filter:drop-shadow(0 ${(size * 10) / 1024}px ${(size * 12) / 1024}px rgba(0,0,0,.3))` : "";
  return `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">${img(tile(t), t, shadow)}</div>`;
}
/** Windows grid: the tile nearly fills the canvas (Windows draws no shadow or plate of its own). */
function winIcon(size: number): string {
  const t = size - 2 * Math.max(1, Math.round(size / 32));
  return `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">${img(tile(t), t)}</div>`;
}

// Preserve the shared window/Linux icon's appearance without generating a macOS iconset.
queue(macIcon(1024), 1024, path.join(assets, "icon.png"));
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
for (const s of ICO_SIZES) queue(winIcon(s), s, path.join(tmp, `ico-${s}.png`));
queue(winIcon(1024), 1024, path.join(build, "icon.png"));

await drain();

/** PNG-compressed .ico (Windows Vista and later read PNG entries). */
function ico(pngs: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}
fs.writeFileSync(path.join(assets, "icon.ico"), ico(ICO_SIZES.map((size) => ({ size, data: fs.readFileSync(path.join(tmp, `ico-${size}.png`)) }))));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`icons written to ${assets} (Windows tray, icon.png/.ico) and ${build} (icon.png)`);
