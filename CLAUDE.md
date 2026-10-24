# ClaudeRipple - personal fork rules

## Repository and branch ownership

- This is the personal fork `RedBoardDev/clauderipple`. `origin` is this fork;
  `upstream` is the official `PBJ-2/clauderipple` repository.
- **`main` is the complete, stable personal fork**, not a mirror of the official
  repository. It includes validated personal additions and official updates.
  Start ordinary worktrees and personal feature branches from this `main`.
- `upstream/main` is the official reference. Do not use it as the base for an
  ordinary personal change: doing so can omit the fork's existing features.
- Use short-lived `feature/*` branches for implementation and `eval/*` branches
  for experiments. Evaluation does not by itself authorize implementation,
  merging, publication, or an upstream pull request. Keeping a feature personal
  is a normal outcome; an upstream contribution is never required.
- Only when an upstream contribution is explicitly wanted, create a clean
  `contrib/*` branch from `upstream/main` and include only that contribution.
  The same feature may be integrated into the personal fork independently.
  **Never open an upstream PR merely because code was evaluated or developed.**
- Historical release/feature branches and other worktrees may contain personal
  work. Inspect their actual diffs before consolidation; never assume a version
  number, a green test suite, or an up-to-date upstream mirror contains it all.
  Preserve uncommitted work, staging, and recovery refs. Do not delete another
  session's branch or worktree as cleanup.

## Official updates without losing personal work

- Fetch the official repository, then merge `upstream/main` into an integration
  branch based on the personal `main`. Resolve conflicts by behavior and tests,
  not by accepting one side wholesale. Do not reset the fork to upstream or
  rewrite the published personal `main` to make it look like upstream.
- Keep the official account-selection and quota-group semantics. Personal admin
  displays must consume upstream metadata such as `inUse`; do not reintroduce
  the obsolete separate last-success account tracker.
- Preserve the native macOS application (`apps/macos`), personal admin UI and
  account/limits displays, provider additions, and fork-specific security and
  installation safeguards while bringing in newer official fixes.
- Keep the fork update guard: normal updates must not install the official npm
  package over the personal build. `CLAUDERIPPLE_UPDATE_SOURCE=upstream` is an
  explicit opt-in, not the default. Keep newer upstream safety fixes as well.
- After validation, integrate into the personal `main` and push to the fork when
  authorized. Do not turn an official update into an upstream PR automatically.
- Use the tested personal `main` revision for deployment. Record its Git revision
  with the deployment outcome; an upstream version number alone is insufficient
  to identify which personal features are installed. Do not deploy an arbitrary
  worktree, an evaluation branch, or an upstream-only build as the daily driver.

## Architecture and validation

- Read `docs/ARCHITECTURE.md` before touching routing, TLS, or provider code.
  Every fact there has a source; do not re-derive or contradict it without new
  evidence. Section 5 lists failure modes that must not be reintroduced.
- Reference implementations (proxenos, chatgpt-codex-proxy) are behavioral
  specs only. **Never copy code from them.** Own implementation in TypeScript.
- Product boundary: Code tab + subagents. Do not spend effort on general chat.
- Acceptance metrics are non-negotiable: zero vanished requests, ≥90% cache
  hit on translated providers, remote-control workers survive upstream failure.
  A documented but unmeasured provider must not be described as live-verified.
- Router, CLI, and web code use TypeScript/JavaScript and Node 24. The native
  macOS application uses Swift. No Python in the product.
- Run relevant regression tests and, for an integration, `npm test`,
  `npm run typecheck`, and `npm run build`. Native changes also require
  `apps/macos/build.sh test` and `apps/macos/build.sh build` when the toolchain
  is available. Name any unavailable or skipped checks; do not claim they passed.
- Exercise UI changes with isolated fixtures. A simulated connection is not a
  real provider smoke test, and a native demo may still start background polling.
  Never use real accounts or the daily router for disposable test traffic.
- Keep the "not affiliated" notice in README and both applications' About screens.

## Daily-driver safety

- The live router is this repo's npm build installed in `~/.clauderipple/lib`,
  run by launchd (`com.clauderipple.router`). Read the proxy and admin ports from
  the active configuration; do not assume defaults. A restart alone does not pick
  up repository changes: `npm pack` →
  `npm install --prefix ~/.clauderipple/lib <tgz>` → `clauderipple restart`.
- Git maintenance authorization does not by itself authorize replacing or
  restarting the live installation. When deployment is requested, preserve the
  existing accounts/configuration, use the verified personal build, and retain
  a rollback path. Do not inspect or display credential values.
- Never kill or restart the router casually. `clauderipple restart` drains
  in-flight requests; see ARCHITECTURE §5. Do not use `kill -9` or
  `launchctl kickstart -k` as an ordinary update mechanism.
- The native Swift app and the npm router are separate build artifacts. Preserve
  their launcher/runtime-path contracts; building the npm package alone does not
  build or install the Swift application.
- The Python prototype (`~/.local/share/claude-router/`, 8790) and proxenos (8787)
  were retired 2026-09-20. Do not consult or start them.
