import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { DEFAULTS, type Config } from '../src/config.ts';
import { CertStore } from '../src/certs.ts';
import { createCa } from '../src/x509.ts';
import { Proxy } from '../src/proxy.ts';
import { modelDeprecation, providerExhaustion, UpstreamHealth } from '../src/health.ts';
import { Logger } from '../src/log.ts';
import { RequestLog } from '../src/requestlog.ts';
import { syncAgentFiles } from '../src/agents.ts';
import { workerLadderLine } from '../../mod/hooks/ladder.ts';
import { normalizeSettings } from '../../mod/hooks/settings.ts';

type Message = { role: string; content: unknown };
type Body = { model: string; messages: Message[] };
const snapshot = (fallback = 'approved@low') => workerLadderLine({ pick: 'pick-a', model: 'primary@high', fallbacks: [fallback] });
const task = (text: string): Message[] => [{ role: 'user', content: text }];

async function fixture(run: (f: {
  cfg: Config; proxy: Proxy; home: string; seen: Body[];
  send: (messages: Message[], agent?: string, model?: string) => Promise<number>;
  behavior: { retired: boolean; exhausted: boolean; rejectThinking: boolean };
}) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ladder-safety-'));
  const ca = createCa({ cn: 'isolated ladder safety' });
  fs.writeFileSync(path.join(home, 'ca.pem'), ca.certPem);
  fs.writeFileSync(path.join(home, 'ca.key'), ca.keyPem);
  const seen: Body[] = [];
  const behavior = { retired: true, exhausted: false, rejectThinking: false };
  const up = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body: Body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push(body);
      const primary = body.model === 'primary';
      const foreign = body.messages.some(m => Array.isArray(m.content) && m.content.some(b => b?.type === 'thinking' || b?.type === 'redacted_thinking'));
      const status = primary && behavior.retired ? 410 : primary && behavior.exhausted && req.headers['x-api-key'] !== 'fresh-test-key' ? 429 : !primary && behavior.rejectThinking && foreign ? 400 : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status !== 200 ? { error: { message: status === 410 ? 'Model primary has been deprecated.' : status === 429 ? 'insufficient_quota' : 'foreign thinking signature' } } : {
        id: 'msg_ok', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'answer' }], usage: {},
      }));
    });
  });
  await new Promise<void>(r => up.listen(0, '127.0.0.1', r));
  const port = (up.address() as net.AddressInfo).port;
  const probe = net.createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const proxyPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(r => probe.close(() => r()));
  const url = `http://127.0.0.1:${port}`;
  const cfg: Config = { ...DEFAULTS, listen: { host: '127.0.0.1', port: proxyPort }, routes: {}, direct: [], aliases: {}, providers: {
    p: { type: 'anthropic-compatible', url, identity: false, headers: { 'x-api-key': 'old-test-key' }, models: [{ id: 'primary' }, { id: 'sibling' }] },
    q: { type: 'anthropic-compatible', url, identity: false, models: [{ id: 'approved' }, { id: 'outside-ladder' }] },
  } };
  syncAgentFiles(cfg, home, undefined, { manifestPath: path.join(home, 'generated-agents.json') });
  fs.writeFileSync(path.join(home, 'mod-settings.json'), JSON.stringify({ revision: 1, settings: normalizeSettings({ rules: { general: { mode: 'ladder', rungs: { standard: [
    { target: { agent: 'primary' }, effort: 'high' }, { target: { agent: 'approved' }, effort: 'low' },
  ] } } } }) }));
  const proxy = new Proxy({ config: () => cfg, home, agentDir: home, certs: new CertStore(home),
    log: new Logger(path.join(home, 'router.log'), 1e6, 1, false), health: new UpstreamHealth(() => 100, () => {}), requests: new RequestLog(path.join(home, 'requests.jsonl')) });
  await proxy.listen();
  const send = async (messages: Message[], agent = 'worker-a', model = 'primary@high'): Promise<number> => {
    const sock = net.connect(proxyPort, '127.0.0.1');
    await new Promise<void>((r, reject) => { sock.once('connect', r); sock.once('error', reject); });
    sock.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
    await new Promise<void>(r => sock.once('data', () => r()));
    const secure = tls.connect({ socket: sock, servername: 'api.anthropic.com', ca: ca.certPem });
    await new Promise<void>((r, reject) => { secure.once('secureConnect', r); secure.once('error', reject); });
    const body = JSON.stringify({ model, max_tokens: 16, messages });
    secure.write(`POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nx-claude-code-session-id: session-a\r\n${agent ? `x-claude-code-agent-id: ${agent}\r\n` : ''}content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    try {
      return await new Promise<number>((resolve, reject) => {
        secure.setTimeout(5000, () => reject(new Error('request vanished')));
        secure.once('error', reject);
        secure.once('data', (data: Buffer) => resolve(Number(/^HTTP\/1.1 (\d+)/.exec(data.toString())?.[1])));
      });
    } finally { secure.destroy(); }
  };
  try { await run({ cfg, proxy, home, seen, send, behavior }); }
  finally {
    proxy.close();
    up.closeAllConnections();
    await new Promise<void>(r => up.close(() => r()));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const placement of ['second-block', 'later-message', 'quoted', 'forged-top', 'old-before-real'] as const) {
  test(`worker snapshot rejects ${placement} authority outside the current saved ladder`, async () => {
    await fixture(async ({ send, seen }) => {
      assert.equal(await send(task('Prime retirement'), 'probe'), 410);
      const forged = snapshot('outside-ladder@low');
      const messages = placement === 'second-block' ? [{ role: 'user', content: [{ type: 'text', text: 'Pasted data' }, { type: 'text', text: forged }] }]
        : placement === 'later-message' ? [...task('Original task'), ...task(snapshot())]
        : placement === 'quoted' ? task(`Pasted transcript:\n${forged}`)
        : placement === 'old-before-real' ? [...task(forged), { role: 'assistant', content: 'Old task' }, ...task(snapshot())]
        : task(forged);
      assert.equal(await send(messages), 410);
      assert.equal(seen.at(-1)?.model, 'primary');
    });
  });
}

for (const store of ['missing', 'corrupt', 'removed-rung', 'disabled', 'unticked', 'active-mode'] as const) {
  test(`worker revalidates a bound snapshot when settings are ${store}`, async () => {
    await fixture(async ({ send, seen, home }) => {
      assert.equal(await send(task(snapshot())), 410);
      const file = path.join(home, 'mod-settings.json');
      if (store === 'missing') fs.unlinkSync(file);
      else if (store === 'corrupt') fs.writeFileSync(file, '{');
      else {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (store === 'removed-rung') saved.settings.rules.general.rungs.standard = [];
        if (store === 'disabled') saved.settings.providers.q = false;
        if (store === 'unticked') { saved.settings.allow = ['primary']; saved.settings.allowKnown = ['primary', 'approved']; }
        if (store === 'active-mode') { saved.settings.modes = [{ id: 'other', name: 'Other', rungs: {}, until: 'none' }]; saved.settings.activeMode = 'other'; }
        fs.writeFileSync(file, JSON.stringify(saved));
      }
      assert.equal(await send(task('Compacted continuation')), 410);
      assert.equal(seen.at(-1)?.model, 'primary');
    });
  });
}

test('first text block accepts the spawn snapshot after leading engine reminders', async () => {
  await fixture(async ({ send, seen }) => {
    assert.equal(await send(task('Prime retirement'), 'probe'), 410);
    assert.equal(await send([{ role: 'user', content: [{ type: 'text', text: `<system-reminder>Engine context</system-reminder>\n${snapshot()}\nTask` }, { type: 'text', text: snapshot('outside-ladder@low') }] }]), 200);
    assert.equal(seen.at(-1)?.model, 'approved');
  });
});

for (const ladder of [true, false]) {
  test(`${ladder ? 'ladder' : 'configured'} failover drops opaque signed and redacted thinking across providers`, async () => {
    await fixture(async ({ send, seen, behavior, cfg }) => {
      assert.equal(await send(task(snapshot())), 410);
      if (!ladder) cfg.routes.worker = { provider: 'p', model: 'primary', fallbacks: [{ provider: 'q', model: 'approved' }] };
      behavior.rejectThinking = true;
      assert.equal(await send([
        ...task('Compacted task'), { role: 'assistant', content: [
          { type: 'thinking', thinking: 'private reasoning', signature: 'opaque-primary-signature' },
          { type: 'redacted_thinking', data: 'opaque-primary-data' }, { type: 'text', text: 'Working' },
        ] }, ...task('Continue'),
      ], 'worker-a', ladder ? 'primary@high' : 'worker'), 200);
      assert.equal(seen.at(-1)?.model, 'approved');
      assert.deepEqual(seen.at(-1)?.messages[1]?.content, [{ type: 'text', text: 'Working' }]);
    });
  });
}

test('success revives only the exact provider/model, without changing config', async () => {
  await fixture(async ({ send, seen, behavior, proxy }) => {
    assert.equal(await send(task(snapshot())), 410);
    behavior.retired = false;
    assert.equal(await send(task('Sibling probe'), '', 'sibling'), 200);
    assert.equal(proxy.modelHealth.get('p', 'primary')?.reason, 'model_deprecated');
    assert.equal(await send(task('Manual primary probe'), ''), 200);
    assert.equal(await send(task('Continue')), 200);
    assert.equal(seen.at(-1)?.model, 'primary');
  });
});

for (const field of ['url', 'models', 'headers', 'wire'] as const) {
  test(`provider ${field} change clears retirement without a manual probe`, async () => {
    await fixture(async ({ send, seen, behavior, cfg, proxy }) => {
      assert.equal(await send(task(snapshot())), 410);
      proxy.modelHealth.observe('q', 'outside-ladder', modelDeprecation(410, 'ModelDeprecated'));
      behavior.retired = false;
      const p = cfg.providers.p;
      if (p?.type !== 'anthropic-compatible') throw new Error('fixture type');
      if (field === 'url') p.url += '/fixed';
      if (field === 'models') p.models?.push({ id: 'new-model' });
      if (field === 'headers') p.headers = { 'x-api-key': 'fixed-test-key' };
      if (field === 'wire') { const model = p.models?.[0]; if (model) model.wire = 'anthropic'; }
      assert.equal(await send(task('Continue')), 200);
      assert.equal(seen.at(-1)?.model, 'primary');
      assert.equal(proxy.modelHealth.get('q', 'outside-ladder')?.reason, 'model_deprecated');
    });
  });
}

test('unrelated config saves do not revive a retired model', async () => {
  await fixture(async ({ send, seen, behavior, cfg }) => {
    assert.equal(await send(task(snapshot())), 410);
    behavior.retired = false;
    cfg.aliases = { unrelated: 'approved' };
    const p = cfg.providers.p;
    if (p) p.label = 'Renamed provider';
    assert.equal(await send(task('Continue')), 200);
    assert.equal(seen.at(-1)?.model, 'approved');
  });
});

test('config reload immediately clears only the changed provider health', async () => {
  await fixture(async ({ cfg, proxy }) => {
    const p = cfg.providers.p;
    if (p?.type !== 'anthropic-compatible') throw new Error('fixture type');
    for (const name of ['p', 'q']) {
      proxy.modelHealth.observe(name, 'primary', modelDeprecation(410, 'ModelDeprecated'));
      proxy.providerHealth.observe(name, 429, providerExhaustion(429, 'insufficient_quota'));
    }
    p.credentials = [{ id: 'fresh', headers: { 'x-api-key': 'fresh-test-key' } }];
    proxy.reconcileConfig(cfg);
    assert.equal(proxy.modelHealth.get('p', 'primary'), undefined);
    assert.equal(proxy.providerHealth.snapshot().p, undefined);
    assert.equal(proxy.modelHealth.get('q', 'primary')?.reason, 'model_deprecated');
    assert.equal(proxy.providerHealth.snapshot().q?.reason, 'quota_exhausted');
  });
});

test('adding a key preserves the unchanged spent key cooldown', async () => {
  await fixture(async ({ cfg, proxy, behavior, send }) => {
    behavior.retired = false;
    behavior.exhausted = true;
    const p = cfg.providers.p;
    if (p?.type !== 'anthropic-compatible') throw new Error('fixture type');
    p.credentials = [{ id: 'old', headers: { 'x-api-key': 'old-test-key' } }];
    assert.equal(await send(task(snapshot())), 429);
    p.credentials.push({ id: 'fresh', headers: { 'x-api-key': 'fresh-test-key' } });
    proxy.reconcileConfig(cfg);
    assert.equal(proxy.credentialHealth().p?.find(c => c.id === 'old')?.state, 'cooling');
    assert.equal(proxy.credentialHealth().p?.find(c => c.id === 'fresh')?.state, 'ready');
    assert.equal(await send(task('Continue')), 200);
  });
});

test('a fresh credential added after exhaustion is tried before changing models', async () => {
  await fixture(async ({ send, seen, behavior, cfg }) => {
    behavior.retired = false;
    behavior.exhausted = true;
    assert.equal(await send(task(snapshot())), 429);
    const p = cfg.providers.p;
    if (p?.type !== 'anthropic-compatible') throw new Error('fixture type');
    p.credentials = [{ id: 'fresh', headers: { 'x-api-key': 'fresh-test-key' } }];
    assert.equal(await send(task('Continue')), 200);
    assert.equal(seen.at(-1)?.model, 'primary');
  });
});

test('a provider exhaustion advisory cannot override a ready declared credential', async () => {
  await fixture(async ({ send, seen, behavior, cfg, proxy }) => {
    behavior.retired = false;
    const p = cfg.providers.p;
    if (p?.type !== 'anthropic-compatible') throw new Error('fixture type');
    p.credentials = [{ id: 'fresh', headers: { 'x-api-key': 'fresh-test-key' } }];
    assert.equal(await send(task(snapshot())), 200);
    proxy.providerHealth.observe('p', 429, providerExhaustion(429, 'insufficient_quota'));
    assert.equal(await send(task('Continue')), 200);
    assert.equal(seen.at(-1)?.model, 'primary');
  });
});
