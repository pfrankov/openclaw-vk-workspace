import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAccount } from '../src/config.js';
import { prepareKeyboard } from '../src/keyboard.js';
import { MessageStore } from '../src/message-store.js';
import { editMessage } from '../src/send.js';
import { config, httpServer, tempDir } from './helpers.js';

const USER = 'user@example.com', MESSAGE = 'owned-message';
async function fixture(t) {
  const dir = await tempDir(t);
  const store = new MessageStore(join(dir, 'messages.json'));
  const state = { failWrites: false, onEdit: undefined };
  const server = await httpServer(t, async (request, response) => {
    if (request.url.pathname.endsWith('/messages/editText')) await state.onEdit?.();
    response.end(JSON.stringify({ ok: true }));
  });
  const cfg = config({ baseUrl: server.origin, allowInsecureHttp: true });
  const menu = prepareKeyboard([[{ text: 'Continue', callbackData: 'old-choice' }]], USER);
  await store.remember(USER, MESSAGE, { kind: 'text', text: 'Original', requesterId: USER, ...menu });
  // Fail the actual atomic writer after the selected boundary, without changing
  // the transport or adding an injectable filesystem to the production store.
  const handle = await open(join(dir, 'write-probe'), 'w');
  const prototype = Object.getPrototypeOf(handle), writeFile = prototype.writeFile;
  await handle.close();
  t.mock.method(prototype, 'writeFile', function (...args) {
    if (state.failWrites) throw Object.assign(new Error('ENOSPC: private-state-path'), { code: 'ENOSPC' });
    return writeFile.apply(this, args);
  });
  const options = { cfg, account: resolveAccount(cfg), core: {}, messageStore: store, requesterSenderId: USER };
  return { ...server, store, state, menu, options,
    receipt: async () => JSON.parse(await readFile(store.path, 'utf8')).messages[JSON.stringify([USER, MESSAGE])],
    edit: (payload, extra) => editMessage(USER, MESSAGE, payload, { ...options, ...extra }) };
}

test('a failed durable edit fence prevents HTTP and preserves the previous menu', async (t) => {
  const f = await fixture(t), before = await f.receipt();
  try {
    await assert.rejects(f.edit({ text: 'Changed' }, {
      onPlatformSendDispatch: async () => { f.state.failWrites = true; },
    }));
  } finally { f.state.failWrites = false; }
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.receipt(), before);
  assert.equal(await f.store.lookup(USER, MESSAGE, f.menu.callbacks[0].token, USER), 'old-choice');
});

test('a failed commit after confirmed HTTP cannot restore callbacks or expose retryable filesystem errors', async (t) => {
  const f = await fixture(t);
  f.state.onEdit = () => { f.state.failWrites = true; };
  let failure;
  try { await f.edit({ text: 'Changed', channelData: { 'vk-workspace': { buttons: [] } } }); }
  catch (error) { failure = error; }
  finally { f.state.failWrites = false; }
  assert.equal(f.requests.length, 1);
  assert(failure, 'the unpersisted edit must not report success');
  assert.equal(failure.noRetry, true);
  assert.equal(failure.mayHaveSent, true);
  assert.equal(failure.cause, undefined);
  assert.doesNotMatch(failure.message, /ENOSPC|private-state-path/);
  const restarted = new MessageStore(f.store.path);
  assert.equal(await restarted.lookup(USER, MESSAGE, f.menu.callbacks[0].token, USER), null);
  assert.deepEqual((await restarted.get(USER, MESSAGE)).callbacks, []);
});

test('successful edits persist the fence before HTTP and retain intended menus and receipt ownership', async (t) => {
  const f = await fixture(t), before = await f.receipt();
  let during;
  f.state.onEdit = async () => { during = await f.receipt(); };
  await f.edit({ text: 'Changed' });
  assert.deepEqual(during.callbacks, []);
  assert.deepEqual(during.keyboard, []);
  assert.equal(during.requesterId, USER);
  assert.notEqual(during.revision, before.revision);
  assert.deepEqual(JSON.parse(f.requests[0].url.searchParams.get('inlineKeyboardMarkup')), f.menu.keyboard);
  assert.equal(await f.store.lookup(USER, MESSAGE, f.menu.callbacks[0].token, USER), 'old-choice');
  await f.edit({ text: 'Choose again', channelData: { 'vk-workspace': {
    buttons: [[{ text: 'New choice', callbackData: 'new-choice' }]],
  } } });
  const current = await f.receipt();
  assert.equal(current.text, 'Choose again');
  assert.equal(current.requesterId, USER);
  assert.equal(await f.store.lookup(USER, MESSAGE, f.menu.callbacks[0].token, USER), null);
  assert.equal(await f.store.lookup(USER, MESSAGE, current.callbacks[0].token, USER), 'new-choice');
  assert.equal(await f.store.lookup(USER, MESSAGE, current.callbacks[0].token, 'other@example.com'), null);
});

test('validation, sender authorization and initial custody rejection leave the existing menu armed', async (t) => {
  const f = await fixture(t), before = await f.receipt();
  await assert.rejects(f.edit({ text: 'Changed' }, { requesterSenderId: 'other@example.com' }), /another sender/);
  await assert.rejects(f.edit({ text: 'x'.repeat(5000) }), /one non-empty/);
  await assert.rejects(f.edit({ text: 'Changed' }, {
    assertDirectAdapterHandoff: () => { throw new Error('custody lost'); },
  }), /custody lost/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.edit({ text: 'Changed' }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.receipt(), before);
});

test('custody is revalidated after the durable fence and before HTTP', async (t) => {
  const f = await fixture(t);
  let checks = 0;
  await assert.rejects(f.edit({ text: 'Changed' }, {
    assertDirectAdapterHandoff: () => { if (++checks === 2) throw new Error('custody lost'); },
  }), /custody lost/);
  assert.equal(checks, 2);
  assert.equal(f.requests.length, 0);
  assert.equal(await f.store.lookup(USER, MESSAGE, f.menu.callbacks[0].token, USER), null);
});

test('cancellation after the durable fence prevents HTTP without restoring old callbacks', async (t) => {
  const f = await fixture(t), controller = new AbortController();
  let checks = 0;
  await assert.rejects(f.edit({ text: 'Changed' }, {
    signal: controller.signal,
    onPlatformSendDispatch: async () => { if (++checks === 2) controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(checks, 2);
  assert.equal(f.requests.length, 0);
  assert.equal(await f.store.lookup(USER, MESSAGE, f.menu.callbacks[0].token, USER), null);
});
