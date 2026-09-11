import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { chunkText, sendPayload } from '../src/send.js';
import { parseMessage, checkAccess, handleInbound } from '../src/inbound.js';
import { trustedMediaUrl, downloadTrusted, readLocalMedia, loadOutboundMedia, inboundMedia, normalizeVoiceMedia, safeFileName } from '../src/media.js';
import { TeamsApi } from '../src/api.js';
import { resolveAccount } from '../src/config.js';
import { config, account, event, tempDir, httpServer, installRuntime } from './helpers.js';

const self = { userId: 'bot@example.com' };
const groupEvent = (payload = {}) => event(1, { chat: { chatId: '123@chat.agent', type: 'group' }, ...payload });

test('text chunking never loses characters or splits surrogate pairs', () => {
  for (const text of ['x'.repeat(10000), '😀'.repeat(5000), 'я'.repeat(4095) + '😀\nтекст', 'a\n'.repeat(5000), '']) {
    const chunks = chunkText(text);
    assert.equal(chunks.join(''), text);
    for (const chunk of chunks) { assert(chunk.length <= 4096); assert(!/^[\uDC00-\uDFFF]/.test(chunk)); assert(!/[\uD800-\uDBFF]$/.test(chunk)); }
  }
});
test('message parser ignores own, bot, edited and non-message events', () => {
  assert.equal(parseMessage({ ...event(), type: 'editedMessage' }, self), null);
  assert.equal(parseMessage({ ...event(), type: 'callbackQuery' }, self), null);
  assert.equal(parseMessage(event(1, { from: { userId: self.userId } }), self), null);
  assert.equal(parseMessage(event(1, { from: { userId: 'other', isBot: true } }), self), null);
  assert.equal(parseMessage(event(1, { text: '' }), self), null);
});
test('unknown chat type is treated as a group, never as an approved DM', () => {
  const message = parseMessage(event(1, { chat: { chatId: 'sensitive' } }), self);
  assert.equal(message.isGroup, true);
  assert.equal(checkAccess(message, account(), ['user@example.com']).allowed, false);
});
test('native mention and reply-to-bot detection, attachment-only and forwarded content', () => {
  assert.equal(parseMessage(groupEvent({ parts: [{ type: 'mention', payload: { userId: self.userId } }] }), self).wasMentioned, true);
  const reply = { msgId: 'previous', from: { userId: self.userId }, text: 'Earlier answer' };
  assert.equal(parseMessage(groupEvent({ parts: [{ type: 'reply', payload: { message: reply } }] }), self).reply.msgId, 'previous');
  assert.equal(parseMessage(event(1, { text: '', parts: [{ type: 'voice', payload: { fileId: 'f' } }] }), self).text, '[Attachment]');
  const forward = parseMessage(groupEvent({ parts: [{ type: 'forward', payload: { message: { text: `@[${self.userId}] original` } } }] }), self);
  assert.equal(forward.wasMentioned, false); assert.match(forward.text, /Forwarded message/);
});
test('message and reply ids preserve opaque int64 strings and reject unsafe JSON numbers', () => {
  assert.equal(parseMessage(event(1, { msgId: '9223372036854775807' }), self).messageId, '9223372036854775807');
  assert.equal(parseMessage(event(1, { msgId: 9007199254740992 }), self), null);
  const invalidReply = parseMessage(groupEvent({ parts: [{ type: 'reply', payload: { message: {
    msgId: 9007199254740992, from: { userId: self.userId }, text: 'unsafe' } } }] }), self);
  assert.equal(invalidReply.reply, undefined); assert.equal(invalidReply.wasMentioned, false);
});
test('group allowlist requires BOTH approved chat and approved sender; DM approvals do not count', () => {
  const message = parseMessage(groupEvent(), self);
  assert.equal(checkAccess(message, account({ groupAllowFrom: ['user@example.com'] })).allowed, false);
  assert.equal(checkAccess(message, account({ groups: { '123@chat.agent': {} } }), ['user@example.com']).allowed, false);
  assert.equal(checkAccess(message, account({ groups: { '123@chat.agent': {} }, groupAllowFrom: ['user@example.com'] })).allowed, true);
  assert.equal(checkAccess(message, account({ groups: { '*': { allowFrom: ['*'] }, '123@chat.agent': { enabled: false } } })).allowed, false);
});
test('pairing approvals are not consulted for explicit allowlist or disabled DMs', () => {
  const message = parseMessage(event(), self);
  for (const dmPolicy of ['allowlist', 'disabled']) assert.equal(checkAccess(message, account({ dmPolicy }), ['user@example.com']).allowed, false);
  assert.equal(checkAccess(message, account(), ['user@example.com']).allowed, true);
});
test('unauthorized DM issues account-scoped pairing without downloading, routing or dispatching', async () => {
  const { seen } = installRuntime(); const sent = [];
  await handleInbound({ event: event(1, { parts: [{ type: 'file', payload: { fileId: 'f' } }] }), self, account: account(), cfg: config(),
    api: { sendText: async (...args) => sent.push(args), getFileInfo: () => assert.fail('must not download') } });
  assert.equal(seen.challenges[0].accountId, 'default'); assert.equal(seen.challenges[0].channel, 'vk-workspace');
  assert.equal(seen.dispatches, 0); assert.equal(seen.routes.length, 0); assert.equal(sent.length, 1);
});
test('group policy and mention checks run before session writes and media downloads', async () => {
  const cfg = config({ groupAllowFrom: ['user@example.com'], groups: { '123@chat.agent': {} } });
  const { seen } = installRuntime({ cfg });
  await handleInbound({ event: groupEvent(), self, cfg, account: resolveAccount(cfg), api: {} });
  assert.equal(seen.routes.length, 0); assert.equal(seen.sessions.length, 0); assert.equal(seen.storeReads, 0);
});
test('voice-only group message can satisfy requireMention through OpenClaw audio preflight', async (t) => {
  let server;
  server = await httpServer(t, (req, res) => {
    if (req.url.pathname.endsWith('/files/getInfo')) return res.end(JSON.stringify({ ok: true,
      url: `${server.origin}/voice.ogg`, filename: 'voice.ogg', size: 5 }));
    if (req.url.pathname === '/voice.ogg') { res.setHeader('Content-Type', 'audio/ogg'); return res.end('voice'); }
    return res.end(JSON.stringify({ ok: true, ...(req.url.pathname.endsWith('/messages/sendText') ? { msgId: 'reply' } : {}) }));
  });
  const cfg = config({ baseUrl: server.origin, allowInsecureHttp: true, groupPolicy: 'allowlist',
    groupAllowFrom: ['user@example.com'], groups: { '123@chat.agent': { requireMention: true } } });
  cfg.tools = { media: { audio: { echoTranscript: true } } };
  const a = resolveAccount(cfg); const { seen } = installRuntime({ cfg, mentionPatterns: [/openclaw/i], audioTranscript: 'OpenClaw, ответь' });
  await handleInbound({ event: groupEvent({ text: '', parts: [{ type: 'voice', payload: { fileId: 'voice-id' } }] }),
    self, cfg, account: a, api: new TeamsApi(a) });
  assert.equal(seen.preflights.length, 1); assert.equal(seen.dispatches, 1);
  assert.match(seen.contexts[0].BodyForAgent, /Audio transcript.*OpenClaw, ответь/);
  assert.equal(seen.contexts[0].media[0].kind, 'audio'); assert.equal(seen.contexts[0].media[0].transcribed, true);
  assert.equal(seen.transcriptEchoes.length, 1);
});
test('voice preflight without a spoken mention does not start an agent turn or echo a transcript', async (t) => {
  let server;
  server = await httpServer(t, (req, res) => {
    if (req.url.pathname.endsWith('/files/getInfo')) return res.end(JSON.stringify({ ok: true,
      url: `${server.origin}/voice.ogg`, filename: 'voice.ogg', size: 5 }));
    if (req.url.pathname === '/voice.ogg') { res.setHeader('Content-Type', 'audio/ogg'); return res.end('voice'); }
    return res.end(JSON.stringify({ ok: true }));
  });
  const cfg = config({ baseUrl: server.origin, allowInsecureHttp: true, groupPolicy: 'allowlist',
    groupAllowFrom: ['user@example.com'], groups: { '123@chat.agent': { requireMention: true } } });
  cfg.tools = { media: { audio: { echoTranscript: true } } };
  const { seen } = installRuntime({ cfg, mentionPatterns: [/openclaw/i], audioTranscript: 'сообщение для коллег' });
  await handleInbound({ event: groupEvent({ text: '', parts: [{ type: 'voice', payload: { fileId: 'voice-id' } }] }),
    self, cfg, account: resolveAccount(cfg), api: new TeamsApi(resolveAccount(cfg)) });
  assert.equal(seen.preflights.length, 1); assert.equal(seen.dispatches, 0);
  assert.equal(seen.sessions.length, 0); assert.equal(seen.transcriptEchoes.length, 0);
});
test('voice preflight refuses mixed attachment messages before every download', async () => {
  const cfg = config({ groupPolicy: 'allowlist', groupAllowFrom: ['user@example.com'],
    groups: { '123@chat.agent': { requireMention: true } } });
  const { seen } = installRuntime({ cfg, mentionPatterns: [/openclaw/i], audioTranscript: 'OpenClaw' });
  for (const extra of ['file', 'sticker']) {
    await handleInbound({ event: groupEvent({ text: '', parts: [
      { type: 'voice', payload: { fileId: 'voice-id' } }, { type: extra, payload: { fileId: 'extra-id' } },
    ] }), self, cfg, account: resolveAccount(cfg), api: { getFileInfo: () => assert.fail('must not download') } });
  }
  assert.equal(seen.preflights.length, 0); assert.equal(seen.dispatches, 0); assert.equal(seen.routes.length, 0);
});
test('open chat access does not authorize unallowlisted control commands', async () => {
  const cfg = config({ dmPolicy: 'open' }); const { seen } = installRuntime({ cfg });
  await handleInbound({ event: event(1, { text: '/reset' }), self, cfg, account: resolveAccount(cfg), api: {} });
  assert.equal(seen.dispatches, 0); assert.equal(seen.sessions.length, 0);
});
test('approved inbound message reaches session, agent dispatcher and real Bot API reply', async (t) => {
  const server = await httpServer(t, (req, res) => res.end(JSON.stringify({ ok: true, ...(req.url.pathname.endsWith('sendText') ? { msgId: 'reply' } : {}) })));
  const cfg = config({ baseUrl: server.origin, allowInsecureHttp: true });
  const a = resolveAccount(cfg); const { seen } = installRuntime({ cfg, paired: ['user@example.com'],
    payloads: [{ text: 'Ответ', replyToId: 'dispatcher-reply' }] });
  await handleInbound({ event: event(), self, cfg, account: a, api: new TeamsApi(a) });
  assert.equal(seen.dispatches, 1); assert.equal(seen.routes[0].cfg.session.dmScope, 'per-account-channel-peer');
  assert.equal(seen.contexts[0].Provider, 'vk-workspace'); assert.equal(seen.contexts[0].MessageSid, 'message-1');
  assert.equal(seen.contexts[0].CommandAuthorized, true); assert.equal(seen.sessions.length, 1);
  const sent = server.requests.find((req) => req.url.pathname.endsWith('sendText'));
  assert.equal(sent.url.searchParams.get('chatId'), 'user@example.com'); assert.equal(sent.url.searchParams.get('text'), 'Ответ');
  assert.equal(sent.url.searchParams.get('replyMsgId'), null);
});
test('group replies quote the inbound message', async (t) => {
  const server = await httpServer(t, (req, res) => res.end(JSON.stringify({ ok: true, ...(req.url.pathname.endsWith('sendText') ? { msgId: 'reply' } : {}) })));
  const cfg = config({ baseUrl: server.origin, allowInsecureHttp: true, groupPolicy: 'allowlist',
    groupAllowFrom: ['user@example.com'], groups: { '123@chat.agent': { requireMention: false } } });
  const a = resolveAccount(cfg); installRuntime({ cfg });
  await handleInbound({ event: groupEvent(), self, cfg, account: a, api: new TeamsApi(a) });
  const sent = server.requests.find((req) => req.url.pathname.endsWith('sendText'));
  assert.equal(sent.url.searchParams.get('replyMsgId'), 'message-1');
});
test('dispatcher errors are surfaced so durable inbox does not mark delivery complete', async () => {
  const cfg = config({ allowFrom: ['user@example.com'] }); const { core } = installRuntime({ cfg });
  core.channel.reply.dispatchReplyWithBufferedBlockDispatcher = async ({ dispatcherOptions }) => dispatcherOptions.onError(new Error('private data'));
  await assert.rejects(handleInbound({ event: event(), self, cfg, account: resolveAccount(cfg), api: { sendTyping: async () => {} } }), /reply delivery failed/);
});
test('late delivery after dispatch completion or cancellation cannot send a message', async () => {
  const cfg = config({ allowFrom: ['user@example.com'] }); const { core } = installRuntime({ cfg }); let deliver;
  core.channel.reply.dispatchReplyWithBufferedBlockDispatcher = async ({ dispatcherOptions }) => { deliver = dispatcherOptions.deliver; };
  await handleInbound({ event: event(), self, cfg, account: resolveAccount(cfg), api: { sendTyping: async () => {}, sendText: () => assert.fail() } });
  await assert.rejects(deliver({ text: 'late' }), { name: 'AbortError' });
});
test('multiple outbound attachments retain caption and all remaining text; reply only once', async (t) => {
  const dir = await tempDir(t); await writeFile(join(dir, 'a.txt'), 'A'); await writeFile(join(dir, 'b.txt'), 'B');
  const { core } = installRuntime(); const sent = []; const text = 'я😀'.repeat(2000);
  const api = { sendFile: async (to, file, opts) => { sent.push({ ...opts, file: file.fileName }); return { chatId: to, messageId: 'f' }; },
    sendText: async (to, chunk, opts) => { sent.push({ ...opts, text: chunk }); return { chatId: to, messageId: 't' }; } };
  await sendPayload('vk-workspace:user:user@example.com', { text, mediaUrls: ['a.txt', 'b.txt', 'a.txt'] }, { core, account: account(), api, mediaLocalRoots: [dir], replyToId: 'r' });
  assert.equal(sent.filter((item) => item.file).length, 2);
  assert.equal(sent.map((item) => item.caption || item.text || '').join(''), text);
  assert.equal(sent.filter((item) => item.replyToId).length, 1);
});
test('local media rejects absent roots, traversal, escaping symlinks and oversize files', async (t) => {
  const dir = await tempDir(t); const root = join(dir, 'allowed'); await mkdir(root);
  await writeFile(join(root, 'ok.txt'), 'hello'); await writeFile(join(dir, 'secret.txt'), 'secret');
  await symlink(join(dir, 'secret.txt'), join(root, 'escape.txt'));
  assert.equal((await readLocalMedia('ok.txt', [root], 10)).buffer.toString(), 'hello');
  for (const input of ['../secret.txt', 'escape.txt', join(dir, 'secret.txt')]) await assert.rejects(readLocalMedia(input, [root], 100), /outside/);
  await assert.rejects(readLocalMedia(join(root, 'ok.txt'), [], 100), /approved media roots/);
  await assert.rejects(readLocalMedia('ok.txt', [root], 2), /size limit/);
});
test('media origins block credentials, other origins and unapproved redirect destinations', async (t) => {
  const a = account({ baseUrl: 'https://teams.example', mediaAllowedOrigins: ['https://files.example'] });
  assert.equal(trustedMediaUrl('https://files.example/f', a).hostname, 'files.example');
  for (const url of ['https://evil.example/f', 'http://files.example/f', 'https://u:p@files.example/f', 'file:///etc/passwd']) assert.throws(() => trustedMediaUrl(url, a));
  const server = await httpServer(t, (_, res) => { res.statusCode = 302; res.setHeader('Location', 'http://169.254.169.254/credentials'); res.end(); });
  await assert.rejects(downloadTrusted(`${server.origin}/f`, server.account), /download failed/);
  assert.equal(server.requests.length, 1);
});
test('public outbound media delegates the turn abort signal to the host SSRF fetcher', async () => {
  const controller = new AbortController(); let options;
  const core = { channel: { media: { fetchRemoteMedia: async (value) => { options = value; return {
    buffer: Buffer.from('ok'), fileName: 'file.txt', contentType: 'text/plain' }; } } } };
  await loadOutboundMedia('https://public.example/file.txt', { account: account(), core, signal: controller.signal });
  assert.equal(options.requestInit.signal, controller.signal);
});
test('inbound attachment uses files/getInfo, materializes bytes and never exposes signed URL in media facts', async (t) => {
  let origin;
  const server = await httpServer(t, (req, res) => {
    if (req.url.pathname.endsWith('getInfo')) res.end(JSON.stringify({ url: `${origin}/download?signature=secret`, filename: 'image.png', size: 3 }));
    else { assert.equal(req.url.searchParams.get('token'), null); res.setHeader('Content-Type', 'image/png'); res.end('png'); }
  }); origin = server.origin;
  const { core, seen } = installRuntime();
  const media = await inboundMedia([{ type: 'file', payload: { fileId: 'opaque-file' } }], { api: new TeamsApi(server.account), account: server.account, core });
  assert.equal(seen.saved[0].buffer.toString(), 'png'); assert.equal(media[0].kind, 'image');
  assert(!JSON.stringify(media).includes('signature')); assert.equal(media[0].path, '/test/media/image.png');
});
test('inbound voice derives provider-safe OGG metadata from bytes when the CDN is generic', async (t) => {
  let origin;
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24)]);
  const server = await httpServer(t, (req, res) => {
    if (req.url.pathname.endsWith('getInfo')) return res.end(JSON.stringify({ url: `${origin}/opaque`, size: ogg.length }));
    res.setHeader('Content-Type', 'application/octet-stream'); res.end(ogg);
  }); origin = server.origin;
  const { core, seen } = installRuntime();
  const media = await inboundMedia([{ type: 'voice', payload: { fileId: 'voice-id' } }],
    { api: new TeamsApi(server.account), account: server.account, core });
  assert.equal(seen.saved[0].contentType, 'audio/ogg'); assert.match(seen.saved[0].fileName, /\.ogg$/);
  assert.equal(media[0].kind, 'audio'); assert.equal(media[0].contentType, 'audio/ogg');
});
test('voice normalization recognizes common audio signatures and rejects unknown bytes', () => {
  assert.deepEqual(normalizeVoiceMedia({ buffer: Buffer.from('ID3audio'), fileName: 'opaque', contentType: 'application/octet-stream' }),
    { contentType: 'audio/mpeg', fileName: 'opaque.mp3' });
  assert.throws(() => normalizeVoiceMedia({ buffer: Buffer.from('unknown'), fileName: 'opaque', contentType: 'application/octet-stream' }),
    (error) => error.stage === 'media-normalize' && error.code === 'unsupported-audio');
});
test('untrusted inbound CDN reports a safe actionable origin without its signed URL', async () => {
  const { core } = installRuntime(); const a = account();
  await assert.rejects(inboundMedia([{ type: 'voice', payload: { fileId: 'voice-id' } }], { account: a, core, api: {
    getFileInfo: async () => ({ url: 'https://files-n.lesta.group/path?signature=DO-NOT-LOG' }),
  } }), (error) => error.stage === 'media-download' && error.code === 'untrusted-origin' &&
    error.message.includes('https://files-n.lesta.group') && !error.message.includes('DO-NOT-LOG'));
});
test('attachment count and metadata size limits are enforced before download', async () => {
  const { core } = installRuntime(); const a = account(); const file = { type: 'file', payload: { fileId: 'f' } };
  await assert.rejects(inboundMedia(Array(11).fill(file), { account: a, core, api: {} }), /At most 10/);
  await assert.rejects(inboundMedia([file], { account: a, core, api: { getFileInfo: async () => ({ url: 'https://teams.example/f', size: 1000000000 }) } }), /size limit/);
  assert.equal(safeFileName('../../private\\name.txt'), 'name.txt');
});
