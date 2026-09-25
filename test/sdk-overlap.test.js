import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TeamsApi } from '../src/api.js';
import { nativeChunks, validateNativeFormat } from '../src/rich-format.js';
import { startActivity } from '../src/activity.js';
import { messageActions } from '../src/actions.js';
import { channelData, sendPayload, editMessage } from '../src/send.js';
import { getMessageStore, MessageStore } from '../src/message-store.js';
import { prepareKeyboard } from '../src/keyboard.js';
import { Inbox } from '../src/inbox.js';
import { drainInbox } from '../src/monitor.js';
import { handleInbound } from '../src/inbound.js';
import { resolveAccount } from '../src/config.js';
import { config, event, httpServer, installRuntime, tempDir } from './helpers.js';

const USER = 'user@example.com', BOT = 'bot@example.com';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, responder) {
  const server = await httpServer(t, (req, res) => {
    if (responder) return responder(req, res);
    res.end(JSON.stringify({ ok: true, msgId: `m-${server.requests.length}`, fileId: 'file' }));
  });
  const cfg = config({ baseUrl: server.origin, allowInsecureHttp: true, dmPolicy: 'allowlist', allowFrom: [USER] });
  const { core, seen } = installRuntime({ cfg });
  const account = resolveAccount(cfg), api = new TeamsApi(account);
  const store = getMessageStore(core, account);
  const options = { account, cfg, core, api, messageStore: store, requesterSenderId: USER };
  const action = (action, params, extra = {}) => messageActions.handleAction({ action, cfg, accountId: 'default',
    requesterSenderId: USER, requesterAccountId: 'default', toolContext: { currentChannelProvider: 'vk-workspace', currentChannelId: USER },
    params: { target: USER, ...params }, ...extra });
  return { ...server, cfg, core, seen, account, api, store, options, action };
}

test('native ranges preserve Cyrillic, astral characters, overlap and metadata without mutating input', () => {
  const text = 'А😀Б link code';
  const format = { bold: [{ offset: 0, length: 4 }], italic: [{ offset: 1, length: 2 }],
    link: [{ offset: 5, length: 4, url: 'https://example.com/?a=1&b=2' }], pre: [{ offset: 10, length: 4, language: 'js' }] };
  const before = structuredClone(format);
  const chunks = nativeChunks(text, format, 6);
  assert.equal(chunks.map((p) => p.text).join(''), text);
  for (const part of chunks) { assert(part.text.length <= 6); assert(part.text.isWellFormed()); validateNativeFormat(part.text, part.format ?? {}); }
  assert.deepEqual(format, before);
  assert.deepEqual(chunks[0].format.bold, [{ offset: 0, length: 4 }]);
});

test('all documented simple styles serialize as range arrays', () => {
  for (const style of ['bold', 'italic', 'underline', 'strikethrough', 'mention', 'inline_code', 'ordered_list', 'unordered_list', 'quote']) {
    assert.deepEqual(validateNativeFormat('text', { [style]: [{ offset: 0, length: 4 }] }), { [style]: [{ offset: 0, length: 4 }] });
  }
});

test('native range validation rejects unsafe bounds, surrogate splits, unknown keys and unsafe links', () => {
  for (const format of [null, [], { secret: [] }, { bold: [null] }, { bold: [{ offset: -1, length: 1 }] },
    { bold: [{ offset: 0, length: 0 }] }, { bold: [{ offset: 2, length: 1 }] }, { bold: [{ offset: 1, length: 1 }] },
    { bold: [{ offset: 0, length: 20 }] }, { bold: [{ offset: 0.5, length: 1 }] },
    { bold: [{ offset: 0, length: 1, userId: 'unexpected' }] }, { link: [{ offset: 0, length: 1, url: 'javascript:alert(1)' }] },
    { link: [{ offset: 0, length: 1, url: 'https://secret@example.com/' }] }, { pre: [{ offset: 0, length: 1, language: '<script>' }] },
    { bold: Array.from({ length: 101 }, () => ({ offset: 0, length: 1 })) }]) {
    assert.throws(() => validateNativeFormat('А😀Б', format));
  }
  assert.throws(() => validateNativeFormat('\ud800', {}));
  assert.throws(() => validateNativeFormat('a'.repeat(1024 * 1024 + 1), {}));
});

