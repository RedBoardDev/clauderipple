import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AdminDeps } from "../../../packages/router/src/admin.ts";
import type { Config } from "../../../packages/router/src/config.ts";
import type { PowerStatus } from "../../../packages/router/src/power.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = path.join(root, "apps/macos/RippleKit/Tests/RippleKitTests/Fixtures/contract");
const resource = path.join(root, "apps/macos/RippleKit/Sources/RippleKit/Resources/contract-meta.json");
const instant = 1_800_000_000_000;

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>; // Validated JSON object at the HTTP boundary.
}
function list(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}

/** WHY: compare protocol changes, not object insertion order, random ids or machine paths. */
function stable(value: unknown, home: string): unknown {
  if (Array.isArray(value)) return value.map(item => stable(item, home));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, child]) => {
      if (key === "uiRevision") return [key, "contract-ui"];
      if (key === "adminPort") return [key, 18792];
      if (key === "node") return [key, "/contract/node"];
      if (key === "router") return [key, "/contract/router.ts"];
      return [key, stable(child, home)];
    }));
  }
  if (typeof value === "string") {
    return value.replaceAll(home, "/contract/home")
      .replace(/([?&](?:state|code_challenge)=)[^&]+/g, "$1contract-value");
  }
  return value;
}

// A single serial scenario: the admin server has module-level login jobs and reads process env.
test("real admin GET contracts and native-client writes", async t => {
  const temporaryRoot = process.env.BUILD_DIR ?? os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const home = fs.mkdtempSync(path.join(temporaryRoot, "ripple-mac-contract-"));
  const environment = ["HOME", "CLAUDERIPPLE_HOME", "CLAUDE_SETTINGS_PATH", "CODEX_HOME", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY"];
  const previous = new Map(environment.map(key => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.CLAUDERIPPLE_HOME = home;
  process.env.CLAUDE_SETTINGS_PATH = path.join(home, "claude-settings.json");
  process.env.CODEX_HOME = path.join(home, "codex");
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY"]) delete process.env[key];
  t.mock.timers.enable({ apis: ["Date"], now: instant });
  let uuid = 0;
  t.mock.method(crypto, "randomUUID", () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`);
  const connect = net.connect;
  // buildStatus's reachability probe has no AdminDeps seam. Stub only its outbound TCP boundary;
  // loopback HTTP still exercises the real server, and no provider or daily-driver port is contacted.
  t.mock.method(net, "connect", (options: net.NetConnectOpts) => {
    if ("host" in options && options.host !== "127.0.0.1" && options.host !== "localhost") throw new Error("contract: outbound TCP disabled");
    return connect(options);
  });
  let admin: Awaited<ReturnType<typeof import("../../../packages/router/src/admin.ts").startAdmin>> | undefined;
  try {
    const { startAdmin } = await import("../../../packages/router/src/admin.ts");
    const { DEFAULTS } = await import("../../../packages/router/src/config.ts");
    const { Logger } = await import("../../../packages/router/src/log.ts");
    const { RequestLog } = await import("../../../packages/router/src/requestlog.ts");
    const claude = await import("../../../packages/router/src/providers/anthropic-accounts.ts");
    const chatgpt = await import("../../../packages/router/src/providers/chatgpt/accounts.ts");
    const { ObservedClaudeCodeAuth } = await import("../../../packages/router/src/providers/anthropic-observed.ts");
    const { MOD_SETTINGS_SCHEMA_VERSION, normalizeSettings } = await import("../../../packages/mod/hooks/settings.ts");
    const version: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(typeof object(version).version, "string");
    const routerVersion = String(object(version).version);
    const configFile = path.join(home, "config.json");
    const initial: Config = {
      ...structuredClone(DEFAULTS), admin: { port: 0 }, autoUpdate: false,
      providers: {
        claude: { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "claude-sonnet-5-5", name: "Sonnet 5.5" }] },
        chatgpt: { type: "chatgpt", auth: "own", url: "https://contract.invalid", models: [{ id: "gpt-6-1-sol", name: "Contract GPT", contextWindow: 475000 }] },
      },
      routes: { "claude-haiku-5-5": { provider: "chatgpt", model: "gpt-6-1-sol", effort: "medium", contextWindow: 475000 } },
      cli: { ...DEFAULTS.cli, agentFiles: true, extraModels: [{ model: "gpt-6-1-sol", name: "Contract GPT", contextWindow: 475000 }] },
    };
    fs.writeFileSync(configFile, JSON.stringify(initial));
    const config = (): Config => JSON.parse(fs.readFileSync(configFile, "utf8")); // Owned test fixture, not untrusted input.
    const stored = claude.saveClaudeOAuthAccount(home, { accessToken: "fake-claude-access", refreshToken: "fake-claude-refresh", expiresAt: instant + 3_600_000, accountId: "contract-claude", email: "claude@example.test" });
    const claims = Buffer.from(JSON.stringify({ email: "gpt@example.test", "https://api.openai.com/auth": { chatgpt_plan_type: "contract-plan" } })).toString("base64url");
    const gpt = chatgpt.saveChatGptAccount(home, { accessToken: "fake-chatgpt-access", refreshToken: "fake-chatgpt-refresh", idToken: `fake.${claims}.unsigned`, expiresAt: instant + 3_600_000, accountId: "contract-chatgpt" });
    const { syncAgentFiles } = await import("../../../packages/router/src/agents.ts");
    syncAgentFiles(initial, path.join(home, "agents"));
    claude.setCurrentClaudeLoginPaused(home, false);
    const observed = new ObservedClaudeCodeAuth();
    observed.observe(["authorization", "Bearer fake-observed-credential"]);
    const quota = { at: instant, plan_type: "contract-plan", rate_limits: { primary: { used_percent: 24, window_minutes: 300, reset_at: instant / 1000 + 3600 }, secondary: { used_percent: 42, window_minutes: 10080, reset_at: instant / 1000 + 86400 } } };
    let cooling = true;
    const gptRows = () => chatgpt.readChatGptAccounts(home).map(account => ({
      ...chatgpt.summarize(account), state: account.paused ? "paused" as const : cooling ? "cooling" as const : "ready" as const,
      ...(cooling ? { cooldownSeconds: 60 } : {}), quota, active: !account.paused, inUse: !account.paused,
    }));
    const requests = new RequestLog(path.join(home, "logs/requests.jsonl"));
    requests.add({ id: "contract-request", at: new Date(instant - 1000).toISOString(), ms: 1250, status: 200, ok: true, kind: "messages", source: "claude-haiku-5-5", target: "gpt-6-1-sol", provider: "chatgpt", effort: "medium", stream: true, usage: { input: 100, cached: 900, cacheWrite: 50, output: 75 }, session: "contract-session" });
    fs.mkdirSync(path.join(home, "logs"), { recursive: true });
    fs.writeFileSync(path.join(home, "logs/router.log"), "Contract router ready\n");
    const review = { mode: "ladder", rungs: { light: [{ target: { agent: "general-purpose", model: "sonnet" }, effort: "medium" }], hard: [{ target: { agent: "general-purpose", model: "opus" }, effort: "high" }] } };
    fs.writeFileSync(path.join(home, "mod-settings.json"), JSON.stringify({ revision: 1, stored: true, settings: normalizeSettings({ domainRules: { review }, bias: 1 }) }));
    const cliCalls: string[][] = [];
    // picker/status-mod call runCli directly instead of deps.runCli. paths.json is its supported
    // invocation boundary: point it at a disposable fake CLI, never the installed one.
    const fakeCLI = path.join(home, "fake-cli.mjs");
    fs.writeFileSync(fakeCLI, `
      import fs from 'node:fs'; import path from 'node:path';
      const home = process.env.CLAUDERIPPLE_HOME;
      const [command, value] = process.argv.slice(2);
      fs.writeFileSync(path.join(home, command + '.state'), value);
      if (command === 'mod') {
        const file = process.env.CLAUDE_SETTINGS_PATH;
        const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
        settings.env = { ...settings.env, CLAUDE_CODE_PLUGIN_DIRS: value === 'on' ? path.join(home, 'mod') : '' };
        fs.writeFileSync(file, JSON.stringify(settings));
      }
      console.log('Contract CLI ok');
    `);
    fs.mkdirSync(path.join(home, "mod/.claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(home, "mod/.claude-plugin/plugin.json"), JSON.stringify({ name: "clauderipple-status" }));
    fs.writeFileSync(path.join(home, "paths.json"), JSON.stringify({ node: process.execPath, cli: fakeCLI }));
    const runCli: NonNullable<AdminDeps["runCli"]> = async args => {
      cliCalls.push(args);
      if (args[0] === "update") return { ok: true, output: JSON.stringify({ current: routerVersion, latest: "99.0.0", newer: true, kind: "npm" }) };
      if (args[0] === "claude-logout") for (const account of claude.listClaudeAccounts(home)) claude.removeClaudeAccount(home, account.id);
      if (args[0] === "codex") {
        const { codexOn, codexOff } = await import("../../../packages/cli/src/codex.ts");
        if (args[1] === "on") codexOn(18790, process.env.CODEX_HOME!, [], home);
        else codexOff(process.env.CODEX_HOME!, home);
      }
      return { ok: true, output: "Contract CLI ok" };
    };
    const power = (): PowerStatus => ({
      platform: "darwin", awake: { mode: config().awake?.mode ?? "working", applied: true, reason: "contract model call", setup: "ok", battery: { percent: 82, onBattery: false }, thermal: "normal", lidClosed: true, until: config().awake?.until ?? null, conflict: null },
      tether: { enabled: config().tether?.enabled ?? true, network: "wifi", state: "watching", pinned: false, hotspotSsid: "Contract hotspot", lastSwitch: { at: new Date(instant).toISOString(), to: "wifi", ok: true, reason: "contract" }, lastProbe: { at: new Date(instant).toISOString(), ok: true, network: "wifi" }, hint: null },
    });
    admin = await startAdmin({
      config, configFile, log: new Logger(null, 1_000_000, 1, false), version: routerVersion, requests,
      stats: () => ({ inFlight: 1, messagesInFlight: 1, started: 3, completed: 2, failed: 0 }), health: () => 0,
      agentDir: path.join(home, "agents"), claudeCodeCredentialReaders: { keychain: () => null, credentialsFile: () => null }, observedClaudeCodeAuth: observed,
      credentials: () => {
        const accounts = claude.listClaudeAccounts(home);
        return { claude: [
          { id: "current", label: "Current login", state: claude.isCurrentClaudeLoginPaused(home) ? "paused" : "ready", failures: 0, inUse: !claude.isCurrentClaudeLoginPaused(home) && !accounts.some(account => account.preferred) },
          ...accounts.map(account => ({ id: account.id, label: account.label, state: account.paused ? "paused" : "ready", failures: 0, inUse: account.preferred && !account.paused })),
        ] };
      },
      claudeUsage: async () => ({ current: quota, [stored.id]: quota }),
      chatgpt: () => ({ quota: { chatgpt: quota }, auth: { chatgpt: "own" }, accounts: () => ({ chatgpt: gptRows() }), clearCooldown: () => { cooling = false; } }),
      modelScoresFetch: async () => new Response("{}"), runCli,
      openBrowser: () => true,
      claudeOAuthFetch: async () => Response.json({ access_token: "fake-new-access", refresh_token: "fake-new-refresh", expires_in: 3600, account: { uuid: "contract-new", email_address: "new@example.test" } }),
      power: { status: power, poke: async () => {}, pin: () => {} },
      picker: () => ({ enabled: fs.existsSync(path.join(home, "picker.state")) && fs.readFileSync(path.join(home, "picker.state"), "utf8") === "on", hosts: [], last: null }),
      startCliDetached: () => ({ pid: 99999999, completion: Promise.resolve({ ok: true, output: "Contract update" }) }),
    });
    const coveredRoutes = new Set<string>();
    const routePattern = (route: string): string => route.split("?")[0]!.replace(/^(\/api\/(?:claude|chatgpt)-accounts)\/.+$/, "$1/:id");
    const request = async (route: string, method = "GET", body?: unknown): Promise<unknown> => {
      coveredRoutes.add(routePattern(route));
      const response = await fetch(`http://127.0.0.1:${admin!.port}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      assert.ok(response.ok, `${method} ${route}: HTTP ${response.status} ${await response.clone().text()}`);
      return response.json();
    };
    const get = async (route: string) => object(await request(route));
    const rows = async (kind: string) => list((await get(`/api/${kind}-accounts`)).accounts);
    const row = async (kind: string, id: string) => { const found = (await rows(kind)).find(account => account.id === id); assert.ok(found); return found; };
    fs.mkdirSync(fixtures, { recursive: true });
    const record = async (name: string, route: string) => {
      const body = await request(route);
      fs.writeFileSync(path.join(fixtures, `${name}.json`), JSON.stringify(stable(body, home), null, 2) + "\n");
      return body;
    };
    await t.test("records all JSON GET routes and both summary variants", async () => {
      for (const [name, route] of [
        ["status", "/api/status"], ["limits", "/api/limits"], ["claude-accounts", "/api/claude-accounts"], ["chatgpt-accounts", "/api/chatgpt-accounts?provider=chatgpt"],
        ["config", "/api/config"], ["claude-oauth", "/api/claude-oauth"], ["chatgpt-login", "/api/chatgpt-login"],
        ["power", "/api/power"], ["power-setup", "/api/power/setup"], ["update", "/api/update"], ["codex", "/api/codex"],
        ["mod-settings", "/api/mod-settings"], ["mod-options", "/api/mod-options"], ["claude-models", "/api/claude-models"],
        ["effort-levels", "/api/effort-levels"], ["context-windows", "/api/context-windows"], ["requests", "/api/requests?n=200&kind=messages,image"],
        ["summary-range", `/api/requests/summary?from=${instant - 3600000}&to=${instant + 1000}`], ["summary-ring", "/api/requests/summary?since=3600"],
      ]) await record(name!, route!);
      const logs = await fetch(`http://127.0.0.1:${admin!.port}/api/logs?n=200`);
      assert.equal(await logs.text(), "Contract router ready\n");
      coveredRoutes.add("/api/logs");
    });
    await t.test("Claude preferred, rename, pause/resume (including current), delete", async () => {
      await request("/api/claude-accounts", "PUT", { preferred: stored.id });
      assert.equal((await row("claude", stored.id)).preferred, true);
      await request("/api/claude-accounts", "PUT", { preferred: null });
      assert.equal((await row("claude", stored.id)).preferred, false);
      await request(`/api/claude-accounts/${stored.id}`, "PATCH", { label: "Renamed Claude" });
      assert.equal((await row("claude", stored.id)).label, "Renamed Claude");
      for (const id of [stored.id, "current"]) for (const paused of [true, false]) {
        await request(`/api/claude-accounts/${id}`, "PATCH", { paused });
        assert.equal(id === "current" ? object((await get("/api/claude-accounts")).current).paused : (await row("claude", id)).paused, paused);
      }
      await request(`/api/claude-accounts/${stored.id}`, "DELETE");
      assert.equal((await rows("claude")).length, 0);
    });
    await t.test("ChatGPT exact patch members and delete", async () => {
      await request(`/api/chatgpt-accounts/${gpt.id}`, "PATCH", { label: "Renamed GPT", paused: true, clearCooldown: true });
      const changed = await row("chatgpt", gpt.id);
      assert.equal(changed.label, "Renamed GPT"); assert.equal(changed.paused, true); assert.equal(changed.cooldownSeconds, undefined);
      await request(`/api/chatgpt-accounts/${gpt.id}`, "PATCH", { paused: false });
      assert.equal((await row("chatgpt", gpt.id)).paused, false);
      await request(`/api/chatgpt-accounts/${gpt.id}`, "DELETE");
      assert.equal((await rows("chatgpt")).length, 0);
    });
    await t.test("config whole-document PUT and power bodies", async () => {
      const fresh = await get("/api/config");
      fresh.autoUpdate = true;
      await request("/api/config", "PUT", fresh);
      assert.equal((await get("/api/config")).autoUpdate, true);
      await request("/api/power", "PUT", { awake: { mode: "on", until: null } });
      assert.equal(object((await get("/api/power")).awake).mode, "on");
      await request("/api/power", "PUT", { tether: { enabled: false } });
      assert.equal(object((await get("/api/power")).tether).enabled, false);
    });
    await t.test("schema 2 settings body preserves review across GET PUT GET", async () => {
      const before = await get("/api/mod-settings");
      // Swift ContractTests asserts byte-semantic equality with ModSettingsEditor.putBody(), so
      // this is the same writer body, not a second independently maintained settings projection.
      const body = { schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, settings: before.settings, revision: before.revision };
      fs.writeFileSync(path.join(fixtures, "mod-settings-put.json"), JSON.stringify(stable(body, home), null, 2) + "\n");
      await request("/api/mod-settings", "PUT", body);
      const after = await get("/api/mod-settings");
      assert.deepEqual(object(after.settings).domainRules, object(before.settings).domainRules);
      assert.ok(object(object(after.settings).domainRules).review);
      assert.equal(after.revision, Number(before.revision) + 1);
    });
    await t.test("OAuth start/code/cancel, login, logout and CLI control bodies", async () => {
      const started = object(await request("/api/claude-oauth", "POST", { manual: true }));
      assert.equal(started.running, true); assert.equal((await get("/api/claude-oauth")).manual, true);
      await request("/api/claude-oauth/code", "POST", { code: "fake-code" });
      assert.equal((await get("/api/claude-oauth")).ok, true);
      assert.equal((await rows("claude")).length, 1);
      await request("/api/claude-oauth", "POST", { manual: true });
      await request("/api/claude-oauth/cancel", "POST");
      assert.equal((await get("/api/claude-oauth")).running, false);
      await request("/api/chatgpt-login", "POST");
      assert.equal((await get("/api/chatgpt-login")).ok, true);
      await request("/api/power/setup", "POST", { ssid: "Contract hotspot" });
      assert.equal((await get("/api/power/setup")).ok, true);
      await request("/api/claude-logout", "POST");
      assert.equal((await rows("claude")).length, 0);
      fs.writeFileSync(path.join(home, "picker.state"), "on");
      await request("/api/picker", "POST", { enabled: false });
      assert.equal(object((await get("/api/status")).picker).enabled, false);
      for (const enabled of [true, false]) {
        await request("/api/status-mod", "POST", { enabled });
        assert.equal((await get("/api/status")).statusMod, enabled);
        await request("/api/codex", "POST", { enabled });
        assert.equal((await get("/api/codex")).enabled, enabled);
      }
      const update = object(await request("/api/update", "POST"));
      assert.equal(update.started, true);
      assert.equal((await get("/api/update")).running, true);
    });
    await t.test("every route named by the Swift API extensions is covered", () => {
      const networking = path.join(root, "apps/macos/RippleKit/Sources/RippleKit/Networking");
      const expected = new Set<string>();
      for (const file of fs.readdirSync(networking).filter(name => /^API.*\.swift$/.test(name))) {
        const source = fs.readFileSync(path.join(networking, file), "utf8");
        for (const match of source.matchAll(/"(\/api\/[^"\s]+)"/g)) expected.add(routePattern(match[1]!));
      }
      assert.equal(expected.size, 26);
      assert.deepEqual([...coveredRoutes].sort(), [...expected].sort());
    });
    const meta = { routerVersion, modSettingsSchemaVersion: MOD_SETTINGS_SCHEMA_VERSION };
    const metadata = JSON.stringify(meta, null, 2) + "\n";
    fs.writeFileSync(path.join(fixtures, "meta.json"), metadata);
    fs.mkdirSync(path.dirname(resource), { recursive: true });
    fs.writeFileSync(resource, metadata);
  } finally {
    admin?.close();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    t.mock.restoreAll();
    t.mock.timers.reset();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
