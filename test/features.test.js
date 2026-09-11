import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { formatText, safeLink } from '../src/format.js';
import { normalizeButtons, prepareKeyboard, CALLBACK_TTL_MS } from '../src/keyboard.js';
import { MessageStore, getMessageStore, messageStorePath } from '../src/message-store.js';
import { channelData, sendPayload, editMessage } from '../src/send.js';
import { TeamsApi, ApiError } from '../src/api.js';
import { handleInbound, parseMessage } from '../src/inbound.js';
import { messageActions } from '../src/actions.js';
import { channelPlugin } from '../src/channel.js';
import { resolveAccount } from '../src/config.js';
import { Inbox } from '../src/inbox.js';
import { drainInbox, monitorAccount } from '../src/monitor.js';
import { atomicWrite } from '../src/state.js';
import { httpServer, tempDir, installRuntime, config, account, event } from './helpers.js';

const ID = 'vk-workspace';
const USER = 'user@example.com';
const BOT = { userId: 'bot@example.com' };
const buttons = [[{ text: 'Продолжить', callbackData: 'Продолжить', style: 'primary' }]];
const dataPayload = (data, text = 'Выберите') => ({ text, channelData: { [ID]: data } });
function fixture(settings = {}, payloads) {
  const cfg = config({ dmPolicy: 'allowlist', allowFrom: [USER], ...settings });
  const { core, seen } = installRuntime({ cfg, ...(payloads ? { payloads } : {}) });
  const sent = [], answered = [];
  const api = {
    sendTyping: async () => {},
    sendText: async (chatId, text, options = {}) => {
      sent.push({ chatId, text, options, kind: 'text' }); return { chatId, messageId: `sent-${sent.length}` };
    },
    sendFile: async (chatId, file, options = {}) => {
      sent.push({ chatId, file, options, kind: 'file' }); return { chatId, messageId: `sent-${sent.length}`, fileId: 'file-reuse' };
    },
    sendVoice: async (chatId, file, options = {}) => {
      sent.push({ chatId, file, options, kind: 'voice' }); return { chatId, messageId: `sent-${sent.length}` };
    },
    editText: async (chatId, messageId, text, options = {}) => { sent.push({ kind: 'edit', chatId, messageId, text, options }); },
    answerCallbackQuery: async (queryId, text) => { answered.push({ queryId, text }); },
  };
  const resolved = resolveAccount(cfg);
  return { cfg, core, seen, sent, answered, api, account: resolved, messageStore: getMessageStore(core, resolved) };
}
async function menu(f, { to = USER, owner = USER, data = 'Продолжить', chatType = 'private' } = {}) {
  const result = await sendPayload(to, dataPayload({ buttons: [[{ text: 'Выбор', callbackData: data }]] }), { ...f, requesterSenderId: owner });
  const token = f.sent.at(-1).options.inlineKeyboardMarkup[0][0].callbackData;
  return { eventId: 100, type: 'callbackQuery', payload: { queryId: 'query-100', from: { userId: owner }, callbackData: token,
    message: { msgId: result.messageId, chat: { chatId: to, type: chatType }, from: BOT, text: 'Выбор' } } };
}
const receive = (f, item) => handleInbound({ ...f, event: item, self: BOT });

