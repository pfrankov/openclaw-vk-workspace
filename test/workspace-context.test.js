import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supplementalContext } from '../src/context.js';
import { parseMessage, handleInbound, checkAccess } from '../src/inbound.js';
import { resolveAccount } from '../src/config.js';
import { TeamsApi } from '../src/api.js';
import { getMessageStore } from '../src/message-store.js';
import { prepareKeyboard } from '../src/keyboard.js';
import { httpServer, installRuntime, config, event } from './helpers.js';

const ID = 'vk-workspace', USER = 'user@example.com', BOT = { userId: 'bot@example.com' };
const GROUP = 'group@chat.agent', THREAD = 'thread@chat.agent';
const shared = (text = '/model evil @[bot@example.com]', userId = 'stranger@example.com', type = 'forward', parts = []) =>
  ({ type, payload: { message: { msgId: '90071992547409931234', from: { userId }, text, parts } } });
const attachment = (type, fileId) => ({ type, payload: { fileId } });
function fixture(settings = {}, options = {}) {
  const cfg = config({ dmPolicy: 'allowlist', allowFrom: [USER], groupPolicy: 'allowlist', groupAllowFrom: [USER],
    groups: { [GROUP]: { requireMention: false } }, ...settings });
  const runtime = installRuntime({ cfg, payloads: [], ...options });
  const calls = [];
  const api = { sendTyping: async () => {}, getFileInfo: async () => { throw new Error('Unexpected media I/O'); },
    sendText: async (chatId, text, params) => { calls.push({ chatId, text, params }); return { chatId, messageId: `reply-${calls.length}` }; },
    answerCallbackQuery: async (_query, text) => { calls.push({ answer: text }); } };
  return { ...runtime, cfg, account: resolveAccount(cfg), api, calls };
}
const receive = (f, message) => handleInbound({ ...f, event: message, self: BOT });
const groupEvent = (payload = {}) => event(1, { chat: { chatId: GROUP, type: 'group' }, ...payload });
const threadEvent = (payload = {}) => event(1, { chat: { chatId: THREAD, type: 'group' },
  parent_topic: { chatId: GROUP, messageId: 'parent-message', type: 'group' }, ...payload });

test('forward and quote text reach the agent, never the command or mention inputs', async () => {
  const f = fixture({ dmPolicy: 'open', allowFrom: [] });
  const checks = [];
  f.core.channel.text.hasControlCommand = (text) => { checks.push(text); return text.startsWith('/'); };
  const parsed = parseMessage(event(1, { text: 'Explain this', parts: [shared()] }), BOT);
  assert.equal(parsed.text, 'Explain this'); assert.equal(parsed.wasMentioned, false);
  await receive(f, event(1, { text: 'Explain this', parts: [shared(), shared('Quoted answer', BOT.userId, 'reply')] }));
  const ctx = f.seen.contexts[0];
  assert.equal(ctx.CommandBody, 'Explain this'); assert.equal(ctx.RawBody, 'Explain this');
  assert.deepEqual(checks, ['Explain this']);
  assert.match(ctx.BodyForAgent, /\/model evil/); assert.match(ctx.BodyForAgent, /untrusted context/);
  assert.equal(ctx.ReplyToId, '90071992547409931234'); assert.equal(ctx.ReplyToSender, 'bot (you)');
});

test('quote-only input is useful context but cannot become a command or mention', async () => {
  const f = fixture();
  await receive(f, event(1, { text: '', parts: [shared('/reset', USER, 'reply')] }));
  assert.equal(f.seen.dispatches, 1);
  assert.equal(f.seen.contexts[0].CommandBody, '[Shared context]');
  assert.match(f.seen.contexts[0].BodyForAgent, /\/reset/);
  const gated = fixture({ groups: { [GROUP]: { requireMention: true } } });
  await receive(gated, groupEvent({ text: '', parts: [shared('Hey assistant @[bot@example.com]')] }));
  assert.equal(gated.seen.dispatches, 0); assert.equal(gated.seen.saved.length, 0);
});

