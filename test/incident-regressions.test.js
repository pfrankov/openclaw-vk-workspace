import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TeamsApi } from '../src/api.js';
import { resolveAccount } from '../src/config.js';
import { handleInbound } from '../src/inbound.js';
import { inboundMedia, normalizeVoiceMedia, downloadTrusted } from '../src/media.js';
import { Inbox } from '../src/inbox.js';
import { runInboxCli } from '../src/inbox-cli.js';
import { drainInbox } from '../src/monitor.js';
import { ProcessingFailure, safeFailure, validFailure } from '../src/processing-failure.js';
import { config, event, httpServer, installRuntime, tempDir } from './helpers.js';

const USER = 'user@example.com', SELF = { userId: 'bot@example.com' };
const VOICE = [{ type: 'voice', payload: { fileId: 'voice-id' } }];
const AAC = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc, 0]);
for (const [name, buffer, mime, suffix] of [
  ['AAC', AAC, 'audio/aac', '.aac'],
  ['OGG', Buffer.from('OggS\0\0\0\0'), 'audio/ogg', '.ogg'],
  ['WAV', Buffer.from('RIFF\0\0\0\0WAVE'), 'audio/wav', '.wav'],
  ['MP3 ID3', Buffer.from('ID3\x04\0\0\0\0\0\0'), 'audio/mpeg', '.mp3'],
  ['MP3 frame', Buffer.from([0xff, 0xfb, 0x90, 0x64]), 'audio/mpeg', '.mp3'],
  ['M4A', Buffer.from('\0\0\0\x18ftypM4A '), 'audio/mp4', '.m4a'],
  ['WebM', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]), 'audio/webm', '.webm'],
]) {
  test(`${name}: bytes override conflicting CDN MIME, metadata and filename`, () => {
    for (const contentType of ['application/octet-stream', mime === 'audio/mpeg' ? 'audio/ogg' : 'audio/mpeg']) {
      const result = normalizeVoiceMedia({ buffer, fileName: 'opaque.wrong', contentType, declaredType: 'audio/x-wav' });
      assert.equal(result.contentType, mime); assert(result.fileName.endsWith(suffix));
    }
  });
}
test('voice metadata fallback handles WebM names, aliases, and keeps a bounded suffix', () => {
  assert.equal(normalizeVoiceMedia({ buffer: Buffer.alloc(0), fileName: 'voice.WEBM', contentType: 'application/octet-stream' }).contentType, 'audio/webm');
  assert.equal(normalizeVoiceMedia({ buffer: Buffer.alloc(0), fileName: 'opaque', declaredType: ' Audio/X-M4A ; charset=binary' }).contentType, 'audio/mp4');
  for (const fileName of ['x'.repeat(200), 'x'.repeat(174) + '😀😀😀']) {
    const result = normalizeVoiceMedia({ buffer: AAC, fileName, contentType: 'application/octet-stream' });
    assert(result.fileName.length <= 180); assert(result.fileName.endsWith('.aac'));
    assert(!/[\uD800-\uDBFF]\./.test(result.fileName));
  }
});

test('separate Bot API and CDN origins carry generic AAC into host media without bot credentials or signed URLs', async (t) => {
  const cdn = await httpServer(t, (_req, res) => { res.setHeader('Content-Type', 'application/octet-stream'); res.end(AAC); });
  const apiServer = await httpServer(t, (_req, res) => res.end(JSON.stringify({ ok: true,
    url: `${cdn.origin}/opaque?signature=CDN-SIGNATURE-PRIVATE`, filename: 'voice.aac', size: AAC.length })));
  const cfg = config({ baseUrl: apiServer.origin, allowInsecureHttp: true, mediaAllowedOrigins: [cdn.origin] });
  const account = resolveAccount(cfg), { core, seen } = installRuntime({ cfg });
  const media = await inboundMedia(VOICE, { api: new TeamsApi(account), account, core });
  assert.equal(media[0].contentType, 'audio/aac'); assert.equal(media[0].kind, 'audio');
  assert.deepEqual(seen.saved[0].buffer, AAC); assert.equal(seen.saved[0].fileName, 'voice.aac');
  assert.equal(apiServer.requests[0].url.searchParams.get('fileId'), 'voice-id');
  assert.equal(cdn.requests.length, 1); assert.equal(cdn.requests[0].url.searchParams.get('token'), null);
  assert.equal(cdn.requests[0].headers.authorization, undefined);
  assert(!JSON.stringify(media).includes('CDN-SIGNATURE-PRIVATE')); assert(!JSON.stringify(media).includes(cdn.origin));
  const blocked = resolveAccount(config({ baseUrl: apiServer.origin, allowInsecureHttp: true }));
  await assert.rejects(inboundMedia(VOICE, { api: new TeamsApi(blocked), account: blocked, core }),
    (error) => error.code === 'untrusted-origin' && error.message.includes(cdn.origin) && !error.message.includes('CDN-SIGNATURE-PRIVATE'));
  assert.equal(cdn.requests.length, 1); assert.equal(seen.saved.length, 1);
});

