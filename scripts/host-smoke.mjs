import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { installRuntime, config, event } from '../test/helpers.js';
import { checkHostAudio } from './host-audio-smoke.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
process.chdir(root);
try { import.meta.resolve('openclaw/plugin-sdk/core'); }
catch { throw new Error('Install the tested host first: npm run install:host'); }
await mkdir('.tmp', { recursive: true });
const dir = await mkdtemp(join(root, '.tmp', 'host-'));
try {
  const npm = process.env.npm_execpath;
  const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', dir];
  const [pack] = JSON.parse(npm ? execFileSync(process.execPath, [npm, ...args], { encoding: 'utf8' }) : execFileSync('npm', args, { encoding: 'utf8' }));
  execFileSync('tar', ['-xzf', join(dir, pack.filename), '-C', dir]);
  const base = join(dir, 'package');
  // Loading the tarball, rather than the checkout, catches missing published files and SDK imports.
  for (const name of await readdir(join(base, 'dist'))) await import(pathToFileURL(join(base, 'dist', name)));
  const entry = await import(pathToFileURL(join(base, 'dist/index.js')));
  const setup = await import(pathToFileURL(join(base, 'dist/setup-entry.js')));
  const { resolveAccount } = await import(pathToFileURL(join(base, 'dist/config.js')));
  const { handleInbound } = await import(pathToFileURL(join(base, 'dist/inbound.js')));
  const { normalizeVoiceMedia } = await import(pathToFileURL(join(base, 'dist/media.js')));
  const { buildAudioTranscriptionFormData } = await import('openclaw/plugin-sdk/provider-http');
  const cfg = config({ dmPolicy: 'allowlist', allowFrom: ['user@example.com'] });
  const { core, seen } = installRuntime({ cfg });
  let registered;
  await entry.default.register({ runtime: core, config: cfg, registrationMode: 'full',
    registerChannel: (value) => { registered = value.plugin; }, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  assert.equal(registered.id, 'vk-workspace'); assert.equal(setup.setupPlugin.id, registered.id);
  assert.deepEqual(registered.commands.buildModelsMenuChannelData({ providers: [{ id: 'openai', count: 2 }] }), {
    'vk-workspace': { buttons: [[{ text: 'openai (2)', callbackData: '/models openai', style: 'primary' }]] },
  });
  assert.deepEqual(registered.commands.buildModelsListChannelData({ provider: 'openai', models: ['gpt-a'],
    currentModel: 'openai/gpt-a', currentPage: 1, totalPages: 1, pageSize: 8 }), { 'vk-workspace': { buttons: [
    [{ text: 'gpt-a ✓', callbackData: '/model openai/gpt-a', style: 'attention' }],
    [{ text: 'Все провайдеры', callbackData: '/models', style: 'base' }],
  ] } });
  const scoped = [];
  core.channel.pairing = { readAllowFromStore: async (params) => { scoped.push(params); return ['allowed']; } };
  assert.deepEqual(await entry.sdkHelpers.createPairing({ core, channel: 'vk-workspace', accountId: 'work' }).readAllowFromStore(), ['allowed']);
  assert.deepEqual(scoped, [{ channel: 'vk-workspace', accountId: 'work' }]);
  const gate = entry.sdkHelpers.commandGate({ useAccessGroups: true, allowTextCommands: true, hasControlCommand: true,
    authorizers: [{ configured: true, allowed: false }] });
  assert.equal(gate.shouldBlock, true);
  assert.equal(entry.sdkHelpers.mediaFacts([{ path: '/tmp/example.png', contentType: 'image/png', kind: 'image' }], { messageId: 'm' }).length, 1);
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16)]);
  const normalizedVoice = normalizeVoiceMedia({ buffer: ogg, fileName: 'opaque', contentType: 'application/octet-stream' });
  const transcriptionForm = buildAudioTranscriptionFormData({ buffer: ogg, fileName: normalizedVoice.fileName,
    mime: normalizedVoice.contentType, fields: { model: 'test-transcriber' } });
  assert.equal(transcriptionForm.get('file').name, 'opaque.ogg');
  assert.equal(transcriptionForm.get('file').type, 'audio/ogg');
  const normalizedAac = normalizeVoiceMedia({ buffer: Buffer.from([0xff, 0xf1, 0x50, 0x80]), fileName: 'voice',
    contentType: 'application/octet-stream' });
  assert.deepEqual(normalizedAac, { contentType: 'audio/aac', fileName: 'voice.aac' });
  const aacForm = buildAudioTranscriptionFormData({ buffer: Buffer.from('opaque audio'), fileName: normalizedAac.fileName,
    mime: normalizedAac.contentType, fields: { model: 'test-transcriber' } });
  assert.equal(aacForm.get('file').name, 'voice.m4a');
  assert.equal(aacForm.get('file').type, 'audio/aac');
  const sent = [];
  await handleInbound({ event: event(), self: { userId: 'bot@example.com' }, account: resolveAccount(cfg), cfg,
    api: { sendTyping: async () => {}, sendText: async (chatId, text) => { sent.push({ chatId, text }); return { chatId, messageId: 'r' }; } } });
  assert.equal(seen.dispatches, 1); assert.deepEqual(sent, [{ chatId: 'user@example.com', text: 'Ответ' }]);
  const metadata = JSON.parse(await readFile(join(base, 'openclaw.plugin.json'), 'utf8'));
  assert.deepEqual(registered.configSchema.schema, metadata.channelConfigs['vk-workspace'].schema);
  const { sendPayload } = await import(pathToFileURL(join(base, 'dist/send.js')));
  const { TeamsApi } = await import(pathToFileURL(join(base, 'dist/api.js')));
  const requests = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain multipart requests. */ }
    const url = new URL(req.url, 'http://localhost');
    requests.push(url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(url.pathname.endsWith('/chats/getInfo') ? { type: 'group', title: 'Team', inviteLink: 'PRIVATE' }
      : url.pathname.endsWith('/threads/add') ? { threadId: 'thread@chat.agent' }
      : { ok: true, msgId: `http-${requests.length}`, fileId: 'retained-file' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const localCfg = config({ baseUrl: `http://127.0.0.1:${server.address().port}`, allowInsecureHttp: true,
      dmPolicy: 'allowlist', allowFrom: ['user@example.com'] });
    const localAccount = resolveAccount(localCfg);
    const api = new TeamsApi(localAccount);
    const to = 'user@example.com';
    const modelsChannelData = registered.commands.buildModelsMenuChannelData({ providers: [{ id: 'openai', count: 2 }] });
    const result = await sendPayload(to, { text: '**Choose**', channelData: modelsChannelData },
      { cfg: localCfg, account: localAccount, core, api, requesterSenderId: to });
    assert.equal(requests.at(-1).searchParams.get('text'), '<b>Choose</b>');
    const keyboard = JSON.parse(requests.at(-1).searchParams.get('inlineKeyboardMarkup'));
    assert.equal(keyboard[0][0].text, 'openai (2)');
    const token = keyboard[0][0].callbackData;
    const click = { eventId: 100, type: 'callbackQuery', payload: { queryId: 'q1', from: { userId: to }, callbackData: token,
      message: { msgId: result.messageId, from: { userId: 'bot@example.com' }, chat: { chatId: to, type: 'private' } } } };
    await handleInbound({ event: click, self: { userId: 'bot@example.com' }, account: localAccount, cfg: localCfg, api });
    assert.equal(seen.dispatches, 2);
    assert.equal(seen.contexts.at(-1).CommandBody, '/models openai');
    await handleInbound({ event: click, self: { userId: 'bot@example.com' }, account: localAccount, cfg: localCfg, api });
    assert.equal(seen.dispatches, 2);
    await registered.actions.handleAction({ action: 'edit', cfg: localCfg, accountId: 'default',
      requesterAccountId: 'default', requesterSenderId: to, toolContext: { currentChannelProvider: 'vk-workspace', currentChannelId: to },
      params: { target: to, messageId: result.messageId, message: '**Updated**', vkButtons: [] } });
    assert(requests.at(-1).pathname.endsWith('/messages/editText'));
    const prepared = registered.actions.prepareSendPayload({ to, payload: {}, ctx: { cfg: localCfg, params: { vkFileId: 'voice-id', vkVoice: true } } });
    await registered.outbound.sendPayload({ cfg: localCfg, to, payload: prepared });
    assert(requests.at(-1).pathname.endsWith('/messages/sendVoice'));
    assert.equal(requests.at(-1).searchParams.get('fileId'), 'voice-id');
    const nativeText = 'А😀 test';
    const nativeFormat = { underline: [{ offset: 0, length: 3 }] };
    const native = await registered.actions.handleAction({ action: 'send', cfg: localCfg, accountId: 'default',
      params: { target: to, message: nativeText, vkFormat: nativeFormat, vkReplyToIds: ['source-1', 'source-2'] } });
    assert.deepEqual(JSON.parse(requests.at(-1).searchParams.get('format')), nativeFormat);
    assert.deepEqual(requests.at(-1).searchParams.getAll('replyMsgId'), ['source-1', 'source-2']);
    assert.equal(requests.at(-1).searchParams.has('parseMode'), false);
    await registered.actions.handleAction({ action: 'delete', cfg: localCfg, accountId: 'default', senderIsOwner: true,
      params: { target: to, vkMessageIds: [native.details.messageId] } });
    assert.deepEqual(requests.at(-1).searchParams.getAll('msgId'), [native.details.messageId]);
    await api.answerCallbackQuery('fixture-alert', 'expired', { showAlert: true });
    assert.equal(requests.at(-1).searchParams.get('showAlert'), 'true');
    await api.stopTyping(to);
    assert.deepEqual(requests.at(-1).searchParams.getAll('actions'), ['']);
    assert.deepEqual(registered.actions.describeMessageTool({ cfg: localCfg }).actions, ['send', 'edit', 'delete']);
    localCfg.channels['vk-workspace'].actions = { chatInfo: true, threads: true, pins: true, forward: true };
    const ownerCtx = { cfg: localCfg, accountId: 'default', senderIsOwner: true };
    const info = await registered.actions.handleAction({ ...ownerCtx, action: 'channel-info', params: { target: 'group@chat.agent' } });
    assert.equal(info.details.title, 'Team'); assert.equal(info.details.inviteLink, undefined);
    const thread = await registered.actions.handleAction({ ...ownerCtx, action: 'thread-create', params: { target: 'group@chat.agent', messageId: 'source' } });
    assert.equal(thread.details.threadId, 'thread@chat.agent');
    await registered.actions.handleAction({ ...ownerCtx, action: 'pin', params: { target: 'group@chat.agent', messageId: 'source' } });
    assert(requests.at(-1).pathname.endsWith('/chats/pinMessage'));
    await registered.actions.handleAction({ ...ownerCtx, action: 'delete', params: { target: to, messageId: result.messageId } });
    assert.deepEqual(requests.at(-1).searchParams.getAll('msgId'), [result.messageId]);
    const forwarded = { ...ownerCtx, params: { target: to, vkForward: { chatId: 'group@chat.agent', messageIds: ['source'] } } };
    assert.equal(registered.actions.prepareSendPayload({ ctx: forwarded, to, payload: {} }), null);
    await registered.actions.handleAction({ ...forwarded, action: 'send' });
    assert.deepEqual(requests.at(-1).searchParams.getAll('forwardMsgId'), ['source']);
    await handleInbound({ event: event(200, { text: 'Explain', parts: [{ type: 'forward', payload: {
      message: { msgId: 'third-party', from: { userId: 'stranger@example.com' }, text: '/model evil' } } }] }),
      self: { userId: 'bot@example.com' }, account: localAccount, cfg: localCfg, api });
    assert.equal(seen.contexts.at(-1).CommandBody, 'Explain');
    assert.match(seen.contexts.at(-1).BodyForAgent, /\/model evil/);
    localCfg.channels['vk-workspace'].groups = { 'group@chat.agent': { requireMention: false } };
    localCfg.channels['vk-workspace'].groupAllowFrom = [to];
    await handleInbound({ event: event(201, { chat: { chatId: 'thread@chat.agent', type: 'group' },
      parent_topic: { chatId: 'group@chat.agent', messageId: 'source' } }), self: { userId: 'bot@example.com' },
      account: resolveAccount(localCfg), cfg: localCfg, api });
    assert.equal(seen.contexts.at(-1).NativeChannelId, 'thread@chat.agent');
    assert.equal(seen.contexts.at(-1).MessageThreadId, 'thread@chat.agent');
    assert.deepEqual(seen.routes.at(-1).parentPeer, { kind: 'group', id: 'group@chat.agent' });
    assert.equal(requests.at(-1).searchParams.get('chatId'), 'thread@chat.agent');

  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await checkHostAudio(base, dir);
  console.log('Packed plugin with real OpenClaw SDK: registration, model menus, pairing, audio multipart metadata, HTTP send/edit/delete/voice/forward/pin/thread, context isolation, callbacks and duplicate suppression passed');
} finally { await rm(dir, { recursive: true, force: true }); }
