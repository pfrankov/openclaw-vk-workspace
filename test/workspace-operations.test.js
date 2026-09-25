import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeamsApi, ApiError } from '../src/api.js';
import { messageActions } from '../src/actions.js';
import { channelData, sendPayload, editMessage } from '../src/send.js';
import { getMessageStore, MessageStore } from '../src/message-store.js';
import { prepareKeyboard } from '../src/keyboard.js';
import { resolveAccount, channelSchema } from '../src/config.js';
import { handleInbound } from '../src/inbound.js';
import { httpServer, installRuntime, config } from './helpers.js';

const CHANNEL = 'vk-workspace', CHAT = '123@chat.agent', USER = 'user@example.com';
const flags = { delete: true, forward: true, pins: true, chatInfo: true, threads: true, chatManagement: true };
async function fixture(t, handler, settings = {}) {
  const server = await httpServer(t, async (req, res) => {
    const custom = await handler?.(req, res);
    if (res.writableEnded || custom === false) return;
    const path = req.url.pathname;
    const data = path.endsWith('/getInfo') ? { type: 'group', title: 'Test' }
      : path.endsWith('/getMembers') ? { members: [{ userId: USER, admin: false }] }
      : path.endsWith('/getAdmins') ? { admins: [{ userId: USER, admin: true }] }
      : path.endsWith('/subscribers/get') ? { subscribers: [{ sn: USER }] }
      : path.endsWith('/threads/add') ? { threadId: 'thread@chat.agent' }
      : { ok: true, msgId: `sent-${server.requests.length}` };
    res.end(JSON.stringify(data));
  });
  const cfg = config({ baseUrl: server.origin, allowInsecureHttp: true, actions: flags, ...settings });
  const runtime = installRuntime({ cfg });
  const account = resolveAccount(cfg);
  const ctx = { cfg, accountId: 'default', requesterAccountId: 'default', requesterSenderId: USER,
    toolContext: { currentChannelProvider: CHANNEL, currentMessagingTarget: CHAT, currentMessageId: 'inbound-1' } };
  return { ...server, ...runtime, cfg, account, ctx, store: getMessageStore(runtime.core, account),
    run: (action, params = {}, extra = {}) => messageActions.handleAction({ ...ctx, action, params: { target: CHAT, ...params }, ...extra }) };
}
const menu = () => prepareKeyboard([[{ text: 'Yes', callbackData: 'yes' }]], USER);

test('new operations are scoped by account flags, never by model-provided owner fields', async (t) => {
  const f = await fixture(t, undefined, { actions: {} });
  assert.deepEqual(messageActions.describeMessageTool({ cfg: f.cfg }).actions, ['send', 'edit', 'delete']);
  for (const action of ['pin', 'unpin', 'channel-info', 'member-info', 'thread-create', 'channel-edit']) {
    await assert.rejects(f.run(action, { senderIsOwner: true, messageId: '1', userId: USER, vkChatUpdate: { title: 'New' } }, { senderIsOwner: true }), /requires actions/);
  }
  assert.equal(f.requests.length, 0);
  assert.deepEqual(messageActions.describeMessageTool({ cfg: config({ enabled: false }) }).actions, []);
  const cfg = config({ actions: flags, accounts: { limited: { actions: { pins: false, forward: false }, botToken: 'OTHER' } } });
  assert.equal(messageActions.describeMessageTool({ cfg, accountId: 'limited' }).actions.includes('pin'), false);
  assert.equal(resolveAccount(cfg, 'limited').config.actions.chatInfo, true);
  assert.equal(resolveAccount(cfg, 'limited').config.actions.forward, false);
  assert.equal(channelSchema.properties.contextVisibility.enum.includes('allowlist_quote'), true);
  for (const action of ['pin', 'delete', 'channel-edit', 'thread-create']) assert.equal(messageActions.isToolDeliveryAction({ args: { action } }), true);
  for (const action of ['member-info', 'channel-info']) assert.equal(messageActions.isToolDeliveryAction({ args: { action } }), false);
});