test('media diagnostics distinguish malformed URLs and redirects from network failures without exposing raw input', async () => {
  const account = resolveAccount(config());
  await assert.rejects(downloadTrusted('not a URL?token=SECRET', account),
    (error) => error.code === 'invalid-url' && !error.message.includes('SECRET'));
  await assert.rejects(downloadTrusted(`${account.baseUrl}/file`, account, undefined,
    async () => new Response(null, { status: 302, headers: { location: 'https://[invalid?token=SECRET' } })),
    (error) => error.code === 'invalid-redirect' && !error.message.includes('SECRET'));
});

test('abort after metadata prevents downloading or storing the attachment', async () => {
  const account = resolveAccount(config()), { core, seen } = installRuntime(), controller = new AbortController();
  await assert.rejects(inboundMedia(VOICE, { account, core, signal: controller.signal, api: {
    getFileInfo: async () => { controller.abort(); return { url: 'https://blocked.example/secret' }; },
  } }), { name: 'AbortError' });
  assert.equal(seen.saved.length, 0);
});

async function voiceFixture(t, settings = {}) {
  const cdn = await httpServer(t, (_req, res) => { res.setHeader('Content-Type', 'application/octet-stream'); res.end(AAC); });
  const cfg = config({ dmPolicy: 'allowlist', allowFrom: [USER], allowInsecureHttp: true,
    mediaAllowedOrigins: [cdn.origin], ...settings });
  const runtime = installRuntime({ cfg, mentionPatterns: [/openclaw/i] });
  const api = { getFileInfo: async () => ({ url: `${cdn.origin}/voice`, filename: 'voice.aac' }),
    sendTyping: async () => {}, sendText: async (chatId) => ({ chatId, messageId: 'reply' }) };
  const inbox = await new Inbox(join(await tempDir(t), 'inbox.json')).open(); t.after(() => inbox.close());
  const handle = (item) => handleInbound({ event: item, self: SELF, cfg, account: resolveAccount(cfg), api });
  return { ...runtime, api, cfg, inbox, handle };
}
test('host tolerating a transcription failure does not quarantine audio or the next text event', async (t) => {
  const f = await voiceFixture(t);
  const dispatch = f.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher;
  f.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher = async (params) => {
    // Host media failures are best-effort; a resolved dispatcher is not a failed reply.
    params.ctx.MediaUnderstandingDecisions = [{ capability: 'audio', outcome: 'failed' }];
    await dispatch(params);
  };
  await f.inbox.ingest([event(86, { text: '', parts: VOICE }), event(87)]);
  await drainInbox({ inbox: f.inbox, handle: f.handle });
  assert.equal(f.seen.dispatches, 2); assert.equal(f.inbox.state.failed.length, 0); assert.equal(f.inbox.state.pending.length, 0);
});
test('missing preflight transcript keeps mention gating closed but unblocks the following text mention', async (t) => {
  const chat = { chatId: 'group@chat.agent', type: 'group' };
  const f = await voiceFixture(t, { groupPolicy: 'allowlist', groupAllowFrom: [USER], groups: { [chat.chatId]: {} } });
  await f.inbox.ingest([event(86, { chat, text: '', parts: VOICE }), event(87, { chat, text: 'OpenClaw, ответь' })]);
  await drainInbox({ inbox: f.inbox, handle: f.handle });
  assert.equal(f.seen.preflights.length, 1); assert.equal(f.seen.dispatches, 1);
  assert.equal(f.seen.contexts[0].MessageSid, 'message-87'); assert.equal(f.seen.transcriptEchoes.length, 0);
  assert.equal(f.inbox.state.failed.length, 0); assert.equal(f.inbox.state.pending.length, 0);
});
for (const mode of ['callback', 'throw']) {
  test(`actual ${mode} dispatch failure retains an actionable stage, not an invented STT diagnosis`, async (t) => {
    const f = await voiceFixture(t);
    f.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher = async ({ dispatcherOptions }) => {
      const error = new Error('https://provider.example/path?token=PRIVATE signed audio URL');
      if (mode === 'throw') throw error;
      dispatcherOptions.onError(error);
    };
    await f.inbox.ingest([event(86, { text: '', parts: VOICE }), event(87)]);
    await drainInbox({ inbox: f.inbox, handle: f.handle });
    const failure = f.inbox.state.failed[0].failure;
    assert.equal(failure.stage, mode === 'callback' ? 'reply-delivery' : 'agent-dispatch');
    assert.equal(failure.code, 'reply-failed'); assert(!failure.message.includes('audio')); assert(!failure.message.includes('PRIVATE'));
    assert.equal(f.inbox.state.pending[0].event.eventId, '87');
    const path = f.inbox.path; await f.inbox.close();
    const restarted = await new Inbox(path).open(); t.after(() => restarted.close());
    assert.deepEqual(restarted.state.failed[0].failure, failure);
  });
}