for (const [visibility, forwardVisible, quoteVisible] of [['all', true, true], ['allowlist', false, false], ['allowlist_quote', false, true]]) {
  test(`contextVisibility=${visibility} filters text and native reply metadata consistently`, async () => {
    const f = fixture({ contextVisibility: visibility });
    await receive(f, groupEvent({ parts: [shared('FORWARD-SECRET'), shared('QUOTE-SECRET', 'stranger@example.com', 'reply')] }));
    const ctx = f.seen.contexts[0];
    assert.equal(ctx.BodyForAgent.includes('FORWARD-SECRET'), forwardVisible);
    assert.equal(ctx.BodyForAgent.includes('QUOTE-SECRET'), quoteVisible);
    assert.equal(Boolean(ctx.ReplyToBody), quoteVisible);
    assert.equal(ctx.CommandBody, 'Привет');
  });
}

test('context visibility honors group then account then channel defaults, and does not filter DMs', async () => {
  const f = fixture(); f.cfg.channels.defaults = { contextVisibility: 'allowlist' };
  await receive(f, groupEvent({ parts: [shared('hidden')] }));
  assert.doesNotMatch(f.seen.contexts[0].BodyForAgent, /hidden/);
  f.account.config.contextVisibility = 'all';
  await receive(f, groupEvent({ parts: [shared('visible-account')] }));
  assert.match(f.seen.contexts.at(-1).BodyForAgent, /visible-account/);
  f.account.config.groups[GROUP].contextVisibility = 'allowlist';
  await receive(f, groupEvent({ parts: [shared('hidden-group')] }));
  assert.doesNotMatch(f.seen.contexts.at(-1).BodyForAgent, /hidden-group/);
  await receive(f, event(4, { parts: [shared('visible-dm')] }));
  assert.match(f.seen.contexts.at(-1).BodyForAgent, /visible-dm/);
});

test('hidden ancestors hide descendants, images and nested reply metadata', () => {
  const nested = shared('parent-hidden', 'stranger@example.com', 'forward', [shared('child-allowed', USER, 'reply', [attachment('file', 'image')])]);
  const result = supplementalContext([nested], { selfId: BOT.userId, isGroup: true, visibility: 'allowlist', allowFrom: [USER] });
  assert.equal(result.text, ''); assert.deepEqual(result.images, []); assert.equal(result.reply, undefined);
  const visible = supplementalContext([nested], { isGroup: false });
  assert.match(visible.text, /child-allowed/); assert.equal(visible.reply, undefined);
  assert.equal(visible.images.length, 1);
});

test('bot quotes and allowed authors stay visible without granting third-party audio authority', () => {
  const value = supplementalContext([shared('known', USER), shared('own answer', BOT.userId, 'reply',
    [attachment('voice', 'do-not-transcribe'), attachment('file', 'maybe-image')])],
  { selfId: BOT.userId, isGroup: true, visibility: 'allowlist', allowFrom: [USER] });
  assert.match(value.text, /known/); assert.match(value.text, /bot \(you\)/);
  assert.equal(value.images.length, 1); assert.equal(value.images[0].payload.fileId, 'maybe-image');
});

test('deep, cyclic and oversized supplemental context is bounded and Unicode-safe', () => {
  const cycle = shared('cycle'); cycle.payload.message.parts.push(cycle);
  const deep = shared('level1'); let last = deep;
  for (let i = 2; i <= 20; i++) { const next = shared(`level${i}`); last.payload.message.parts.push(next); last = next; }
  const result = supplementalContext([cycle, deep], { isGroup: false });
  assert.equal(result.text.match(/cycle/g).length, 1);
  assert.doesNotMatch(result.text, /level5/); assert.match(result.text, /truncated/);
  const huge = supplementalContext([shared('😀'.repeat(50000))]);
  assert.ok(huge.text.length <= 16000); assert.doesNotMatch(huge.text, /[\uD800-\uDBFF]\n/);
  const many = supplementalContext(Array.from({ length: 10000 }, (_, index) => shared(String(index))));
  assert.ok(many.text.length <= 16000); assert.match(many.text, /truncated/);
});

test('filtered-only context does not create a session or agent turn', async () => {
  const f = fixture({ contextVisibility: 'allowlist' });
  await receive(f, groupEvent({ text: '', parts: [shared('hidden')] }));
  assert.equal(f.seen.sessions.length, 0); assert.equal(f.seen.dispatches, 0);
});

