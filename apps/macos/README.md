# ClaudeRipple for macOS (native menu-bar app)

Fork-only, optional SwiftUI menu-bar client for the local router's admin API (loopback; port discovered
from the router config). It does not replace the upstream Electron tray. The panel shows every Claude and ChatGPT account's
5-hour and weekly limits with reset times; the settings window covers accounts,
model mapping, workers and effort, clients, activity, laptop, general and about.

What stays on the web dashboard: adding or editing providers (API keys, probes, capability
measurements), Google accounts, and phone pairing (the QR code is a credential).

Not affiliated with Anthropic or OpenAI. Claude is a trademark of Anthropic, PBC; ChatGPT is a
trademark of OpenAI.

## Structure

```
apps/macos/
  project.yml        XcodeGen: RippleKit package + RippleMac app target (source of truth)
  build.sh           gen | test | build | install | open
  RippleKit/         Swift package: everything testable
    Sources/RippleKit/
      Networking/    Endpoint (port discovery), AdminClient, API.swift + API+<Pane>.swift
      Models/        wire types (Decodable), JSONValue (order-preserving JSON for config writes)
      State/         RouterStore (polling), Usage (normalized accounts), DrainAdvisor, MenuBarGauge
      Formatting/    countdowns, ages, percents
      UI/            Theme tokens, UsageBar, AccountCard, badges, mascot geometry, menu-bar icon, PaneKit
    Tests/RippleKitTests/   unit tests; Fixtures/*.json (made-up values only); Support/MockRouter
  RippleMac/         the app shell: MenuBarExtra panel (Panel/) and the settings window (Settings/)
  scripts/make-icon.swift   renders the icon set from brand/app-icon.svg
```

## Build

```sh
apps/macos/build.sh test      # Real admin contract recorder, then RippleKit tests
apps/macos/build.sh contract  # Record the admin contract alone (Node 24, no new dependencies)
apps/macos/build.sh build     # Release build into /tmp/clauderipple-mac-build (BUILD_DIR overrides)
apps/macos/build.sh install   # build, copy to /Applications, launch
```

Needs Xcode 26+ and XcodeGen (`brew install xcodegen`). The generated `ClaudeRipple.xcodeproj` is
not committed. The app is arm64, non-sandboxed, signed with the first local code-signing identity if
there is one (needed for notifications), otherwise unsigned.

`CLAUDERIPPLE_APP_ADMIN_URL` points the app at a stand-in router instead of the real one.

### Visual checks without screen recording

```sh
ClaudeRipple.app/Contents/MacOS/ClaudeRipple --snapshot <dir> [--demo] [--panes overview,accounts,…]
```

renders the panel, the menu-bar icon states and the given settings panes in light and dark to PNGs,
then quits. `--demo` uses made-up accounts (`DemoData`) and never polls. Without it the panes read
the live router (GETs only; nothing is saved unless a control is changed). Set `CLAUDERIPPLE_HOME`
to an empty folder so the Overview pane cannot run the CLI. Offscreen windows are never key, so
selection highlights, glass and prominent buttons draw in their inactive colours.

## Talking to the router

- The admin API's boundary is loopback + Host / Fetch-Metadata / Origin checks; there is no token.
  `AdminClient` sends `Host: 127.0.0.1:<port>` and never an `Origin` or `Sec-Fetch-Site` header.
- Older routers answer unknown routes with their dashboard page (HTTP 200, `text/html`).
  `AdminClient` turns that into `AdminError.routeMissing`, which panes use for capability detection.
- Limits: per-account `/api/limits` when the router has it, else `/api/claude-accounts` plus
  `/api/status` (ChatGPT accounts and the Claude pool's credential states).
- Config edits go through `AdminClient.updateConfig`: re-read the whole config, change it, write it
  back. `JSONValue` keeps key order (provider order is routing order) and number literals.
  The config carries credentials: keep it in memory, never log it or put it in a fixture.
- Mod settings writes send the app's hardcoded `schemaVersion: 2` and the `revision` read; a 409 carries the current
  snapshot to rebase on.

## Contract workflow after an upstream merge

Run `apps/macos/build.sh test`, then inspect
`git diff -- apps/macos/RippleKit/Tests/RippleKitTests/Fixtures/contract` and adapt the models to any
breaking changes. The Node recorder starts the real admin server on an ephemeral loopback port with
made-up accounts, isolated state and stubbed external boundaries. It records every decoded GET,
checks write bodies and effects, and writes the router version and mod-settings schema to `meta.json`.
Swift tests decode those responses with the app's models and compare the mod PUT body with the body
accepted by Node. Hand-written fixtures are reserved for UI and historical edge cases.

Always-present fields are required; missing or mistyped facts surface as
“Router API changed: <route> <field path>. Update the app.” Failed panes cannot save, and config PUTs
require a fresh, validated GET. Extra fields are ignored by typed projections and retained in JSON
documents. Review domain ladders are shown and preserved; their ordered model editing remains on the
web dashboard. The panel's quiet “untested router <version>” note compares `/api/status` with the
recorded metadata bundled into RippleKit; a version difference alone is not an error.

The upstream CLI still opens the Electron tray. To use only the optional native app, quit the
Electron tray and remove its login item with `clauderipple tray --login off`.

## Conventions

- Swift 6 language mode, macOS 26 floor. English for code, comments and UI strings.
- No magic numbers: named constants with a one-line reason.
- Each settings pane owns `RippleMac/Settings/<Name>Pane.swift` (plus `Settings/<Name>/` for its
  sub-views), its routes in `RippleKit/Sources/RippleKit/Networking/API+<Name>.swift`, its models in
  `RippleKit/Sources/RippleKit/Models/<Name>.swift`, and tests in
  `RippleKit/Tests/RippleKitTests/<Name>Tests.swift` with fixtures named `<name>-*.json`.
- Panes are `struct <Name>Pane: View { let app: AppController }`, read `@Environment(RouterStore.self)`,
  load with `Loadable` / `LoadableView`, and use `Form { Section { … } }.formStyle(.grouped)`.
- Colours come from `Theme` (brand accent, ok/warn/bad), never literals. Liquid Glass (`.glass`,
  `.glassProminent`) is for buttons and controls, not for content cards.
- Tests never reach the network: use `MockRouter.client { request in … }`.