test('direct action authorization rejects missing, wrong-account and cross-chat actors before HTTP', async (t) => {
  const f = await fixture(t);
  for (const extra of [{ requesterSenderId: undefined }, { requesterAccountId: 'other' }, { toolContext: { currentChannelProvider: 'vk' } }]) {
    for (const action of ['delete', 'channel-info', 'member-info', 'thread-create']) {
      await assert.rejects(f.run(action, { messageId: '1', userId: USER, senderIsOwner: true }, extra), /trusted current conversation/);
    }
  }
  for (const action of ['pin', 'unpin', 'channel-edit']) await assert.rejects(f.run(action, { messageId: '1', vkChatUpdate: { title: 'New' } }), /trusted OpenClaw owner/);
  await assert.rejects(f.run('channel-info', { target: 'another@chat.agent' }), /trusted current conversation/);
  assert.equal(f.requests.length, 0);
});

test('new action dry runs validate arguments and caller only, without HTTP or durable receipts', async (t) => {
  const f = await fixture(t);
  for (const [action, params] of [['delete', { messageId: '1' }], ['pin', { messageId: '1' }],
    ['channel-info', {}], ['member-info', { userId: USER }], ['thread-create', { messageId: '1' }],
    ['channel-edit', { vkChatUpdate: { rules: '' } }]]) {
    const result = await f.run(action, params, { senderIsOwner: true, dryRun: true });
    assert.equal(result.details.validated, 'arguments-and-caller-policy');
  }
  for (const params of [{}, { vkChatUpdate: {} }, { vkChatUpdate: { title: 'x', about: 'y' } },
    { vkChatUpdate: { threadAutoSubscribe: false, includeExistingThreads: true } }, { vkChatUpdate: { title: '', garbage: true } }]) {
    await assert.rejects(f.run('channel-edit', params, { senderIsOwner: true, dryRun: true }));
  }
  await assert.rejects(f.run('delete', { messageId: 9007199254740992 }, { dryRun: true }));
  assert.equal(f.requests.length, 0);
});

test('native delete disarms callbacks durably before the one repeated-msgId API call', async (t) => {
  let f, observed;
  f = await fixture(t, async (req) => {
    if (req.url.pathname.endsWith('/deleteMessages')) observed = await new MessageStore(f.store.path).get(CHAT, 'owned');
  });
  const keyboard = menu();
  await f.store.remember(CHAT, 'owned', { kind: 'file', requesterId: USER, ...keyboard });
  const result = await f.run('delete', { messageId: 'owned' });
  assert.equal(observed.deletePending, true);
  assert.deepEqual(observed.callbacks, []);
  assert.equal(result.details.deleted, true);
  assert.equal(await f.store.get(CHAT, 'owned'), undefined);
  assert.equal(await f.store.lookup(CHAT, 'owned', keyboard.callbacks[0].token, USER), null);
  assert.deepEqual(f.requests[0].url.searchParams.getAll('msgId'), ['owned']);
  assert.equal(f.requests[0].url.searchParams.has('msgIds'), false);
  assert.equal(f.requests[0].url.searchParams.get('token'), f.account.token);
});

test('failed delete is not retried and its callback fence survives a new store instance', async (t) => {
  const f = await fixture(t, (req, res) => {
    if (req.url.pathname.endsWith('/deleteMessages')) res.end(JSON.stringify({ ok: false, description: `https://internal/?token=${f.account.token}` }));
  });
  const keyboard = menu();
  await f.store.remember(CHAT, 'owned', { kind: 'text', text: 'test', requesterId: USER, ...keyboard });
  await assert.rejects(f.run('delete', { messageId: 'owned' }), (error) => error.noRetry && error.mayHaveSent && !error.message.includes(f.account.token));
  const restarted = new MessageStore(f.store.path);
  assert.equal((await restarted.get(CHAT, 'owned')).deletePending, true);
  await assert.rejects(f.run('delete', { messageId: 'owned' }), /uncertain/);
  await assert.rejects(editMessage(CHAT, 'owned', { text: 'edit' }, { cfg: f.cfg, account: f.account, core: f.core }), /tracked bot text/);
  assert.equal(f.requests.length, 1);
  await handleInbound({ event: { type: 'deletedMessage', payload: { chat: { chatId: CHAT }, msgId: 'owned' } }, self: { userId: 'bot' }, ...f });
  assert.equal(await restarted.get(CHAT, 'owned'), undefined);
  assert.equal(f.seen.dispatches, 0);
});