test('native mentions move intact to the next chunk rather than being split or duplicated', () => {
  const text = 'abcd@[x]efgh';
  const chunks = nativeChunks(text, { mention: [{ offset: 4, length: 4 }], bold: [{ offset: 0, length: 12 }] }, 6);
  assert.deepEqual(chunks.map((c) => c.text), ['abcd', '@[x]ef', 'gh']);
  assert.deepEqual(chunks[1].format.mention, [{ offset: 0, length: 4 }]);
  assert.equal(chunks.filter((c) => c.format?.mention).length, 1);
  assert.throws(() => nativeChunks('abcdefgh', { mention: [{ offset: 0, length: 8 }] }, 6), /single message chunk/);
});

test('native API contracts use JSON format, repeated quote IDs and multipart metadata in the query', async (t) => {
  const f = await fixture(t), format = { underline: [{ offset: 0, length: 3 }] };
  await f.api.sendText(USER, 'А😀', { format, replyToId: ['one', 'two'] });
  assert.deepEqual(f.requests[0].url.searchParams.getAll('replyMsgId'), ['one', 'two']);
  assert.equal(f.requests[0].url.searchParams.getAll('format').length, 1);
  assert.deepEqual(JSON.parse(f.requests[0].url.searchParams.get('format')), format);
  assert.equal(f.requests[0].url.searchParams.has('parseMode'), false);
  await f.api.sendFile(USER, { buffer: Buffer.from('FILE'), fileName: 'x.txt' }, { caption: 'А😀', format, replyToId: ['one', 'two'] });
  assert.equal(f.requests[1].method, 'POST');
  assert.match(f.requests[1].body, /name="file"; filename="x.txt"/);
  assert.doesNotMatch(f.requests[1].body, /name="(?:token|format|caption)"/);
  assert.deepEqual(JSON.parse(f.requests[1].url.searchParams.get('format')), format);
  await f.api.editText(USER, 'one', 'А😀', { format });
  assert.equal(f.requests[2].url.searchParams.has('parseMode'), false);
  const count = f.requests.length;
  await assert.rejects(f.api.sendText(USER, 'А😀', { format, parseMode: 'HTML' }), /mutually exclusive/);
  await assert.rejects(f.api.sendText(USER, 'a', { replyToId: ['one', 'one'] }), /Duplicate/);
  await assert.rejects(f.api.sendText(USER, 'a', { replyToId: [] }));
  await assert.rejects(f.api.sendText(USER, 'a', { replyToId: ['one'], forwardChatId: USER, forwardMessageIds: ['two'] }));
  assert.equal(f.requests.length, count);
});

test('callback alerts preserve explicit false and activities preserve the empty stop value', async (t) => {
  const f = await fixture(t);
  await f.api.answerCallbackQuery('q', 'Denied', { showAlert: true });
  await f.api.answerCallbackQuery('q', '', { showAlert: false });
  await f.api.sendActions(USER, ['typing', 'looking']);
  await f.api.stopTyping(USER);
  assert.equal(f.requests[0].url.searchParams.get('showAlert'), 'true');
  assert.equal(f.requests[1].url.searchParams.get('showAlert'), 'false');
  assert.deepEqual(f.requests[2].url.searchParams.getAll('actions'), ['typing', 'looking']);
  assert.deepEqual(f.requests[3].url.searchParams.getAll('actions'), ['']);
  assert.throws(() => f.api.sendActions(USER, ['unsupported']));
  assert.throws(() => f.api.sendActions(USER, ['typing', 'typing']));
  await assert.rejects(f.api.answerCallbackQuery('q', '', { showAlert: 'false' }));
  assert.equal(f.requests.length, 4);
});

