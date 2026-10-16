import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Inbox } from '../src/inbox.js';
import { handleInbound } from '../src/inbound.js';
import { monitorAccount } from '../src/monitor.js';
import { account, config, event, installRuntime, tempDir } from './helpers.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a fatal inbox write cancels sibling dispatches and keeps the consumer lock until all settle', { timeout: 5000 }, async (t) => {
  const path = join(await tempDir(t), 'inbox.json'), inbox = new Inbox(path);
  const controller = new AbortController(), entered = [], sends = [], statuses = [], active = new Set();
  const allStarted = deferred(), cancelled = deferred(), releaseUncooperative = deferred();
  const cfg = config({ dmPolicy: 'open' }), a = account({ dmPolicy: 'open' });
  const { core, sdk } = installRuntime({ cfg });
  const started = (chatId) => { entered.push(chatId); if (entered.length === 4) allStarted.resolve(); };
  core.channel.reply.dispatchReplyWithBufferedBlockDispatcher = async ({ ctx, dispatcherOptions, replyOptions }) => {
    started(ctx.NativeChannelId);
    if (ctx.NativeChannelId === 'C') await releaseUncooperative.promise;
    else await new Promise((resolve) => replyOptions.abortSignal.addEventListener('abort', () => {
      cancelled.resolve(); resolve();
    }, { once: true }));
    // A cancelled host can still invoke a late delivery callback. The plugin must
    // reject it even when cancellation originated from another chat's storage failure.
    await dispatcherOptions.deliver({ text: 'late reply' });
  };
  let polls = 0;
  const api = {
    getSelf: async () => ({ userId: 'bot' }),
    getEvents: async () => {
      assert.equal(polls++, 0, 'A failed durable write must prevent another poll');
      return ['A', 'B', 'C', 'D', 'E'].map((chatId, index) => event(index + 1, { chat: { chatId, type: 'private' } }));
    },
    sendTyping: async () => {}, stopTyping: async () => {},
    sendText: async (chatId) => { sends.push(chatId); return { chatId, messageId: 'late' }; },
  };
  const run = monitorAccount({ account: a, cfg, abortSignal: controller.signal, setStatus: (value) => statuses.push(value) }, {
    core, sdk, inbox, api, handle: (params) => {
      const work = (async () => {
        if (params.event.eventId !== '1') return handleInbound(params);
        started('A'); await allStarted.promise;
        // Both the cursor and four started fences are durable. Force the next
        // real atomic rename to fail, keeping the original bytes recoverable.
        await rename(path, `${path}.preserved`); await mkdir(path);
      })();
      active.add(work); work.then(() => active.delete(work), () => active.delete(work));
      return work;
    },
  });
  let finished = false;
  const result = run.then(() => ({ error: undefined }), (error) => ({ error })).then((value) => { finished = true; return value; });
  t.after(async () => {
    controller.abort(); releaseUncooperative.resolve();
    await result; await Promise.allSettled([...active]); await inbox.close();
  });
  assert.equal(await Promise.race([cancelled.promise.then(() => 'cancelled'), result.then(() => 'stopped')]), 'cancelled');
  await setImmediate();
  assert.equal(finished, false, 'The monitor must await an in-flight handler that ignores cancellation');
  assert.equal(controller.signal.aborted, false, 'Local failure must not abort the host signal or hide the storage error');
  await stat(`${path}.lock`);
  await assert.rejects(new Inbox(path).open(), /locked/);
  assert.deepEqual(entered.sort(), ['A', 'B', 'C', 'D'], 'A fatal failure must stop scheduling new chats');
  assert(!statuses.some((value) => value.lifecycle === 'stopped'));
  // Remove only the injected failure while the original consumer still owns its lock.
  await rm(path, { recursive: true }); await rename(`${path}.preserved`, path);
  releaseUncooperative.resolve();
  assert.match((await result).error?.message ?? '', /monitor failed/);
  assert.equal(statuses.at(-1).lifecycle, 'stopped');
  assert.deepEqual(sends, []);
  await assert.rejects(stat(`${path}.lock`), { code: 'ENOENT' });
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(stored.pending.filter((item) => item.started).map((item) => item.event.eventId), ['1', '2', '3', '4']);
  const restarted = await new Inbox(path).open();
  try {
    assert.deepEqual(restarted.state.failed.map((item) => item.event.eventId), ['1', '2', '3', '4']);
    assert.deepEqual(restarted.state.pending.map((item) => item.event.eventId), ['5']);
  } finally { await restarted.close(); }
});

test('normal shutdown waits for an uncooperative turn and retains it for interrupted recovery', { timeout: 5000 }, async (t) => {
  const path = join(await tempDir(t), 'inbox.json'), inbox = new Inbox(path), controller = new AbortController();
  const entered = deferred(), release = deferred(), statuses = [];
  const { core, sdk } = installRuntime();
  let calls = 0, turnSignal;
  const run = monitorAccount({ account: account(), cfg: config(), abortSignal: controller.signal,
    setStatus: (value) => statuses.push(value) }, { core, sdk, inbox,
    api: { getSelf: async () => ({ userId: 'bot' }), getEvents: async () => {
      assert.equal(calls++, 0); return [event(1), event(2)];
    } },
    handle: async ({ signal }) => { turnSignal = signal; entered.resolve(); await release.promise; },
  });
  let finished = false;
  const result = run.then(() => { finished = true; });
  t.after(async () => { controller.abort(); release.resolve(); await result; await inbox.close(); });
  await entered.promise; controller.abort(); await setImmediate();
  assert.equal(turnSignal.aborted, true); assert.equal(finished, false);
  await assert.rejects(new Inbox(path).open(), /locked/);
  release.resolve(); await result;
  assert.equal(statuses.at(-1).lifecycle, 'stopped');
  const restarted = await new Inbox(path).open();
  try {
    assert.deepEqual(restarted.state.failed.map((item) => item.event.eventId), ['1']);
    assert.deepEqual(restarted.state.pending.map((item) => item.event.eventId), ['2']);
  } finally { await restarted.close(); }
});