test('safe failures are single-line, bounded and validate even with an invalid fallback stage', () => {
  const failure = safeFailure(new ProcessingFailure([], 'bad code', 'safe\n\r\t\u0085\u2028\u202e' + 'x'.repeat(500)), 'INVALID');
  assert.equal(failure.stage, 'dispatch'); assert.equal(failure.code, 'unexpected'); assert(validFailure(failure));
  assert(!/[\x00-\x1f\x7f-\x9f\u2028\u202e]/.test(failure.message));
  assert(!JSON.stringify(safeFailure(new Error('token=PRIVATE'))).includes('PRIVATE'));
});

async function recoveryFixture(t) {
  const path = join(await tempDir(t), 'inbox.json'), inbox = await new Inbox(path).open();
  await inbox.ingest([event(86, { text: 'PRIVATE MESSAGE' }), event(87), event(88, { chat: { chatId: 'other', type: 'private' } })]);
  await inbox.fail('86', { terminal: true }); await inbox.fail('88', { terminal: true }); await inbox.close();
  const lines = [], io = { out: (s) => lines.push(s), error: (s) => lines.push(s) };
  return { path, lines, io };
}
for (const command of ['retry', 'discard']) {
  test(`offline ${command} targets one event, creates a private snapshot, and preserves cursor and unrelated entries`, async (t) => {
    const f = await recoveryFixture(t), before = await readFile(f.path, 'utf8');
    assert.equal(await runInboxCli([command, f.path, '86'], f.io), 0);
    const { backup } = JSON.parse(f.lines[0]);
    assert.equal(await readFile(backup, 'utf8'), before); assert.equal((await stat(backup)).mode & 0o777, 0o600);
    const state = JSON.parse(await readFile(f.path, 'utf8'));
    assert.equal(state.cursor, '88'); assert.deepEqual(state.failed.map((x) => x.event.eventId), ['88']);
    assert.deepEqual(state.pending.map((x) => x.event.eventId), command === 'retry' ? ['86', '87'] : ['87']);
    assert(!f.lines.join('').includes('PRIVATE MESSAGE'));
  });
}
test('offline retry requires an event ID or explicit --all; invalid requests never mutate state', async (t) => {
  const f = await recoveryFixture(t), before = await readFile(f.path, 'utf8');
  for (const args of [['retry', f.path], ['status', f.path, '86'], ['discard', f.path, '--all'], ['retry', f.path, '999'], ['retry', f.path, 'NaN']]) {
    assert.equal(await runInboxCli(args, f.io), 1); assert.equal(await readFile(f.path, 'utf8'), before);
  }
  assert.deepEqual(await readdir(join(f.path, '..')), ['inbox.json']);
  assert.equal(await runInboxCli(['retry', f.path, '--all'], f.io), 0);
  const state = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(state.failed.length, 0); assert.deepEqual(state.pending.map((x) => x.event.eventId), ['86', '87', '88']);
});
test('offline recovery never steals an active lock or initializes a mistyped path', async (t) => {
  const f = await recoveryFixture(t), inbox = await new Inbox(f.path).open(); t.after(() => inbox.close());
  const before = await readFile(f.path, 'utf8');
  assert.equal(await runInboxCli(['discard', f.path, '86'], f.io), 1);
  assert.equal(await readFile(f.path, 'utf8'), before); await stat(`${f.path}.lock`);
  assert.equal(await runInboxCli(['status', `${f.path}.missing`], f.io), 1);
  await assert.rejects(stat(`${f.path}.missing`), { code: 'ENOENT' });
});
test('legacy multiline diagnostics remain readable rather than making an existing inbox corrupt', async (t) => {
  const f = await recoveryFixture(t), state = JSON.parse(await readFile(f.path, 'utf8'));
  state.failed[0].failure = { stage: 'dispatch', code: 'unexpected', message: 'legacy\nmessage' };
  await writeFile(f.path, JSON.stringify(state));
  const inbox = await new Inbox(f.path).open(); t.after(() => inbox.close());
  assert.equal(inbox.state.cursor, '88'); assert.equal(inbox.state.failed.length, 2);
});