test('native formatted sends chunk losslessly, quote only once and preserve format on button-only edits', async (t) => {
  const f = await fixture(t), text = 'x'.repeat(4095) + '😀' + 'Б'.repeat(100);
  const format = { bold: [{ offset: 0, length: text.length }] };
  const payload = { text, channelData: { 'vk-workspace': { format, replyToIds: ['q1', 'q2'] } } };
  const result = await sendPayload(USER, payload, f.options);
  assert.equal(result.messageIds.length, 2);
  assert.equal(f.requests.map((req) => req.url.searchParams.get('text')).join(''), text);
  assert.deepEqual(f.requests[0].url.searchParams.getAll('replyMsgId'), ['q1', 'q2']);
  assert.equal(f.requests[1].url.searchParams.has('replyMsgId'), false);
  await editMessage(USER, result.messageIds[0], { channelData: { 'vk-workspace': { buttons: [] } } }, f.options);
  assert(f.requests.at(-1).url.searchParams.has('format'));
  assert.equal(f.requests.at(-1).url.searchParams.has('parseMode'), false);
  await editMessage(USER, result.messageIds[0], { text: '**new**' }, f.options);
  assert.equal(f.requests.at(-1).url.searchParams.get('parseMode'), 'HTML');
  assert.equal(f.requests.at(-1).url.searchParams.has('format'), false);
  assert.equal((await f.store.get(USER, result.messageIds[0])).format, undefined);
});

test('native format validates before media downloads or physical sends and cannot be mixed with Markdown', async (t) => {
  const f = await fixture(t);
  for (const data of [{ format: { bold: [{ offset: 10, length: 1 }] } }, { format: {}, textFormat: 'markdown' },
    { replyToIds: [] }, { replyToIds: ['q'], forward: { chatId: USER, messageIds: ['m'] } }]) {
    await assert.rejects(sendPayload(USER, { text: 'a', mediaUrl: '/not-allowed', channelData: { 'vk-workspace': data } }, f.options));
  }
  assert.equal(f.requests.length, 0);
  assert.throws(() => channelData({ channelData: { 'vk-workspace': { format: {} } } }));
});

test('message-tool fields survive prepareSendPayload and reject conflicting explicit references', async (t) => {
  const f = await fixture(t), format = { quote: [{ offset: 0, length: 3 }] };
  const ctx = { cfg: f.cfg, params: { vkFormat: format, vkReplyToIds: ['q1', 'q2'] } };
  const prepared = messageActions.prepareSendPayload({ ctx, to: USER, payload: { text: 'abc' }, replyToId: 'implicit' });
  assert.deepEqual(prepared.channelData['vk-workspace'].format, format);
  await sendPayload(USER, prepared, { ...f.options, replyToId: 'implicit' });
  assert.deepEqual(f.requests[0].url.searchParams.getAll('replyMsgId'), ['q1', 'q2']);
  assert.throws(() => messageActions.prepareSendPayload({ ctx: { ...ctx, params: { ...ctx.params, replyTo: 'q' } }, to: USER, payload: { text: 'abc' } }));
  await assert.rejects(f.action('edit', { messageId: 'm', message: 'abc', vkReplyToIds: ['q'] }));
  assert(messageActions.describeMessageTool({ cfg: f.cfg }).schema.properties.vkFormat.properties.underline);
});

test('one delete request removes an explicit batch of tracked bot replies', async (t) => {
  const f = await fixture(t);
  const sent = await sendPayload(USER, { text: 'x'.repeat(5000) }, f.options);
  const result = await f.action('delete', { vkMessageIds: sent.messageIds });
  assert.equal(result.details.deleted, true);
  assert.deepEqual(result.details.messageIds, sent.messageIds);
  assert.deepEqual(f.requests.at(-1).url.searchParams.getAll('msgId'), sent.messageIds);
  for (const id of sent.messageIds) assert.equal(await f.store.get(USER, id), undefined);
});

test('batch authorization is atomic: an unknown or other-sender receipt leaves every menu live', async (t) => {
  const f = await fixture(t), menu = prepareKeyboard([[{ text: 'yes', callbackData: 'yes' }]], USER);
  await f.store.remember(USER, 'mine', { kind: 'text', text: 'a', requesterId: USER, ...menu });
  await f.store.remember(USER, 'other', { kind: 'text', text: 'a', requesterId: 'other' });
  for (const second of ['missing', 'other']) {
    await assert.rejects(f.action('delete', { vkMessageIds: ['mine', second] }));
    assert.equal(await f.store.lookup(USER, 'mine', menu.callbacks[0].token, USER), 'yes');
    assert.equal((await f.store.get(USER, 'mine')).deletePending, undefined);
  }
  await assert.rejects(f.action('delete', { messageId: 'mine', vkMessageIds: ['mine'] }));
  await assert.rejects(f.action('delete', { vkMessageIds: ['mine', 'mine'] }));
  await assert.rejects(f.action('delete', { vkMessageIds: ['mine'] }, { requesterAccountId: 'other' }));
  assert.equal(f.requests.length, 0);
});