test('Markdown renders supported spans, headings and code while escaping raw HTML', () => {
  assert.equal(formatText('**bold** *italic* ~~gone~~ `a<b`')[0].text, '<b>bold</b> <i>italic</i> <s>gone</s> <code>a&lt;b</code>');
  assert.equal(formatText('# Заголовок\n')[0].text, '<b>Заголовок\n</b>');
  assert.equal(formatText('<script>x</script> & "')[0].text, '&lt;script&gt;x&lt;/script&gt; &amp; &quot;');
  assert.equal(formatText('```js\nconst x = "<";\n```')[0].text, '<pre>const x = &quot;&lt;&quot;;\n</pre>');
  assert.equal(formatText('a_b_c \\*literal\\*')[0].text, 'a_b_c *literal*');
});
test('HTML chunks keep balanced tags, complete entities and Unicode, including long code', () => {
  const chunks = formatText('**' + '🚀<&'.repeat(1500) + '**');
  assert(chunks.length > 1);
  for (const chunk of chunks) {
    assert(chunk.text.length <= 4096); assert.equal(chunk.parseMode, 'HTML');
    assert(chunk.text.startsWith('<b>') && chunk.text.endsWith('</b>'));
    assert(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(chunk.text));
  }
  const plain = chunks.map((x) => x.text.replaceAll('<b>', '').replaceAll('</b>', '').replaceAll('&lt;', '<').replaceAll('&amp;', '&')).join('');
  assert.equal(plain, '🚀<&'.repeat(1500));
});
test('plain mode is lossless and does not set parseMode', () => {
  const input = '**bold** <b>not html</b> 🚀'.repeat(400);
  const chunks = formatText(input, { mode: 'plain' });
  assert.equal(chunks.map((x) => x.text).join(''), input); assert(chunks.every((x) => !x.parseMode));
  assert.throws(() => formatText('x'.repeat(1024 * 1024 + 1)), /size/);
});
for (const value of ['javascript:alert(1)', 'data:text/html,hi', 'https://u:password@example.com', 'https://example.com/a\nb']) {
  test(`unsafe link is not active: ${JSON.stringify(value)}`, () => {
    assert.equal(safeLink(value), false);
    assert(!formatText(`[x](${value})`).some((chunk) => chunk.text.includes('<a ')));
    assert.throws(() => normalizeButtons([[{ text: 'link', url: value }]]));
  });
}
test('valid link parameters are HTML escaped without changing the address', () => {
  assert.equal(formatText('[ссылка](https://example.com/?a=1&b=2)')[0].text, '<a href="https://example.com/?a=1&amp;b=2">ссылка</a>');
});
for (const bad of [null, [[]], [[{ text: 'x' }]], [[{ text: 'x', url: 'https://example.com', callbackData: 'x' }]],
  [[{ text: 'x', callbackData: 'я'.repeat(129) }]], [[{ text: 'x', callbackData: 'ok', style: 'unknown' }]],
  [[{ text: 'x', callbackData: 'ok', extra: true }]]]) {
  test(`invalid keyboard fails before delivery: ${JSON.stringify(bad).slice(0, 80)}`, () => assert.throws(() => normalizeButtons(bad)));
}
test('callbacks use opaque random tokens and persist only an expiring owner restriction', () => {
  const first = prepareKeyboard(buttons, USER, 1000), second = prepareKeyboard(buttons, USER, 1000);
  assert.match(first.keyboard[0][0].callbackData, /^ocw:[A-Za-z0-9_-]{24}$/);
  assert.notEqual(first.keyboard[0][0].callbackData, second.keyboard[0][0].callbackData);
  assert.equal(first.callbacks[0].data, 'Продолжить'); assert.equal(first.callbacks[0].ownerId, USER);
  assert.equal(first.callbacks[0].expiresAt, 1000 + CALLBACK_TTL_MS);
});
test('API serializes voice multipart, fileId reuse, HTML, edit and callback text over real HTTP', async (t) => {
  const server = await httpServer(t, (_req, res) => res.end(JSON.stringify({ ok: true, msgId: 'large-opaque-id', fileId: 'existing' })));
  const api = new TeamsApi(server.account);
  await api.sendText(USER, '<b>Hello</b>', { parseMode: 'HTML', inlineKeyboardMarkup: [[{ text: 'go', callbackData: 'nonce' }]] });
  await api.sendVoice(USER, { buffer: Buffer.from('ogg-audio'), fileName: 'sound.ogg', contentType: 'audio/ogg' }, { replyToId: 'm1' });
  await api.sendFile(USER, undefined, { fileId: 'existing', caption: 'caption' });
  await api.sendVoice(USER, undefined, { fileId: 'voice-existing' });
  await api.editText(USER, 'large-opaque-id', 'new', { inlineKeyboardMarkup: [] });
  await api.answerCallbackQuery('q1', 'Accepted');
  const requests = server.requests;
  assert.equal(requests[0].url.searchParams.get('parseMode'), 'HTML');
  assert.equal(requests[1].method, 'POST'); assert(requests[1].body.includes('ogg-audio'));
  assert.equal(requests[1].url.searchParams.get('replyMsgId'), 'm1');
  assert(!requests[1].body.includes('test-token')); assert.equal(requests[2].method, 'GET');
  assert.equal(requests[2].url.searchParams.get('fileId'), 'existing'); assert.equal(requests[3].method, 'GET');
  assert.equal(requests[4].url.searchParams.get('inlineKeyboardMarkup'), '[]');
  assert.equal(requests[5].url.searchParams.get('text'), 'Accepted'); assert(!requests[5].url.searchParams.has('textAnswer'));
  assert(requests.every((r) => r.url.searchParams.get('token') === server.account.token));
});
test('API rejects ambiguous media sources, missing edit acknowledgements and unsafe message numbers', async () => {
  const api = new TeamsApi(account(), async () => new Response(JSON.stringify({ ok: true, msgId: 9007199254740992 })));
  await assert.rejects(api.sendText(USER, 'x'), /missing message id/);
  await assert.rejects(api.sendVoice(USER), /exactly one/);
  await assert.rejects(api.sendFile(USER, {}, { fileId: 'both' }), /exactly one/);
  const missing = new TeamsApi(account(), async () => new Response('{}'));
  await assert.rejects(missing.editText(USER, 'm', 'text'), /confirmation/);
  await assert.rejects(missing.answerCallbackQuery('q', 'text'), /confirmation/);
});
test('fileId reuses media without a fetch; voice text is sent separately, with keyboard last', async () => {
  const f = fixture();
  await sendPayload(USER, dataPayload({ fileId: 'voice', voice: true, buttons }, 'Текст'), f);
  assert.deepEqual(f.sent.map((x) => x.kind), ['voice', 'text']);
  assert.equal(f.sent[0].options.fileId, 'voice'); assert.equal(f.sent[0].options.inlineKeyboardMarkup, undefined);
  assert(f.sent[1].options.inlineKeyboardMarkup); assert.equal(f.sent[1].text, 'Текст');
});
for (const [extension, kind] of [['ogg', 'voice'], ['aac', 'voice'], ['m4a', 'voice'], ['mp3', 'file']]) {
  test(`audioAsVoice sends ${extension} as ${kind}`, async (t) => {
    const root = await tempDir(t); const path = join(root, `sample.${extension}`); await writeFile(path, 'audio');
    const f = fixture(); await sendPayload(USER, { mediaUrl: path, audioAsVoice: true }, { ...f, mediaLocalRoots: [root] });
    assert.equal(f.sent[0].kind, kind);
  });
}
test('forceDocument overrides voice; preflight failure never partially sends earlier files', async (t) => {
  const root = await tempDir(t); const path = join(root, 'sample.ogg'); await writeFile(path, 'audio');
  const f = fixture();
  await sendPayload(USER, { mediaUrl: path, audioAsVoice: true }, { ...f, mediaLocalRoots: [root], forceDocument: true });
  assert.equal(f.sent[0].kind, 'file');
  await assert.rejects(sendPayload(USER, { mediaUrls: [path, join(root, 'missing')] }, { ...f, mediaLocalRoots: [root] }));
  assert.equal(f.sent.length, 1);
  await assert.rejects(sendPayload(USER, { ...dataPayload({ fileId: 'file' }), mediaUrl: path }, f), /mutually/);
});
test('all physical chunks report receipts; keyboard belongs to the last message only', async () => {
  const f = fixture(), receipts = [];
  const result = await sendPayload(USER, dataPayload({ buttons }, 'x'.repeat(9000)), { ...f, replyToId: 'original', onDeliveryResult: (x) => receipts.push(x) });
  assert.equal(receipts.length, 3); assert.equal(result.messageIds.length, 3);
  assert.equal(f.sent[0].options.replyToId, 'original'); assert.equal(f.sent[1].options.replyToId, undefined);
  assert(f.sent.slice(0, -1).every((x) => !x.options.inlineKeyboardMarkup)); assert(f.sent.at(-1).options.inlineKeyboardMarkup);
});
test('authority is revalidated after awaited host hooks and before each physical send', async () => {
  const f = fixture(); let checked = 0;
  await assert.rejects(sendPayload(USER, { text: 'x'.repeat(9000) }, { ...f,
    onPlatformSendDispatch: async () => {}, assertDirectAdapterHandoff: () => { if (++checked === 2) throw new Error('revoked'); } }), /delivery failed/);
  assert.equal(f.sent.length, 1);
  const controller = new AbortController();
  await assert.rejects(sendPayload(USER, { text: 'never' }, { ...f, signal: controller.signal, onPlatformSendDispatch: async () => controller.abort() }));
  assert.equal(f.sent.length, 1);
});
test('partial delivery retains receipts, sanitizes errors and is not reported as success', async () => {
  const f = fixture(); let calls = 0;
  f.api.sendText = async (chatId) => { if (++calls === 2) throw new Error('SECRET_TOKEN_IN_RAW_FAILURE'); return { chatId, messageId: 'confirmed' }; };
  await assert.rejects(sendPayload(USER, { text: 'x'.repeat(5000) }, f), (error) => {
    assert.equal(error.noRetry, true); assert.equal(error.sentBeforeError, true);
    assert.deepEqual(error.deliveryResult.messageIds, ['confirmed']); assert(!String(error).includes('SECRET')); return true;
  });
});
test('tracked text edits preserve or explicitly remove buttons; foreign and oversized edits fail', async () => {
  const f = fixture(); const item = await menu(f);
  const messageId = item.payload.message.msgId;
  await editMessage(USER, messageId, { text: '**Updated**' }, { ...f, requesterSenderId: USER });
  assert.equal(f.sent.at(-1).text, '<b>Updated</b>'); assert(f.sent.at(-1).options.inlineKeyboardMarkup);
  await editMessage(USER, messageId, { channelData: { [ID]: { buttons: [] } } }, f);
  assert.deepEqual(f.sent.at(-1).options.inlineKeyboardMarkup, []);
  const count = f.sent.length;
  await assert.rejects(editMessage(USER, 'not-owned', { text: 'x' }, f), /tracked/);
  await assert.rejects(editMessage('another-chat', messageId, { text: 'x' }, f), /tracked/);
  await assert.rejects(editMessage(USER, messageId, { text: 'x'.repeat(5000) }, f), /one non-empty/);
  assert.equal(f.sent.length, count);
});
test('an unauthorized edit cannot invalidate another sender\'s active keyboard', async () => {
  const f = fixture(); const item = await menu(f); const id = item.payload.message.msgId;
  await assert.rejects(editMessage(USER, id, { text: 'spoof' }, { ...f, requesterSenderId: 'other' }), /another sender/);
  assert(await f.messageStore.lookup(USER, id, item.payload.callbackData, USER));
  assert.equal(f.sent.length, 1);
});
test('ambiguous edit disarms the old menu instead of keeping invisible callback authority', async () => {
  const f = fixture(); const item = await menu(f); f.api.editText = async () => { throw new Error('network'); };
  await assert.rejects(editMessage(USER, item.payload.message.msgId, { text: 'new' }, f), /edit failed/);
  assert.equal(await f.messageStore.lookup(USER, item.payload.message.msgId, item.payload.callbackData, USER), null);
});
test('callbacks dispatch as the clicking user, not the bot, and deduplicate repeated menu choices', async () => {
  const f = fixture(); const item = await menu(f); await receive(f, item);
  assert.equal(f.seen.dispatches, 1); assert.equal(f.seen.contexts[0].SenderId, USER);
  assert.equal(f.seen.contexts[0].CommandBody, 'Продолжить'); assert.equal(f.seen.contexts[0].MessageSid, 'callback:query-100');
  assert.equal(f.sent.at(-1).options.replyToId, item.payload.message.msgId);
  assert(!JSON.stringify(f.seen.contexts).includes(item.payload.callbackData));
  await receive(f, { ...item, eventId: 101 }); assert.equal(f.seen.dispatches, 1);
});
test('concurrent callbacks consume one menu only once', async () => {
  const f = fixture(); const item = await menu(f);
  await Promise.all([receive(f, item), receive(f, { ...item, eventId: 101, payload: { ...item.payload, queryId: 'query-101' } })]);
  assert.equal(f.seen.dispatches, 1);
});
test('callback acknowledgement failure does not repeat or prevent the accepted choice', async () => {
  const f = fixture(); const item = await menu(f); f.api.answerCallbackQuery = async () => { throw new Error('unavailable'); };
  await receive(f, item); await receive(f, item); assert.equal(f.seen.dispatches, 1);
});
test('unauthorized callbacks do not issue pairing challenges, write sessions or consume the menu', async () => {
  const f = fixture({ dmPolicy: 'pairing', allowFrom: [] }); const item = await menu(f);
  await receive(f, item); assert.equal(f.seen.challenges.length, 0); assert.equal(f.seen.sessions.length, 0);
  assert.equal(f.seen.dispatches, 0); assert(await f.messageStore.lookup(USER, item.payload.message.msgId, item.payload.callbackData, USER));
});
for (const mutation of ['guessed-token', 'wrong-chat', 'wrong-owner', 'expired']) {
  test(`callback rejects ${mutation} before routing or dispatch`, async () => {
    const f = fixture({ allowFrom: [USER, 'other'] }); const item = await menu(f);
    if (mutation === 'guessed-token') item.payload.callbackData = 'ocw:' + 'a'.repeat(24);
    if (mutation === 'wrong-chat') item.payload.message.chat.chatId = 'other';
    if (mutation === 'wrong-owner') item.payload.from.userId = 'other';
    if (mutation === 'expired') f.messageStore = new MessageStore(f.messageStore.path, { now: () => Date.now() + CALLBACK_TTL_MS + 1 });
    await receive(f, item); assert.equal(f.seen.routes.length, 0); assert.equal(f.seen.dispatches, 0);
  });
}
test('a callback is an explicit group interaction but never bypasses sender or command access', async () => {
  const chat = 'g@chat.agent'; const f = fixture({ groupPolicy: 'allowlist', groupAllowFrom: [USER], groups: { [chat]: {} } });
  const item = await menu(f, { to: chat, chatType: 'group' }); await receive(f, item); assert.equal(f.seen.dispatches, 1);
  const blocked = fixture({ groupPolicy: 'open', groupAllowFrom: [] });
  const cmd = await menu(blocked, { to: chat, chatType: 'group', data: '/reset' }); await receive(blocked, cmd);
  assert.equal(blocked.seen.dispatches, 0); assert.equal(blocked.seen.sessions.length, 0);
  assert(await blocked.messageStore.lookup(chat, cmd.payload.message.msgId, cmd.payload.callbackData, USER));
});
test('edits/deletes and invalid callback envelopes never become new agent messages', () => {
  for (const type of ['editedMessage', 'deletedMessage']) assert.equal(parseMessage({ ...event(), type }, BOT), null);
  assert.equal(parseMessage({ type: 'callbackQuery', payload: { callbackData: '/reset' } }, BOT), null);
});
test('message receipts and callback state are isolated by bot account and survive a new store instance', async () => {
  const f = fixture(); const item = await menu(f);
  const restarted = new MessageStore(f.messageStore.path);
  assert.equal(await restarted.lookup(USER, item.payload.message.msgId, item.payload.callbackData, USER), 'Продолжить');
  assert.notEqual(messageStorePath(f.core, f.account), messageStorePath(f.core, { ...f.account, accountId: 'work' }));
  assert.notEqual(messageStorePath(f.core, f.account), messageStorePath(f.core, { ...f.account, token: 'another' }));
});
test('message store refuses corrupt state and expires old receipts', async (t) => {
  const path = join(await tempDir(t), 'messages.json'); await writeFile(path, '{invalid');
  await assert.rejects(new MessageStore(path).get(USER, 'm'), /corrupt/);
  const f = fixture(); const item = await menu(f);
  const expired = new MessageStore(f.messageStore.path, { now: () => Date.now() + 8 * 86400000 });
  assert.equal(await expired.get(USER, item.payload.message.msgId), undefined);
  assert.equal((await stat(f.messageStore.path)).mode & 0o777, 0o600);
});
test('message action discovery and prepared sends expose supported fields without granting callback privileges', () => {
  const f = fixture(); const found = messageActions.describeMessageTool({ cfg: f.cfg });
  assert.deepEqual(found.actions, ['send', 'edit']); assert.equal(found.schema.properties.vkVoice.type, 'boolean');
  const ctx = { cfg: f.cfg, accountId: 'default', requesterAccountId: 'default', requesterSenderId: USER,
    toolContext: { currentChannelProvider: ID, currentChannelId: USER }, params: { vkButtons: buttons, vkTextFormat: 'plain' } };
  const payload = messageActions.prepareSendPayload({ ctx, to: USER, payload: { text: 'Choose' } });
  assert.equal(payload.channelData[ID].buttonOwnerId, USER); assert.equal(payload.channelData[ID].textFormat, 'plain');
  assert.equal(channelPlugin.capabilities.tts.voice.synthesisTarget, 'voice-note');
});
test('message action edit refuses forged cross-account and cross-chat requester context', async () => {
  const f = fixture();
  const ctx = { cfg: f.cfg, action: 'edit', accountId: 'default', requesterAccountId: 'other', requesterSenderId: USER,
    toolContext: { currentChannelProvider: ID, currentChannelId: USER }, params: { to: USER, messageId: 'm', message: 'x' } };
  await assert.rejects(messageActions.handleAction(ctx), /current account/);
  await assert.rejects(messageActions.handleAction({ ...ctx, requesterAccountId: 'default', params: { ...ctx.params, to: 'other' } }), /current account/);
});
test('unknown channelData fields and formats are rejected rather than silently ignored', () => {
  assert.throws(() => channelData(dataPayload({ anything: true })));
  assert.throws(() => channelData(dataPayload({ voice: 'yes' })));
  assert.throws(() => channelData(dataPayload({ textFormat: 'HTML' })));
});
test('a failing turn is quarantined after one attempt; later messages in its chat do not overtake it', async (t) => {
  const inbox = await new Inbox(join(await tempDir(t), 'inbox.json')).open(); t.after(() => inbox.close());
  await inbox.ingest([event(1), event(2), event(3, { chat: { chatId: 'another', type: 'private' } })]);
  let attempts = 0;
  const handle = async (item) => { if (item.eventId === '1') { attempts++; throw new Error('partially sent'); } };
  await drainInbox({ inbox, handle }); await drainInbox({ inbox, handle });
  assert.equal(attempts, 1); assert.equal(inbox.state.failed.length, 1); assert.deepEqual(inbox.state.pending.map((x) => x.event.eventId), ['2']);
  await inbox.discardFailed('1'); await drainInbox({ inbox, handle }); assert.equal(inbox.state.pending.length, 0);
});
test('interrupted started turns survive cancellation and restart into failed, not automatic replay', async (t) => {
  const path = join(await tempDir(t), 'inbox.json'); const inbox = await new Inbox(path).open(); await inbox.ingest([event(1)]);
  const controller = new AbortController();
  await drainInbox({ inbox, signal: controller.signal, handle: async () => {
    assert.equal(JSON.parse(await readFile(path, 'utf8')).pending[0].started, true); controller.abort();
  } });
  await inbox.close(); const restarted = await new Inbox(path).open(); t.after(() => restarted.close());
  assert.equal(restarted.state.pending.length, 0); assert.equal(restarted.state.failed[0].reason, 'interrupted');
  await restarted.retryFailed(); assert.equal(restarted.state.pending[0].started, false);
});
test('startup self/get uses abortable backoff and recovers without restarting the account', async (t) => {
  const path = join(await tempDir(t), 'inbox.json'), controller = new AbortController();
  const waits = [], statuses = []; let calls = 0;
  await monitorAccount({ account: account(), cfg: config(), abortSignal: controller.signal, setStatus: (x) => statuses.push(x) }, {
    core: {}, inbox: new Inbox(path), delay: async (ms) => waits.push(ms), api: {
      getSelf: async () => { if (++calls < 3) throw new ApiError('self/get', 'network request failed'); return BOT; },
      getEvents: async () => { controller.abort(); return []; },
    },
  });
  assert.deepEqual(waits, [1000, 2000]); assert.equal(calls, 3); assert.equal(statuses.at(-1).running, false);
});
test('atomic state write rejects directory-fsync failure and cleans temporary files', async (t) => {
  const path = join(await tempDir(t), 'state.json'); let synced;
  await atomicWrite(path, 'first', async (dir) => { synced = dir; }); assert.equal(synced, join(path, '..'));
  await assert.rejects(atomicWrite(path, 'next', async () => { throw new Error('fsync failed'); }), /fsync failed/);
});
