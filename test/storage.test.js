import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Inbox, inboxPath } from '../src/inbox.js';
import { drainInbox, monitorAccount } from '../src/monitor.js';
import { ApiError } from '../src/api.js';
import { ProcessingFailure } from '../src/processing-failure.js';
import { event, account, tempDir, config } from './helpers.js';

const statusSdk = {
  channelReadyPatch: (extras = {}) => ({ running: true, connected: true, lifecycle: 'ready', lastError: null, ...extras }),
  channelStoppedPatch: (extras = {}) => ({ running: false, connected: false, lifecycle: 'stopped', ...extras }),
  transportActivityPatch: (at) => ({ lastTransportActivityAt: at }),
};

async function makeInbox(t) {
  const inbox = await new Inbox(join(await tempDir(t), 'inbox.json')).open();
  t.after(() => inbox.close()); return inbox;
}
test('durable cursor advances with persisted pending events and survives restart', async (t) => {
  const inbox = await makeInbox(t);
  await inbox.ingest([event(3), event(1), event(2), event(2)]);
  assert.equal(inbox.state.cursor, '3'); assert.deepEqual(inbox.state.pending.map((x) => x.event.eventId), ['1', '2', '3']);
  await inbox.complete('1'); const path = inbox.path; await inbox.close();
  const restarted = await new Inbox(path).open(); t.after(() => restarted.close());
  await restarted.ingest([event(1), event(3), event(4)]);
  assert.deepEqual(restarted.state.pending.map((x) => x.event.eventId), ['2', '3', '4']);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
test('cursor and queue stay unchanged if any batch id is unsafe or invalid', async (t) => {
  const inbox = await makeInbox(t); await inbox.ingest([event(1)]);
  for (const id of [9007199254740992, 'NaN']) await assert.rejects(inbox.ingest([event(2), event(id)]));
  assert.equal(inbox.state.cursor, '1'); assert.equal(JSON.parse(await readFile(inbox.path, 'utf8')).cursor, '1');
});
test('arbitrary-precision cursor is sorted without floating point conversion', async (t) => {
  const inbox = await makeInbox(t); await inbox.ingest([event('9223372036854775807'), event('9223372036854775806')]);
  assert.equal(inbox.state.cursor, '9223372036854775807');
  assert.equal(inbox.state.pending[0].event.eventId, '9223372036854775806');
});
test('serialized updates cannot lose events under concurrent completion', async (t) => {
  const inbox = await makeInbox(t); await inbox.ingest(Array.from({ length: 50 }, (_, i) => event(i + 1)));
  await Promise.all(inbox.state.pending.map((item) => inbox.complete(item.event.eventId)));
  assert.equal(inbox.state.pending.length, 0); assert.equal(inbox.state.cursor, '50');
});
test('failed events are retained after three attempts and can explicitly be retried', async (t) => {
  const inbox = await makeInbox(t); await inbox.ingest([event(1)]);
  for (let n = 0; n < 3; n++) await inbox.fail('1');
  assert.equal(inbox.state.pending.length, 0); assert.equal(inbox.state.failed[0].attempts, 3);
  await inbox.retryFailed(); assert.equal(inbox.state.pending[0].attempts, 0); assert.equal(inbox.state.failed.length, 0);
});
test('queue cap refuses a new batch without acknowledging it', async (t) => {
  const inbox = await makeInbox(t);
  await assert.rejects(inbox.ingest(Array.from({ length: 1001 }, (_, i) => event(i + 1))), /full/);
  assert.equal(inbox.state.cursor, '0'); assert.equal(inbox.state.pending.length, 0);
});
test('only one local consumer can open a given bot inbox; closing a failed opener cannot release another lock', async (t) => {
  const first = await makeInbox(t); const second = new Inbox(first.path);
  await assert.rejects(second.open(), /locked/); await second.close();
  await assert.rejects(new Inbox(first.path).open(), /locked/);
  assert.equal(inboxPath('/state', account()), inboxPath('/state', { ...account(), accountId: 'alias' }));
  assert.notEqual(inboxPath('/state', account()), inboxPath('/state', { ...account(), token: 'another-token' }));
});
for (const content of ['', '{invalid', '{"version":1,"cursor":"0","pending":[{"event":{"eventId":"1"},"attempts":0}],"failed":[]}']) {
  test(`corrupt state fails closed rather than resetting cursor: ${content}`, async (t) => {
    const path = join(await tempDir(t), 'state.json'); await writeFile(path, content);
    await assert.rejects(new Inbox(path).open(), /corrupt/); assert.equal(await readFile(path, 'utf8'), content);
  });
}
test('drain runs chats concurrently, preserves FIFO within each and retains failed conversation', async (t) => {
  const inbox = await makeInbox(t); const group = (id) => ({ chatId: id, type: 'private' });
  await inbox.ingest([event(1, { chat: group('A') }), event(2, { chat: group('A') }), event(3, { chat: group('B') }), event(4, { chat: group('B') })]);
  const seen = [];
  await drainInbox({ inbox, handle: async (item) => { seen.push(item.eventId); if (item.eventId === '1') throw new Error('temporary'); } });
  assert(!seen.includes('2')); assert(seen.indexOf('3') < seen.indexOf('4'));
  assert.deepEqual(inbox.state.pending.map((x) => x.event.eventId), ['2']);
  assert.equal(inbox.state.failed[0].event.eventId, '1');
});
test('failed events retain only safe stage diagnostics and clear them before explicit retry', async (t) => {
  const inbox = await makeInbox(t); await inbox.ingest([event(58)]); let reported;
  await drainInbox({ inbox, handle: async () => { throw new ProcessingFailure('media-download', 'untrusted-origin',
    'Media download failed: origin https://files-n.lesta.group is not allowed; add it to mediaAllowedOrigins'); },
  onFailure: (id, failure) => { reported = { id, failure }; } });
  assert.deepEqual(reported, { id: '58', failure: { stage: 'media-download', code: 'untrusted-origin',
    message: 'Media download failed: origin https://files-n.lesta.group is not allowed; add it to mediaAllowedOrigins' } });
  assert.deepEqual(inbox.state.failed[0].failure, reported.failure);
  await inbox.retryFailed(); assert.equal(inbox.state.pending[0].failure, undefined);
});
test('abort does not mark an unfinished event as completed or failed', async (t) => {
  const inbox = await makeInbox(t); await inbox.ingest([event(1)]); const controller = new AbortController();
  await drainInbox({ inbox, signal: controller.signal, handle: async () => { controller.abort(); throw new Error('cancelled'); } });
  assert.equal(inbox.state.pending.length, 1); assert.equal(inbox.state.pending[0].attempts, 0);
});
test('monitor readiness follows the actual first poll; its events are delivered and cursor acknowledged only after persistence', async (t) => {
  const path = join(await tempDir(t), 'state.json'); const controller = new AbortController(); const statuses = []; const calls = []; let polls = 0;
  const api = { getSelf: async () => ({ userId: 'bot' }), getEvents: async (cursor, pollTime) => {
    calls.push({ cursor, pollTime });
    if (polls++ === 0) { assert(!statuses.some((x) => x.connected)); return [event(5)]; }
    assert.equal(cursor, '5'); assert.equal(JSON.parse(await readFile(path, 'utf8')).cursor, '5'); controller.abort(); return [];
  } };
  const delivered = [];
  await monitorAccount({ account: account(), cfg: config(), abortSignal: controller.signal, setStatus: (x) => statuses.push(x) },
    { core: {}, sdk: statusSdk, api, inbox: new Inbox(path), handle: async ({ event: item }) => delivered.push(item.eventId) });
  assert.deepEqual(delivered, ['5']); assert.equal(calls[0].pollTime, 1); assert.equal(calls[1].pollTime, 30);
  const ready = statuses.find((x) => x.lifecycle === 'ready');
  assert.equal(ready.connected, true); assert.equal(ready.lastTransportActivityAt, ready.lastEventAt);
  assert.equal(statuses.at(-1).running, false); assert.equal(statuses.at(-1).lifecycle, 'stopped');
});
test('monitor transient poll failure never reports connected and can be cancelled during backoff', async (t) => {
  const controller = new AbortController(); const statuses = []; const timer = setTimeout(() => controller.abort(), 30); t.after(() => clearTimeout(timer));
  await monitorAccount({ account: account(), cfg: config(), abortSignal: controller.signal, setStatus: (x) => statuses.push(x) },
    { core: {}, sdk: statusSdk, inbox: new Inbox(join(await tempDir(t), 'state.json')), api: { getSelf: async () => ({ userId: 'bot' }), getEvents: async () => { throw new ApiError('events/get', 'network request failed'); } } });
  assert(!statuses.some((x) => x.connected)); assert.equal(statuses.at(-1).running, false);
});
test('storage failure stops the monitor before any next poll acknowledges unpersisted events', async (t) => {
  const path = join(await tempDir(t), 'state.json'); let polls = 0;
  await assert.rejects(monitorAccount({ account: account(), cfg: config() }, { core: {}, sdk: statusSdk, inbox: new Inbox(path), api: {
    getSelf: async () => ({ userId: 'bot' }), getEvents: async () => { polls++; return [event('invalid-id')]; },
  } }), /monitor failed/);
  assert.equal(polls, 1);
});
