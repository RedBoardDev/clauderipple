# Personal fork: differences from the official repository

This file inventories what the personal fork `RedBoardDev/clauderipple` contains beyond the
official repository `PBJ-2/clauderipple`. It is a functional inventory, not a changelog and not a
copy of the official release history. See `CLAUDE.md` for the branch and deployment workflow.

## Comparison base and status

| Item | Value |
| --- | --- |
| Official reference | `refs/remotes/upstream/main` = `a7eb091361bfe20a5ae42429b0c4ae3960f58974` (2026-10-24) |
| Official content | 0.12.14 plus the subsequent official uninstall fix (`a7eb091`) |
| Integration branch | `integration/personal-main-2026-10-24` |
| Integration inputs | Oxion commit `f75b1a4`, official merge `a612a0e`, personal fork merge `4203a83`, native app branch `feature/macos-app` (`df0e76a`) |
| Last verified router deployment | 2026-10-24: personal build 0.12.14 from `91de284e17c3a47cab24dec1381b24a580d1e99e`, installed and drain-restarted. The real admin instance on port 8791 reports 0.12.14 and offers Oxion AI. Accounts/configuration were not reset. The separately built Swift application was not replaced during this router deployment. |
| Validation | Node: 1,873 passed, 12 skipped, 0 failed. Swift: 103 passed, 0 failed. Typecheck, npm build, native Release build, JavaScript syntax and diff checks passed. |
| Upstream PRs | None opened and none implied. Keeping a feature personal is a normal outcome (`CLAUDE.md`). |

The set of differences below is measured against the reference above. An official version number
alone does not identify which personal features a build carries; use the Git revision.

### Account semantics

The fork uses the **official** account-selection and quota-group semantics. The older fork's
separate `activeOwner` / last-success account tracker was removed and is **not retained**. The
enhanced displays consume the official pool metadata (`inUse`, `preferred`, credential `state`,
`cooldownSeconds`) instead. Native passthrough without account rotation does not fabricate a
credential-pool row; successful-response health accounting is separate from account selection.

## 1. All-account limits (router)

- `packages/router/src/limits.ts` (new): pure projection `buildLimitsAccount()` that builds, per
  account, the legacy `windows` array (kept for the mod and remote clients) plus additive fields:
  `id`, `label`, `preferred`, `active`, `health` (`paused-until`, `needs-login`, ...),
  `usageWindows` (`fiveHour`, `weekly`, epoch milliseconds), `unknown`, `stale`, `fetchedAt`, and
  `weeklyPace`.
- `packages/router/src/admin.ts`: `GET /api/limits` now lists **every** Claude account (the current
  login plus stored accounts, including ones awaiting a first snapshot or a new sign-in) and every
  ChatGPT account (paused and signed-out accounts are listed with their state and no windows).
  `?refresh=1` forces a fresh read. Only one Claude account keeps the legacy `windows`, so the mod
  status bar still shows Claude as one group.
- `packages/router/src/providers/anthropic-usage.ts`: `snapshot(force)`, per-account refresh
  schedule (15 s retry only for a failed account, 5 min TTL for healthy ones), `stale` marking
  instead of dropping last-known figures, and per-snapshot `at`.
- Tests: `packages/router/test/limits.test.ts`, `anthropic-usage.test.ts`, `admin.test.ts`,
  `ui-limits.test.ts`.

## 2. Custom admin web UI

- `packages/ui/app.js`, `style.css`, `i18n.js`: the Providers card renders per-account gauges
  (5-hour and weekly bars with percent, reset time, `Active`, `Preferred`, `Paused until`,
  `Needs login`, `Stale`, last-updated badges) under each subscription provider. Falls back to the
  text quota lines when `/api/limits` is missing or fails. Accessible progress bars and forced-colors
  styling are included. `limits.*` strings default to English in locales without a translation.