test('foreign audio and mixed voice/shared input never trigger spoken-mention preflight', async () => {
  const f = fixture({ groups: { [GROUP]: { requireMention: true } } }, { mentionPatterns: [/assistant/], audioTranscript: 'assistant hello' });
  for (const parts of [[shared('', USER, 'forward', [attachment('voice', 'foreign')])],
    [attachment('voice', 'own'), shared('another context')]]) {
    await receive(f, groupEvent({ text: '', parts }));
  }
  assert.equal(f.seen.preflights.length, 0); assert.equal(f.seen.saved.length, 0); assert.equal(f.seen.sessions.length, 0);
});

test('shared image preview requires trusted metadata and matching bytes; voice never reaches STT', async (t) => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const server = await httpServer(t, (req, res) => {
    const id = req.url.searchParams.get('fileId');
    if (req.url.pathname.endsWith('/getInfo')) res.end(JSON.stringify({ type: id === 'document' ? 'document' : 'image', filename: 'picture.png', url: `${server.origin}/${id}` }));
    else { res.setHeader('Content-Type', 'application/octet-stream'); res.end(req.url.pathname === '/image' ? png : Buffer.from('RIFF0000WAVEfake audio')); }
  });
  const f = fixture({ baseUrl: server.origin, allowInsecureHttp: true });
  f.api = new TeamsApi(f.account);
  await receive(f, event(1, { text: 'Explain the picture', parts: [shared('caption', USER, 'forward',
    [attachment('file', 'image'), attachment('voice', 'voice'), attachment('file', 'mislabelled'), attachment('file', 'document')])] }));
  assert.equal(f.seen.saved.length, 1); assert.equal(f.seen.saved[0].contentType, 'image/png');
  assert.deepEqual(f.seen.saved[0].buffer, png);
  assert.equal(f.seen.contexts[0].media[0].kind, 'image');
  assert.equal(server.requests.some((req) => req.url.searchParams.get('fileId') === 'voice'), false);
  assert.equal(server.requests.some((req) => req.url.pathname === '/document'), false);
  assert.equal(f.seen.preflights.length, 0);
  assert.match(f.seen.contexts[0].BodyForAgent, /Some shared attachment previews are unavailable/);
});

test('untrusted shared image origin fails softly without losing the authorized text turn', async () => {
  const f = fixture(); let fetched = 0;
  f.api.getFileInfo = async () => ({ type: 'image', url: 'https://untrusted.invalid/private?secret=HIDDEN', filename: 'x.png' });
  f.core.channel.media.fetchRemoteMedia = async () => { fetched++; throw new Error('should not be reached'); };
  await receive(f, event(1, { parts: [shared('caption', USER, 'reply', [attachment('file', 'f')])] }));
  assert.equal(f.seen.dispatches, 1); assert.equal(f.seen.saved.length, 0); assert.equal(fetched, 0);
  assert.doesNotMatch(JSON.stringify(f.seen.contexts), /HIDDEN|untrusted.invalid/);
});

test('hidden and unauthorized context never reaches file metadata or media storage', async () => {
  const f = fixture({ contextVisibility: 'allowlist' });
  let metadata = 0; f.api.getFileInfo = async () => { metadata++; throw new Error('blocked'); };
  await receive(f, groupEvent({ parts: [shared('hidden', 'stranger', 'forward', [attachment('file', 'image')])] }));
  await receive(f, groupEvent({ from: { userId: 'unauthorized' }, parts: [shared('hidden', USER, 'forward', [attachment('file', 'image')])] }));
  assert.equal(metadata, 0); assert.equal(f.seen.saved.length, 0); assert.equal(f.seen.dispatches, 1);
});

test('thread inherits parent access and binding, but has its own session and native delivery target', async () => {
  const f = fixture({}, { payloads: [{ text: 'Reply in thread' }] });
  await receive(f, threadEvent());
  assert.equal(f.seen.dispatches, 1);
  assert.deepEqual(f.seen.routes[0].parentPeer, { kind: 'group', id: GROUP });
  assert.equal(f.seen.contexts[0].MessageThreadId, THREAD);
  assert.equal(f.seen.contexts[0].NativeChannelId, THREAD);
  assert.equal(f.calls[0].chatId, THREAD);
  await receive(f, groupEvent());
  assert.notEqual(f.seen.contexts[0].SessionKey, f.seen.contexts[1].SessionKey);
  assert.equal(f.seen.contexts[1].MessageThreadId, undefined);
});