test('uncertain batch deletion fences every menu and is never automatically repeated', async (t) => {
  const f = await fixture(t, (_req, res) => { res.statusCode = 503; res.end('{}'); });
  const menu = prepareKeyboard([[{ text: 'yes', callbackData: 'yes' }]], USER);
  for (const id of ['a', 'b']) await f.store.remember(USER, id, { kind: 'text', requesterId: USER, ...menu });
  await assert.rejects(f.action('delete', { vkMessageIds: ['a', 'b'] }), (error) => error.noRetry === true && error.mayHaveSent === true);
  for (const id of ['a', 'b']) {
    assert.equal((await f.store.get(USER, id)).deletePending, true);
    assert.equal(await f.store.lookup(USER, id, menu.callbacks[0].token, USER), null);
  }
  await assert.rejects(f.action('delete', { vkMessageIds: ['a', 'b'] }), /uncertain/);
  assert.equal(f.requests.length, 1);
});

test('activity stop waits for in-flight typing and prevents a late reactivation', async () => {
  const gate = deferred(), calls = [];
  const stop = startActivity({ sendTyping: async () => { calls.push('typing'); await gate.promise; }, stopTyping: async () => calls.push('stop') }, USER);
  await Promise.resolve();
  const stopping = stop();
  assert.deepEqual(calls, ['typing']);
  gate.resolve(); await stopping; await stop();
  assert.deepEqual(calls, ['typing', 'stop']);
});

test('shutdown prevents new activity sends and activity errors do not fail a reply', async () => {
  const controller = new AbortController(); controller.abort();
  const calls = [];
  await startActivity({ sendTyping: async () => calls.push('typing'), stopTyping: async () => calls.push('stop') }, USER, controller.signal)();
  assert.deepEqual(calls, []);
  const stop = startActivity({ sendTyping: async () => { throw new Error('private provider error'); }, stopTyping: async () => { throw new Error('private error'); } }, USER);
  await Promise.resolve(); await stop();
});

test('inbound failure clears activity but does not send after shutdown', async () => {
  const cfg = config({ dmPolicy: 'allowlist', allowFrom: [USER] });
  const { core } = installRuntime({ cfg });
  const calls = [];
  core.channel.reply.dispatchReplyWithBufferedBlockDispatcher = async () => { throw new Error('raw provider error'); };
  const api = { sendTyping: async () => calls.push('typing'), stopTyping: async () => calls.push('stop') };
  await assert.rejects(handleInbound({ cfg, account: resolveAccount(cfg), event: event(), self: { userId: BOT }, api }), /OpenClaw reply processing failed/);
  assert.equal(calls.at(-1), 'stop');
});

test('known edits update only unstarted matching-author messages before dispatch', async (t) => {
  const dir = await tempDir(t), inbox = await new Inbox(join(dir, 'inbox.json')).open();
  t.after(() => inbox.close());
  const original = event(1, { parts: [{ type: 'file', payload: { fileId: 'old-file' } }] });
  const edit = { ...event(2, { msgId: original.payload.msgId, text: 'updated' }), type: 'editedMessage' };
  await inbox.ingest([edit, original]);
  assert.equal(inbox.state.pending[0].event.payload.text, 'updated');
  assert.deepEqual(inbox.state.pending[0].event.payload.parts, []);
  const seen = [];
  await drainInbox({ inbox, handle: async (event) => seen.push(event) });
  assert.equal(seen[0].type, 'newMessage'); assert.equal(seen[0].payload.text, 'updated');
  assert.equal(inbox.state.pending.length, 0);
});