- The weekly pace is computed by the router (`weeklyPace`) but **not displayed** in the web UI.
- `pool.ready` labels were corrected in the zh/ja/es/pt translations (no longer "in use").
- Oxion appears in the preset list and its offline fallback `packages/ui/presets-fallback.js`
  (kept in sync with `presets.ts` by `packages/router/test/ui-oxion-provider.test.ts`).

## 3. Oxion AI provider

- `packages/router/src/presets.ts`: dedicated preset `oxion`, kind `openai-compatible`, base
  `https://oxionai.com/v1`, Bearer key, `GET /models` discovery, **Chat Completions wire only**,
  empty fallback model list (no fabricated models), no effort levels, `thinking: none`.
- `packages/router/src/admin.ts`: model discovery accepts `context_window` as a fallback when
  `context_length` is unusable.
- `packages/router/src/providers/openai/translate.ts`: an in-stream error whose `code` is a numeric
  HTTP status (400 to 599) is mapped; 429 becomes `rate_limit_error`, 5xx becomes the retryable
  `overloaded_error`.
- Tests: `presets.test.ts`, `openai-translate.test.ts`, `openai-adapter.test.ts`,
  `ui-oxion-provider.test.ts`.
- **Not verified:** the preset is marked `verified: false`. There has been no real Oxion request,
  no live service check, and no prompt-cache measurement. Reasoning effort is undocumented.

## 4. Security and file-permission safeguards

- `config.json` writes are owner-only (`0600`): `packages/router/src/admin.ts` (`writeConfigFile`),
  `power.ts`, and in the CLI the starter config and `picker on/off` (`packages/cli/src/index.ts`).
- `usage-history` file is created and narrowed to `0600` (`packages/router/src/usage-history.ts`).
- Admin API refuses any request carrying `Sec-Fetch-Site: cross-site`, in addition to the existing
  origin check on non-GET requests (`admin.ts`).
- Honest pool accounting: a non-2xx upstream answer no longer marks a credential as succeeded
  (`proxy.ts`).
- `picker off` runs every step even if one fails and reports a failing exit status; `uninstall`
  runs it first so a trusted CA or a Claude Desktop proxy entry cannot outlive the install
  (`packages/cli/src/picker.ts`, `index.ts`; tests `picker-off.test.ts`, `recovery.test.ts`).
- Keep-awake setup identifies Insomnia by bundle id (`com.kgarg.insomnia`) before quitting or
  trashing an app, and leaves any other `Insomnia.app` alone (`packages/cli/src/awake-setup.ts`).

## 5. Fork update guard

`packages/cli/src/update.ts` and `index.ts`: `clauderipple update` defaults to source `fork`. It
prints the checkout-based steps (`git switch main`, `git pull --ff-only origin main`, `npm pack`, `npm install --prefix ~/.clauderipple/lib`,
`clauderipple restart`), exits non-zero, and never installs the published npm package over the
personal build. `update --check --json` reports `newer: false, kind: "fork"` so the tray and the
dashboard never offer an update. `CLAUDERIPPLE_UPDATE_SOURCE=upstream` is an explicit opt-in that
restores the published flow; any other value stays on `fork`. Tests: `update.test.ts`.

## 6. Native macOS app (`apps/macos`)

117 new tracked files; Swift 6, macOS 26 floor, Xcode 26+ and XcodeGen needed. Bundle id
`com.clauderipple.mac`. Package: `apps/macos/RippleKit/Package.swift`.

- **Structure:** `RippleKit` (testable library: networking, wire models, polling store,
  formatting, UI components) and `RippleMac` (app shell: menu-bar panel and settings window).
  Build with `apps/macos/build.sh gen|test|build|install|open`. `ClaudeRipple.xcodeproj` is generated,
  not committed.
- **Menu-bar panel:** per-account 5-hour and weekly limits for Claude and ChatGPT accounts with
  badges, bars and reset timers, today strip, drain hint, keep-awake control, footer.
- **Settings panes:** Overview, Accounts (Claude and ChatGPT), Mapping (model slots), Workers and
  effort, Clients, Activity, Laptop (awake and tether), General (launch at login, router-down
  notification), About.