test('deleting unknown or another requester receipt makes no HTTP call and retains the menu', async (t) => {
  const f = await fixture(t), keyboard = menu();
  await f.store.remember(CHAT, 'other', { kind: 'text', text: 'test', requesterId: 'other@example.com', ...keyboard });
  await assert.rejects(f.run('delete', { messageId: 'missing' }), /tracked bot/);
  await assert.rejects(f.run('delete', { messageId: 'other' }), /another sender/);
  assert.equal((await f.store.get(CHAT, 'other')).callbacks.length, 1);
  assert.equal(f.requests.length, 0);
});

test('deletion rechecks custody after persisting the fence', async (t) => {
  const f = await fixture(t);
  await f.store.remember(CHAT, 'owned', { kind: 'voice', requesterId: USER });
  let calls = 0;
  await assert.rejects(f.run('delete', { messageId: 'owned' }, { assertDirectAdapterHandoff: () => { if (++calls === 2) throw new Error('revoked'); } }), (error) => error.noRetry);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.store.get(CHAT, 'owned')).deletePending, true);
});

test('forwarding uses repeated native message ids on the first physical send only', async (t) => {
  const f = await fixture(t);
  const vkForward = { chatId: CHAT, messageIds: ['9007199254740993123', 'opaque-id'] };
  const ctx = { ...f.ctx, action: 'send', params: { target: 'destination@example.com', vkForward } };
  assert.equal(messageActions.prepareSendPayload({ ctx, to: ctx.params.target, payload: { text: 'comment' } }), null);
  const result = await f.run('send', { target: 'destination@example.com', message: 'x'.repeat(5000), vkForward });
  assert.equal(result.details.messageIds.length, 2);
  assert.deepEqual(f.requests[0].url.searchParams.getAll('forwardMsgId'), vkForward.messageIds);
  assert.equal(f.requests[0].url.searchParams.get('forwardChatId'), CHAT);
  assert.equal(f.requests[1].url.searchParams.has('forwardMsgId'), false);
  assert.equal((await f.store.get('destination@example.com', result.details.messageIds[0])).kind, 'forward');
  await assert.rejects(editMessage('destination@example.com', result.details.messageIds[0], { text: 'No' }, { ...f }), /tracked bot text/);
});

test('native forwarding rejects untrusted source, replayable payload, reply and malformed data before I/O', async (t) => {
  const f = await fixture(t), forward = { chatId: CHAT, messageIds: ['1'] };
  await assert.rejects(f.run('send', { vkForward: { ...forward, chatId: 'another@chat.agent' } }), /trusted source/);
  await assert.rejects(f.run('send', { vkForward: forward }, { requesterAccountId: 'other' }), /trusted source/);
  await assert.rejects(f.run('send', { vkForward: forward, replyTo: '2' }), /mutually exclusive/);
  await assert.rejects(sendPayload(CHAT, { channelData: { [CHANNEL]: { forward } } }, { ...f }), /authorized message-tool/);
  for (const value of [{ ...forward, messageIds: [] }, { ...forward, messageIds: ['1', '1'] }, { ...forward, messageIds: [1] }, { ...forward, extra: true }]) {
    assert.throws(() => channelData({ channelData: { [CHANNEL]: { forward: value } } }));
  }
  assert.equal(f.requests.length, 0);
  const result = await f.run('send', { vkForward: forward });
  assert.equal(result.details.messageIds.length, 1);
  assert.equal(f.requests[0].url.searchParams.get('text'), '');
});

test('forwarded file multipart keeps references and token in query, never in the body', async (t) => {
  const f = await fixture(t), api = new TeamsApi(f.account);
  await api.sendFile(CHAT, { buffer: Buffer.from('safe'), contentType: 'text/plain', fileName: 'test.txt' },
    { forwardChatId: 'source@chat.agent', forwardMessageIds: ['a', 'b'] });
  assert.equal(f.requests[0].method, 'POST');
  assert.deepEqual(f.requests[0].url.searchParams.getAll('forwardMsgId'), ['a', 'b']);
  assert.match(f.requests[0].body, /name="file"/);
  assert.doesNotMatch(f.requests[0].body, /name="token"|name="forwardChatId"/);
  assert.throws(() => api.deleteMessages(CHAT, ['same', 'same']), /Duplicate/);
});