test('known deletions cancel unstarted originals without blocking unrelated chats', async (t) => {
  const dir = await tempDir(t), inbox = await new Inbox(join(dir, 'inbox.json')).open();
  t.after(() => inbox.close());
  const original = event(1);
  await inbox.ingest([original, { ...event(2, { msgId: original.payload.msgId }), type: 'deletedMessage' },
    event(3, { chat: { chatId: 'other', type: 'private' } })]);
  const seen = [];
  await drainInbox({ inbox, handle: async (event) => seen.push(event.eventId) });
  assert.deepEqual(seen.sort(), ['2', '3']);
});

test('edits cannot replace a different author, change routing or replay a started turn', async (t) => {
  const dir = await tempDir(t), inbox = await new Inbox(join(dir, 'inbox.json')).open();
  t.after(() => inbox.close());
  const original = event(1), edit = { ...event(2, { msgId: original.payload.msgId, text: '/model evil', from: { userId: 'other' } }), type: 'editedMessage' };
  await inbox.ingest([original, edit]);
  assert.equal(inbox.state.pending[0].event.payload.text, 'Привет');
  await inbox.start('1');
  await inbox.ingest([{ ...edit, eventId: 3, payload: { ...edit.payload, from: original.payload.from } },
    { ...edit, eventId: 4, type: 'deletedMessage' }]);
  assert.equal(inbox.state.pending[0].event.payload.text, 'Привет');
  assert.equal(inbox.state.pending[0].cancelledBy, undefined);
});

test('a cancelled pending message stays cancelled across restart', async (t) => {
  const dir = await tempDir(t), path = join(dir, 'inbox.json');
  const inbox = await new Inbox(path).open(), original = event(1);
  await inbox.ingest([original, { ...event(2, { msgId: original.payload.msgId }), type: 'deletedMessage' }]);
  await inbox.close();
  const restarted = await new Inbox(path).open(); t.after(() => restarted.close());
  const seen = []; await drainInbox({ inbox: restarted, handle: async (event) => seen.push(event.eventId) });
  assert.deepEqual(seen, ['2']);
});

test('external text edits disarm menus while the bot own matching edit event preserves them', async (t) => {
  const dir = await tempDir(t), store = new MessageStore(join(dir, 'messages.json'));
  const menu = prepareKeyboard([[{ text: 'yes', callbackData: 'yes' }]], USER);
  await store.remember(USER, 'm', { kind: 'text', text: '<b>A &lt; B &amp; C</b>', parseMode: 'HTML', requesterId: USER, ...menu });
  await store.observeEdit(USER, 'm', 'A < B & C');
  assert.equal(await store.lookup(USER, 'm', menu.callbacks[0].token, USER), 'yes');
  await store.observeEdit(USER, 'm', 'external change');
  assert.equal(await store.lookup(USER, 'm', menu.callbacks[0].token, USER), null);
  assert.equal((await store.get(USER, 'm')).parseMode, undefined);
});

test('service events never start new agent turns or grant sender access', async (t) => {
  const f = await fixture(t);
  for (const type of ['editedMessage', 'deletedMessage', 'pinnedMessage', 'unpinnedMessage', 'newChatMembers', 'leftChatMembers']) {
    await handleInbound({ event: { ...event(100), type }, self: { userId: BOT }, ...f.options });
  }
  assert.equal(f.seen.dispatches, 0); assert.equal(f.requests.length, 0);
});

test('accepted callbacks use a non-alert acknowledgement and expired callbacks use an alert', async (t) => {
  const f = await fixture(t);
  const menu = prepareKeyboard([[{ text: 'Choose', callbackData: 'chosen' }]], USER);
  await f.store.remember(USER, 'menu', { kind: 'text', text: 'Choose', requesterId: USER, ...menu });
  const click = { type: 'callbackQuery', payload: { queryId: 'choice', from: { userId: USER },
    callbackData: menu.callbacks[0].token, message: { msgId: 'menu', from: { userId: BOT }, chat: { chatId: USER, type: 'private' } } } };
  await handleInbound({ ...f.options, event: click, self: { userId: BOT } });
  await handleInbound({ ...f.options, event: click, self: { userId: BOT } });
  const acks = f.requests.filter((request) => request.url.pathname.endsWith('/answerCallbackQuery'));
  assert.deepEqual(acks.map((request) => request.url.searchParams.get('showAlert')), ['false', 'true']);
  assert.equal(f.seen.dispatches, 1);
});