- **Router contract:** talks to the loopback admin API only; sends `Host: 127.0.0.1:<port>` and no
  `Origin` or `Sec-Fetch-Site`. Uses `/api/limits` when present, else `/api/claude-accounts` plus
  `/api/status`. Config edits re-read and rewrite the whole config with order-preserving JSON;
  mod settings writes use the read `revision` and rebase on a 409.
- **Dev aids:** `CLAUDERIPPLE_APP_ADMIN_URL` targets a stand-in router; `--snapshot <dir> [--demo]`
  renders PNGs offscreen.
- **Limitations:**
  - Not on the app: adding or editing providers (keys, probes, capability measurements), Google
    accounts, and phone pairing; these stay on the web dashboard.
  - Weekly **pace is not shown** (the router still emits `weeklyPace`; the app does not decode it,
    `Models/Limits.swift`). Badges, bars and reset timers remain.
  - arm64 only, non-sandboxed, signed with the first local code-signing identity if any (needed for
    notifications), otherwise unsigned. No notarized or distributed release.
  - Demo mode may still start background polling; it is not a provider smoke test.
- **Platform split:** macOS uses the native app; Windows and Linux keep the Electron tray
  (`packages/app`).

## 7. CLI, launcher and packaging changes for the native app

The native launcher changes are integrated with the newer official recovery and login contracts.

- `packages/cli/src/tray.ts`: on macOS `startTray` and `installTrayRuntime` open the native app
  with `/usr/bin/open -b com.clauderipple.mac` and never fetch Electron; failure prints
  `apps/macos/build.sh install`.
- `packages/cli/src/launcher.ts`: on macOS `app --install` opens the native app instead of writing
  a shell-script launcher bundle; `app --uninstall` removes only a legacy
  `com.clauderipple.launcher` bundle. Linux and Windows launchers are unchanged.
- `packages/cli/src/update.ts` / `index.ts`: Electron re-fetch after update is skipped on macOS.
- `packages/app/package.json`, `package.json`: macOS Electron build, notarize and release targets
  (`dist`, `release`, `mac` block) removed; `dist:win` and `release:win` kept.
- `packages/app/scripts/make-icons.mts`, `scripts/build-npm.mjs`: the npm package still includes the
  Electron tray and shared assets for Windows and Linux but omits macOS-only `.icns` and template
  icons. npm does not build or install the separately compiled Swift application.

## 8. Documentation delta

- `CLAUDE.md`: rewritten as personal-fork rules (branch ownership, official updates without losing
  personal work, upstream account semantics, update guard, validation, daily-driver safety).
- `docs/RELEASE.md`: platform app targets section; `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`,
  `docs/HANDOFF.ko.md`: small adjustments.
- README (all languages) and `CHANGELOG.md`: native app installation/platform documentation; the
  English README identifies the personal fork and links this inventory, and retains the Oxion entry.
  Official release history is preserved separately from the personal-fork additions.

## Official equivalents (not counted as personal deltas)

Several earlier personal fixes now exist in the official reference and are **not** listed above as
remaining differences: account display and in-use semantics (`inUse`, `preferred`), the official
quota-group behavior, and the official uninstall and recovery hardening up to `a7eb091`.

## Intentionally not integrated

These branches are retained as separate candidates. They are not lost work, and they are not
delivered functionality of this fork. This consolidation does not merge them or open upstream PRs.

| Branch | Tip | Content |
| --- | --- | --- |
| `refs/heads/pr/orchestrate-model-fallback-d22e80` | `d451a3c` (2026-10-23) | Experimental mod: ordered judge fallback chains and controls (about 27 files). |
| `refs/heads/pr/vigilant-mclaren-b7ccf9` | `1e697ad` (2026-10-23) | Experimental account pause handling across native and compatible routing (about 23 files). |

## Open points

- Oxion behavior against the real service and its prompt cache are untested.
- Windows/Linux launcher paths were exercised by isolated Node tests; no Windows or Linux binary
  distribution was built on this Mac. The Swift application was built, not launched against real accounts.