test('chat metadata and member views return only useful whitelisted fields and cursor', async (t) => {
  const f = await fixture(t, (req, res) => {
    if (req.url.pathname.endsWith('/getInfo')) res.end(JSON.stringify({ type: 'group', title: 'Team', inviteLink: 'secret-link', photo: [{ url: 'signed' }], extra: 'secret' }));
    if (req.url.pathname.endsWith('/getMembers')) res.end(JSON.stringify({ members: [{ userId: USER, admin: 'false', creator: true, url: 'signed', token: 'secret' }], cursor: 'next+opaque=' }));
    if (req.url.pathname.endsWith('/subscribers/get')) res.end(JSON.stringify({ subscribers: [{ sn: USER, userState: { lastseen: 123 }, token: 'secret' }] }));
  });
  assert.deepEqual((await f.run('channel-info')).details, { channel: CHANNEL, chatId: CHAT, type: 'group', title: 'Team' });
  assert.deepEqual((await f.run('channel-info', { vkInfo: 'members' })).details.members, [{ userId: USER, creator: true }]);
  assert.equal((await f.run('channel-info', { vkInfo: 'members', vkCursor: 'next+opaque=' })).details.cursor, 'next+opaque=');
  assert.equal(f.requests.at(-1).url.searchParams.get('cursor'), 'next+opaque=');
  assert.equal((await f.run('channel-info', { vkInfo: 'admins' })).details.admins[0].admin, true);
  assert.deepEqual((await f.run('channel-info', { vkInfo: 'thread-subscribers' })).details.subscribers, [{ userId: USER }]);
  assert.equal(f.requests.at(-1).url.searchParams.get('pageSize'), '100');
  await f.run('channel-info', { vkInfo: 'thread-subscribers', vkCursor: 'next' });
  assert.equal(f.requests.at(-1).url.searchParams.has('pageSize'), false);
});

test('member lookup follows opaque pagination and reports bounded incomplete searches honestly', async (t) => {
  let mode = 'found';
  const f = await fixture(t, (req, res) => {
    if (!req.url.pathname.endsWith('/getMembers')) return;
    const cursor = req.url.searchParams.get('cursor');
    res.end(JSON.stringify(mode === 'found' ? cursor ? { members: [{ userId: USER, admin: true }] } : { members: [], cursor: 'p+2' }
      : mode === 'loop' ? { members: [], cursor: 'same' }
      : mode === 'empty' ? { members: [] } : { members: [], cursor: String(Number(cursor || 0) + 1) }));
  });
  assert.equal((await f.run('member-info', { userId: USER })).details.member.admin, true);
  assert.equal(f.requests[1].url.searchParams.get('cursor'), 'p+2');
  mode = 'loop';
  await assert.rejects(f.run('member-info', { userId: USER }), /did not advance/);
  mode = 'empty';
  assert.deepEqual((await f.run('member-info', { userId: USER })).details, { channel: CHANNEL, chatId: CHAT, member: null, complete: true });
  mode = 'long';
  const before = f.requests.length;
  const bounded = (await f.run('member-info', { userId: USER })).details;
  assert.equal(bounded.complete, false); assert.equal(bounded.cursor, '20');
  assert.equal(f.requests.length - before, 20);
});

for (const [action, params, method, key, value] of [
  ['pin', { messageId: 'm' }, 'pinMessage', 'msgId', 'm'],
  ['unpin', { messageId: 'm' }, 'unpinMessage', 'msgId', 'm'],
  ['channel-edit', { vkChatUpdate: { title: 'New title' } }, 'setTitle', 'title', 'New title'],
  ['channel-edit', { vkChatUpdate: { about: '' } }, 'setAbout', 'about', ''],
  ['channel-edit', { vkChatUpdate: { rules: 'Rule\nTwo' } }, 'setRules', 'rules', 'Rule\nTwo'],
  ['channel-edit', { vkChatUpdate: { threadAutoSubscribe: true, includeExistingThreads: true } }, 'autosubscribe', 'withExisting', 'true'],
]) test(`owner-only ${method} uses a confirmed, single-field native operation`, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(action, params, { senderIsOwner: true })).details.ok, true);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].url.pathname.endsWith('/chats/getInfo'), true);
  assert.equal(f.requests[1].url.pathname.endsWith(`/${method}`), true);
  assert.equal(f.requests[1].url.searchParams.get(key), value);
});

