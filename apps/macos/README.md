# ClaudeRipple for macOS (native menu-bar app)

SwiftUI menu-bar client for the local router's admin API (`http://127.0.0.1:8791`). It replaces the
Electron tray and most of the web dashboard: the panel shows every Claude and ChatGPT account's
5-hour and weekly limits with reset times and weekly pace; the settings window covers accounts,
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
      State/         RouterStore (polling), Usage (normalized accounts, pace), DrainAdvisor, MenuBarGauge
      Formatting/    countdowns, ages, percents
      UI/            Theme tokens, UsageBar, AccountCard, badges, mascot geometry, menu-bar icon, PaneKit
    Tests/RippleKitTests/   unit tests; Fixtures/*.json (made-up values only); Support/MockRouter
  RippleMac/         the app shell: MenuBarExtra panel (Panel/) and the settings window (Settings/)
  scripts/make-icon.swift   renders the icon set from brand/app-icon.svg
```

## Build

```sh
apps/macos/build.sh test      # RippleKit unit tests
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
  `/api/status` (ChatGPT accounts and the Claude pool's credential states). Pace is computed
  client-side when the router does not send it.
- Config edits go through `AdminClient.updateConfig`: re-read the whole config, change it, write it
  back. `JSONValue` keeps key order (provider order is routing order) and number literals.
  The config carries credentials: keep it in memory, never log it or put it in a fixture.
- Mod settings writes send `schemaVersion: 1` and the `revision` read; a 409 carries the current
  snapshot to rebase on.

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
