import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { ExpoNotifier, expoBody, expoSender, type ExpoPayload } from '../src/expo-push.ts';
import { pushContent } from '../src/push-content.ts';
import type { EventBody } from '../src/protocol.ts';
import { posixModes } from '../../../test/capabilities.ts';
const token = 'ExpoPushToken[device_one]';
const secret = 'PRIVATE PROMPT OUTPUT PATH ERROR';
const permission: EventBody = { kind: 'permission', id: 'p', tool: secret, title: secret, summary: secret, input: secret, canAlways: true };
const done: EventBody = { kind: 'result', ok: true, ms: 1, turns: 1 };
const failed: EventBody = { ...done, ok: false, error: secret };

test('native payload contains only fixed lines and session id; persists per client and respects per-session views', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-push-'));
  try {
    const seen = new Map<string, number>();
    let now = 1_000_000;
    const sent: ExpoPayload[] = [];
    const options = { dir, send: async (p: ExpoPayload) => { sent.push(p); return 'sent' as const; }, seenRecently: (session: string) => now - (seen.get(session) ?? 0) < 180_000, log: () => {} };
    const notifier = new ExpoNotifier(options);
    assert.throws(() => notifier.subscribe('device', 'https://invalid', 'ko'));
    notifier.subscribe('device', token, 'ko');
    const restored = new ExpoNotifier(options);
    assert.deepEqual(restored.devices(), ['device']);
    seen.set('session', now);
    await restored.onEvent('session', permission);
    assert.equal(sent.length, 0);
    seen.delete('session');
    for (const event of [permission, done, failed, { kind: 'user', text: secret, clientMsgId: 'x' } as const]) await restored.onEvent('session', event);
    assert.deepEqual(sent.map(p => p.body), ['승인을 기다립니다', '작업을 마쳤습니다', '작업이 실패했습니다']);
    for (const p of sent) {
      assert.deepEqual(Object.keys(p).sort(), ['body', 'data', 'sound', 'title', 'to', 'ttl']);
      assert.deepEqual(p.data, { session: 'session' });
      assert.ok(!JSON.stringify(p).includes(secret));
    }
    assert.equal(expoBody(failed, 'en'), 'Work failed');
    restored.unsubscribe('device');
    assert.deepEqual(new ExpoNotifier(options).devices(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DeviceNotRegistered removes a token but never its concurrent replacement; errors retain tokens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-push-'));
  try {
    let resolve: ((result: 'gone') => void) | undefined;
    let errors = 0;
    const notifier = new ExpoNotifier({ dir, seenRecently: () => false, log: () => { errors++; }, send: () => new Promise(r => { resolve = r; }) });
    notifier.subscribe('device', token, 'ko');
    const pending = notifier.onEvent('session', failed);
    notifier.subscribe('device', 'ExpoPushToken[replacement]', 'en');
    resolve!('gone'); await pending;
    assert.deepEqual(notifier.devices(), ['device']);
    const gone = notifier.onEvent('session', done);
    resolve!('gone'); await gone;
    assert.deepEqual(notifier.devices(), []);
    const failing = new ExpoNotifier({ dir, seenRecently: () => false, log: () => { errors++; }, send: async () => { throw new Error('network'); } });
    failing.subscribe('device', token, 'ko'); await failing.onEvent('session', done);
    assert.deepEqual(failing.devices(), ['device']); assert.equal(errors, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function decrypt(e: string, key: string): unknown {
  const bytes = Buffer.from(e, 'base64url');
  const cipher = createDecipheriv('chacha20-poly1305', Buffer.from(key, 'base64url'), bytes.subarray(0, 12), { authTagLength: 16 });
  cipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8'));
}

test('keyed iOS/Android encrypt localized private content, authenticate it, persist 0600 and delete keys', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-keyed-'));
  try {
    const sent: ExpoPayload[] = [];
    const key = randomBytes(32).toString('base64url');
    const options = { dir, seenRecently: () => false, log: () => {},
      context: () => ({ title: 'Session name', cwd: '/private/folder', text: '**Shipped** the fix.\n\nAll tests pass.' }),
      send: async (p: ExpoPayload) => { sent.push(p); return 'sent' as const; } };
    const notifier = new ExpoNotifier(options);
    assert.throws(() => notifier.subscribe('bad', token, 'en', 'ios', 'short'));
    notifier.subscribe('ios', token, 'ko', 'ios', key);
    notifier.subscribe('android', token, 'en', 'android', key);
    const restored = new ExpoNotifier(options);
    await restored.onEvent('s', done);
    assert.equal(sent[0]!.title, 'Ripple Remote');
    assert.equal(sent[0]!.body, '작업을 마쳤습니다');
    assert.equal(sent[0]!.mutableContent, true);
    assert.equal(sent[1]!.title, undefined);
    assert.equal(sent[1]!.body, undefined);
    assert.equal(sent[1]!.data.fallback, 'Work finished');
    for (const p of sent) {
      assert.deepEqual(decrypt(p.data.e!, key), { v: 1, title: 'Session name', body: 'Shipped the fix. All tests pass.' });
      assert.ok(!JSON.stringify(p).includes('Session name'));
      assert.ok(Buffer.byteLength(JSON.stringify(p)) < 3500);
      const altered = Buffer.from(p.data.e!, 'base64url'); altered[15] = altered[15]! ^ 1;
      assert.throws(() => decrypt(altered.toString('base64url'), key));
      assert.throws(() => decrypt(p.data.e!, randomBytes(32).toString('base64url')));
    }
    assert.notEqual(sent[0]!.data.e, sent[1]!.data.e, 'random nonce per device');
    sent.length = 0;
    await restored.onEvent('s', permission);
    assert.equal((decrypt(sent[0]!.data.e!, key) as { body: string }).body, `승인 필요 · ${secret}: ${secret}`);
    assert.equal((decrypt(sent[1]!.data.e!, key) as { body: string }).body, `Needs approval · ${secret}: ${secret}`);
    sent.length = 0;
    await restored.onEvent('s', failed);
    assert.equal((decrypt(sent[0]!.data.e!, key) as { body: string }).body, `실패 · ${secret}`);
    assert.equal((decrypt(sent[1]!.data.e!, key) as { body: string }).body, `Failed · ${secret}`);
    const file = path.join(dir, 'expo-push.json');
    if (posixModes) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    restored.unsubscribe('ios'); restored.unsubscribe('android');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
    assert.ok(!fs.readFileSync(file, 'utf8').includes(key));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('private copy clips unicode, flattens markdown, uses folder and fixed-copy fallbacks', () => {
  const content = pushContent(done, 'en', { cwd: '/private/Folder', text: '# Done\n- [Link](https://private.invalid) **bold** `code`' }, 'Work finished');
  assert.deepEqual(content, { v: 1, title: 'Folder', body: 'Done Link bold code' });
  const clipped = pushContent(done, 'ko', { title: '😀'.repeat(80), text: '한😀'.repeat(200) }, '작업을 마쳤습니다');
  assert.equal(Array.from(clipped.title).length, 60);
  assert.equal(Array.from(clipped.body).length, 180);
  assert.ok(!clipped.title.includes('�'));
  assert.equal(pushContent(done, 'en', {}, 'Work finished').body, 'Work finished');
  assert.equal(pushContent({ kind: 'permission' }, 'ko', { tool: 'Bash', summary: 'npm test' }, '승인을 기다립니다').body, '승인 필요 · Bash: npm test');
  assert.equal(pushContent({ kind: 'result', ok: false }, 'en', { error: 'timeout' }, 'Work failed').body, 'Failed · timeout');
});

test('resubscribe replaces key; context errors send generic notification, not silence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-fallback-'));
  try {
    const sent: ExpoPayload[] = [];
    let broken = false;
    const notifier = new ExpoNotifier({ dir, seenRecently: () => false, log: () => {},
      context: () => { if (broken) throw new Error(secret); return { title: 'Private' }; },
      send: async p => { sent.push(p); return 'sent'; } });
    const old = randomBytes(32).toString('base64url'), key = randomBytes(32).toString('base64url');
    notifier.subscribe('d', token, 'en', 'ios', old);
    notifier.subscribe('d', token, 'en', 'ios', key);
    await notifier.onEvent('s', done);
    assert.throws(() => decrypt(sent[0]!.data.e!, old));
    assert.equal((decrypt(sent[0]!.data.e!, key) as { title: string }).title, 'Private');
    broken = true;
    await notifier.onEvent('s', done);
    assert.equal(sent[1]!.body, 'Work finished'); assert.equal(sent[1]!.data.e, undefined);
    notifier.subscribe('d', token, 'en');
    assert.ok(!fs.readFileSync(path.join(dir, 'expo-push.json'), 'utf8').includes(key));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Expo HTTP boundary handles ticket and receipt invalidation and transient errors', async () => {
  const payload: ExpoPayload = { to: token, title: 'Ripple Remote', body: '작업을 마쳤습니다', data: { session: 's' }, ttl: 86400, sound: 'default' };
  const calls: string[] = [];
  let replies = [{ data: { status: 'ok', id: 'ticket' } }, { data: { ticket: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }];
  const fetcher: typeof fetch = async (url, init) => { calls.push(String(url)); assert.equal(init?.method, 'POST'); return Response.json(replies.shift()); };
  assert.equal(await expoSender(fetcher, async () => {})(payload), 'gone');
  assert.deepEqual(calls, ['https://exp.host/--/api/v2/push/send', 'https://exp.host/--/api/v2/push/getReceipts']);
  const goneFetch: typeof fetch = async () => Response.json({ data: { status: 'error', details: { error: 'DeviceNotRegistered' } } });
  assert.equal(await expoSender(goneFetch)(payload), 'gone');
  const badFetch: typeof fetch = async () => new Response('', { status: 503 });
  await assert.rejects(expoSender(badFetch)(payload), /HTTP 503/);
});