test('native thread creation uses current message or owned receipt and returns actual thread id', async (t) => {
  const f = await fixture(t);
  const result = await f.run('thread-create', { messageId: 'inbound-1' });
  assert.equal(result.details.threadId, 'thread@chat.agent');
  assert.equal(f.requests.at(-1).url.pathname, '/bot/v1/threads/add');
  await assert.rejects(f.run('thread-create', { messageId: 'untracked' }), /current inbound/);
  await f.store.remember(CHAT, 'owned', { kind: 'file', requesterId: USER });
  assert.equal((await f.run('thread-create', { messageId: 'owned' })).details.threadId, 'thread@chat.agent');
  await f.store.remember(CHAT, 'other', { kind: 'text', requesterId: 'other@example.com' });
  await assert.rejects(f.run('thread-create', { messageId: 'other' }), /another sender/);
  const count = f.requests.length;
  await assert.rejects(f.run('send', { target: CHAT, threadId: 'thread@chat.agent', message: 'No root leak' }), /native thread id/);
  assert.throws(() => messageActions.prepareSendPayload({ ctx: { ...f.ctx, params: {} }, to: CHAT, threadId: 'thread@chat.agent', payload: { text: 'No' } }), /native thread id/);
  assert.equal(f.requests.length, count);
  await f.run('send', { target: 'thread@chat.agent', threadId: 'thread@chat.agent', message: 'Thread reply' });
  assert.equal(f.requests.at(-1).url.searchParams.get('chatId'), 'thread@chat.agent');
});

test('private chat or revoked host custody cannot reach administrative mutation', async (t) => {
  const f = await fixture(t, (req, res) => {
    if (req.url.pathname.endsWith('/getInfo')) res.end(JSON.stringify({ type: 'private' }));
  });
  await assert.rejects(f.run('pin', { messageId: 'm' }, { senderIsOwner: true }), /group or channel/);
  assert.equal(f.requests.length, 1);
  const g = await fixture(t); let custodyChecks = 0;
  await assert.rejects(g.run('pin', { messageId: 'm' }, { senderIsOwner: true,
    assertDirectAdapterHandoff: () => { if (++custodyChecks === 2) throw new Error('revoked'); } }), /revoked/);
  assert.equal(g.requests.length, 1);
});

test('new endpoints reject malformed results and suppress raw provider errors, without automatic retries', async (t) => {
  let result = {};
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify(result)));
  const api = new TeamsApi(f.account);
  for (const run of [() => api.getChatInfo(CHAT), () => api.getChatMembers(CHAT), () => api.getChatAdmins(CHAT),
    () => api.getThreadSubscribers(CHAT), () => api.addThread(CHAT, 'm'), () => api.pinMessage(CHAT, 'm')]) await assert.rejects(run(), ApiError);
  result = { members: [{ userId: 123 }] };
  await assert.rejects(api.getChatMembers(CHAT), /invalid/);
  result = { members: [], cursor: { secret: 'bad' } };
  await assert.rejects(api.getChatMembers(CHAT), /invalid/);
  result = { ok: false, description: `https://secret/?token=${f.account.token}` };
  const count = f.requests.length;
  await assert.rejects(api.pinMessage(CHAT, 'm'), (error) => error instanceof ApiError && !error.message.includes(f.account.token) && !error.cause);
  assert.equal(f.requests.length, count + 1);
});


test('channelId alias uses the same trusted target authorization as target', async (t) => {
  const f = await fixture(t);
  const result = await messageActions.handleAction({ ...f.ctx, action: 'channel-info', params: { channelId: CHAT } });
  assert.equal(result.details.chatId, CHAT);
  await assert.rejects(messageActions.handleAction({ ...f.ctx, action: 'channel-info', params: { channelId: 'other@chat.agent' } }), /trusted current conversation/);
  assert.equal(f.requests.length, 1);
});
