import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeamsApi, ApiError, eventId, readBounded } from '../src/api.js';
import { account, httpServer } from './helpers.js';

test('GET requests preserve prefixed URL, opaque ids, Unicode and token encoding', async (t) => {
  const server = await httpServer(t, (_, res) => res.end(JSON.stringify({ ok: true, msgId: '9223372036854775807' })));
  server.account.token = 'secret?&+кириллица';
  server.account.baseUrl = `${server.origin}/prefix/bot/v1`;
  const result = await new TeamsApi(server.account).sendText('person+tag@example.com', 'Привет & + \n😀', { replyToId: 'm:123' });
  assert.equal(result.messageId, '9223372036854775807');
  const req = server.requests[0];
  assert.equal(req.method, 'GET'); assert.equal(req.url.pathname, '/prefix/bot/v1/messages/sendText');
  assert.equal(req.url.searchParams.get('token'), server.account.token);
  assert.equal(req.url.searchParams.get('text'), 'Привет & + \n😀');
  assert.equal(req.url.searchParams.get('chatId'), 'person+tag@example.com');
  assert.equal(req.url.searchParams.get('replyMsgId'), 'm:123');
});
test('multipart POST keeps token/chat/caption in query and only file in body', async (t) => {
  const server = await httpServer(t, (_, res) => res.end('{"ok":true,"msgId":"m","fileId":"f"}'));
  await new TeamsApi(server.account).sendFile('123@chat.agent', { buffer: Buffer.from('binary-data'), fileName: 'report.txt', contentType: 'text/plain' }, { caption: 'Отчёт' });
  const req = server.requests[0];
  assert.equal(req.method, 'POST'); assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(req.body, /name="file"; filename="report.txt"/); assert.match(req.body, /binary-data/);
  assert.equal(req.url.searchParams.get('caption'), 'Отчёт');
  assert.equal(req.url.searchParams.get('token'), server.account.token);
  assert(!req.body.includes(server.account.token)); assert(!req.body.includes('name="chatId"'));
});
test('arrays repeat query keys; keyboard is a single JSON array; caller cannot replace token', async () => {
  let url;
  const api = new TeamsApi(account(), async (input) => { url = input; return Response.json({ ok: true }); });
  const keyboard = [[{ text: 'OK', callbackData: 'ok' }]];
  await api.request('messages/deleteMessages', { msgId: ['1', '2'], inlineKeyboardMarkup: keyboard, token: 'attacker' });
  assert.deepEqual(url.searchParams.getAll('msgId'), ['1', '2']);
  assert.deepEqual(JSON.parse(url.searchParams.get('inlineKeyboardMarkup')), keyboard);
  assert.notEqual(url.searchParams.get('token'), 'attacker');
});
for (const payload of [{ ok: false, description: 'secret URL token=test-token-DO-NOT-LOG' }, { description: 'Invalid token' }, [], null]) {
  test(`HTTP 200 logical failure is rejected without leaking details: ${JSON.stringify(payload)}`, async () => {
    const api = new TeamsApi(account(), async () => Response.json(payload));
    await assert.rejects(api.getSelf(), (error) => error instanceof ApiError && !JSON.stringify(error).includes('DO-NOT-LOG') && !error.message.includes('secret URL'));
  });
}
test('metadata without ok is accepted, but missing bot id and malformed events fail', async () => {
  const api = new TeamsApi(account(), async () => Response.json({ url: 'https://files.example/f' }));
  assert.equal((await api.getFileInfo('f')).url, 'https://files.example/f');
  await assert.rejects(api.getSelf(), /missing bot userId/);
  await assert.rejects(api.getEvents('0', 1), /missing events array/);
});
test('non-JSON, non-2xx and raw network errors remain sanitized', async () => {
  for (const response of [new Response('password=secret'), new Response('secret', { status: 429 })]) {
    await assert.rejects(new TeamsApi(account(), async () => response).getSelf(), ApiError);
  }
  await assert.rejects(new TeamsApi(account(), async () => { throw new Error('token=test-token-DO-NOT-LOG'); }).getSelf(), /network request failed/);
});
test('API redirects are never followed to a token-exfiltration endpoint', async (t) => {
  let received = 0;
  const target = await httpServer(t, (_, res) => { received++; res.end('{"ok":true}'); });
  const origin = await httpServer(t, (_, res) => { res.statusCode = 302; res.setHeader('Location', `${target.origin}/steal`); res.end(); });
  await assert.rejects(new TeamsApi(origin.account).getSelf(), /HTTP 302/);
  assert.equal(received, 0);
});
test('abort cancels an in-flight HTTP request and caller gets AbortError', async (t) => {
  const server = await httpServer(t, () => {});
  const controller = new AbortController();
  const promise = new TeamsApi(server.account).getSelf({ signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 30); t.after(() => clearTimeout(timer));
  await assert.rejects(promise, { name: 'AbortError' });
});
test('request timeout also applies while reading the response body', async (t) => {
  const server = await httpServer(t, (_, res) => { res.write('{"ok":'); });
  await assert.rejects(new TeamsApi(server.account).getSelf({ timeoutMs: 30 }), /request timed out/);
});
test('response limits cover advertised and streaming sizes', async () => {
  await assert.rejects(readBounded(new Response('large', { headers: { 'Content-Length': '100' } }), 4), /size limit/);
  await assert.rejects(readBounded(new Response('12345'), 4), /size limit/);
});
test('cursor ids retain arbitrary precision and reject unsafe JSON numbers', () => {
  assert.equal(eventId('9223372036854775807'), '9223372036854775807');
  assert.equal(eventId('0001'), '1');
  for (const invalid of [-1, 1.5, 9007199254740992, '1e3', undefined, null, '']) assert.throws(() => eventId(invalid));
});