test('thread allowlist cannot authorize a denied parent or bypass a disabled parent', async () => {
  for (const groups of [{ [THREAD]: { allowFrom: [USER], requireMention: false } },
    { [GROUP]: { enabled: false }, [THREAD]: { allowFrom: [USER] } },
    { [GROUP]: { allowFrom: ['other'] }, [THREAD]: { allowFrom: [USER] } },
    { [GROUP]: { allowFrom: [USER] }, [THREAD]: { allowFrom: ['other'] } }]) {
    const f = fixture({ groups });
    await receive(f, threadEvent({ parts: [attachment('file', 'not-downloaded')] }));
    assert.equal(f.seen.routes.length, 0); assert.equal(f.seen.sessions.length, 0); assert.equal(f.seen.saved.length, 0);
  }
});

test('thread mention rules, disabled thread and effective author allowlist are respected', async () => {
  const f = fixture({ groups: { [GROUP]: { requireMention: true }, [THREAD]: { requireMention: false, allowFrom: [USER] } } });
  await receive(f, threadEvent()); assert.equal(f.seen.dispatches, 1);
  const parsed = parseMessage(threadEvent(), BOT);
  assert.deepEqual(checkAccess(parsed, f.account).allowFrom, [USER]);
  f.account.config.groups[THREAD].enabled = false;
  await receive(f, threadEvent()); assert.equal(f.seen.dispatches, 1);
  const gated = fixture({ groups: { [GROUP]: { requireMention: true } } });
  await receive(gated, threadEvent()); assert.equal(gated.seen.dispatches, 0);
  await receive(gated, threadEvent({ parts: [{ type: 'mention', payload: { userId: BOT.userId } }] }));
  assert.equal(gated.seen.dispatches, 1);
});

for (const parent of [null, {}, { chatId: GROUP }, { chatId: THREAD, messageId: 'm' },
  { chatId: GROUP, messageId: 9007199254740992 }, { chatId: 'bad id', messageId: 'm' }]) {
  test(`malformed thread parent is rejected: ${JSON.stringify(parent)}`, () => {
    assert.equal(parseMessage(threadEvent({ parent_topic: parent }), BOT), null);
  });
}

test('thread callback retains parent permissions and its native target; non-authorized parent cannot consume it', async () => {
  const f = fixture({}, { payloads: [{ text: 'Chosen' }] });
  const store = getMessageStore(f.core, f.account), keyboard = prepareKeyboard([[{ text: 'Choose', callbackData: 'chosen' }]], USER);
  await store.remember(THREAD, 'menu', { kind: 'text', text: 'Choose', requesterId: USER, ...keyboard });
  const callback = { type: 'callbackQuery', payload: { queryId: 'q1', from: { userId: USER }, callbackData: keyboard.callbacks[0].token,
    message: { msgId: 'menu', from: BOT, chat: { chatId: THREAD, type: 'group' }, parent_topic: { chatId: GROUP, messageId: 'parent' } } } };
  f.account.config.groups[GROUP].enabled = false;
  await receive(f, callback); assert.equal(f.seen.dispatches, 0);
  assert.equal(await store.lookup(THREAD, 'menu', keyboard.callbacks[0].token, USER), 'chosen');
  f.account.config.groups[GROUP].enabled = true;
  await receive(f, callback); assert.equal(f.seen.dispatches, 1);
  assert.equal(f.calls.at(-1).chatId, THREAD);
  assert.equal(f.calls.at(-1).params.replyToId, 'menu');
});


test('allowlist_quote admits only direct quotes and never treats a missing identity as the bot', () => {
  const nested = shared('allowed parent', USER, 'forward', [shared('nested secret', 'stranger', 'reply')]);
  const result = supplementalContext([nested, { type: 'reply', payload: { message: { text: 'unknown' } } }],
    { isGroup: true, visibility: 'allowlist', allowFrom: [USER] });
  assert.doesNotMatch(result.text, /unknown|nested secret|bot \(you\)/);
  const quotes = supplementalContext([nested, shared('direct quote', 'stranger', 'reply')],
    { isGroup: true, visibility: 'allowlist_quote', allowFrom: [USER] });
  assert.doesNotMatch(quotes.text, /nested secret/); assert.match(quotes.text, /direct quote/);
});