test('offline status and invalid selection never quarantine interrupted turns before backup', async (t) => {
  const f = await recoveryFixture(t), state = JSON.parse(await readFile(f.path, 'utf8'));
  state.pending[0].started = true; await writeFile(f.path, JSON.stringify(state));
  const before = await readFile(f.path, 'utf8');
  assert.equal(await runInboxCli(['status', f.path], f.io), 0);
  assert.deepEqual(JSON.parse(f.lines[0]).interrupted, ['87']);
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal(await runInboxCli(['retry', f.path, '999'], f.io), 1);
  assert.equal(await readFile(f.path, 'utf8'), before);
});
for (const command of ['retry', 'discard']) {
  test(`offline ${command} snapshots an interrupted turn before quarantining or recovering it`, async (t) => {
    const f = await recoveryFixture(t), state = JSON.parse(await readFile(f.path, 'utf8'));
    state.pending[0].started = true; await writeFile(f.path, JSON.stringify(state));
    const before = await readFile(f.path, 'utf8');
    assert.equal(await runInboxCli([command, f.path, '87'], f.io), 0);
    assert.equal(await readFile(JSON.parse(f.lines[0]).backup, 'utf8'), before);
    const after = JSON.parse(await readFile(f.path, 'utf8'));
    assert.equal(after.cursor, '88'); assert.deepEqual(after.failed.map((x) => x.event.eventId), ['86', '88']);
    assert.deepEqual(after.pending.map((x) => x.event.eventId), command === 'retry' ? ['87'] : []);
    if (command === 'retry') assert.equal(after.pending[0].started, false);
  });
}
test('backup creation failure cannot mutate even an interrupted inbox', { skip: process.platform === 'win32' }, async (t) => {
  const f = await recoveryFixture(t), path = join(await tempDir(t), 'x'.repeat(220) + '.json');
  const state = JSON.parse(await readFile(f.path, 'utf8')); state.pending[0].started = true;
  const before = JSON.stringify(state); await writeFile(path, before);
  // The inbox and its lock fit NAME_MAX; the exclusive backup filename deliberately does not.
  assert.equal(await runInboxCli(['discard', path, '87'], f.io), 1);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('voice normalization survives a generic host media-store MIME and aborts after a late store', async (t) => {
  const cdn = await httpServer(t, (_req, res) => res.end(AAC));
  const account = resolveAccount(config({ allowInsecureHttp: true, mediaAllowedOrigins: [cdn.origin] }));
  const { core } = installRuntime(), controller = new AbortController();
  const api = { getFileInfo: async () => ({ url: cdn.origin + '/file', filename: 'voice.aac' }) };
  core.channel.media.saveMediaBuffer = async () => ({ path: '/test/voice.aac', contentType: 'application/octet-stream' });
  assert.equal((await inboundMedia(VOICE, { account, core, api }))[0].contentType, 'audio/aac');
  core.channel.media.saveMediaBuffer = async () => { controller.abort(); return { path: '/test/voice.aac' }; };
  await assert.rejects(inboundMedia(VOICE, { account, core, api, signal: controller.signal }), { name: 'AbortError' });
});
