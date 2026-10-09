import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInbound } from '../src/inbound.js';
import { TeamsApi } from '../src/api.js';
import { sendPayload } from '../src/send.js';
import { resolveAccount } from '../src/config.js';
import { config, event, httpServer, installRuntime } from './helpers.js';

const chat = { chatId: 'group@chat.agent', type: 'group' };
const transcript = 'OpenClaw, quote $& literally';

async function fixture(t, echoTranscript = true, heard = transcript) {
  const state = { failEcho: false };
  let server;
  server = await httpServer(t, (req, res) => {
    if (req.url.pathname.endsWith('/files/getInfo')) return res.end(JSON.stringify({
      ok: true, url: `${server.origin}/voice.ogg`, filename: 'voice.ogg' }));
    if (req.url.pathname === '/voice.ogg') { res.setHeader('Content-Type', 'audio/ogg'); return res.end('OggSvoice'); }
    if (state.failEcho && req.url.pathname.endsWith('/messages/sendText')) { res.statusCode = 500; return res.end('{}'); }
    res.end(JSON.stringify({ ok: true, msgId: `reply-${server.requests.length}` }));
  });
  const cfg = config({ baseUrl: server.origin, allowInsecureHttp: true,
    groupAllowFrom: ['user@example.com'], groups: { [chat.chatId]: { requireMention: true } } });
  cfg.tools = { media: { audio: { echoTranscript, echoFormat: 'Heard: {transcript}' } } };
  const runtime = installRuntime({ cfg, payloads: [], mentionPatterns: [/openclaw/i], audioTranscript: heard });
  const account = resolveAccount(cfg), api = new TeamsApi(account);
  // Match the pinned helper's uncancellable echo contract, using real local HTTP.
  runtime.sdk.audioPreflight.send = async () => {
    try {
      if (echoTranscript) await sendPayload(chat.chatId, { text: `Heard: ${heard}` },
        { cfg, account, api, core: runtime.core });
    } catch { /* The host treats echo delivery as best effort. */ }
  };
  runtime.sdk.audioPreflight.format = (text, format) => format.replace('{transcript}', () => text);
  return { ...runtime, cfg, account, api, server, state,
    run: (signal) => handleInbound({ event: event(1, { chat, text: '',
      parts: [{ type: 'voice', payload: { fileId: 'voice' } }] }),
    self: { userId: 'bot@example.com' }, cfg, account, api, signal }) };
}

test('shutdown during session recording cannot publish a preflight transcript or start dispatch', async (t) => {
  const f = await fixture(t), controller = new AbortController();
  f.core.channel.session.recordInboundSession = async () => { controller.abort(); };
  await assert.rejects(f.run(controller.signal), { name: 'AbortError' });
  assert.equal(f.server.requests.filter((request) => request.url.pathname.endsWith('/messages/sendText')).length, 0);
  assert.equal(f.seen.dispatches, 0);
});

test('shutdown after the first transcript chunk prevents remaining physical sends and dispatch', async (t) => {
  const f = await fixture(t, true, `OpenClaw ${'a'.repeat(9000)}`), controller = new AbortController();
  const sendText = f.api.sendText.bind(f.api);
  f.api.sendText = async (...args) => {
    const result = await sendText(...args);
    controller.abort();
    return result;
  };
  await assert.rejects(f.run(controller.signal), { name: 'AbortError' });
  assert.equal(f.server.requests.filter((request) => request.url.pathname.endsWith('/messages/sendText')).length, 1);
  assert.equal(f.seen.dispatches, 0);
});

test('a failed transcript echo is best effort and is not retried before agent dispatch', async (t) => {
  const f = await fixture(t);
  f.state.failEcho = true;
  await f.run();
  assert.equal(f.server.requests.filter((request) => request.url.pathname.endsWith('/messages/sendText')).length, 1);
  assert.equal(f.seen.dispatches, 1);
});

for (const echo of [true, false]) {
  test(`authorized voice preflight preserves the configured echo (${echo}) without another transcription`, async (t) => {
    const f = await fixture(t, echo);
    await f.run();
    const sent = f.server.requests.filter((request) => request.url.pathname.endsWith('/messages/sendText'));
    assert.equal(sent.length, echo ? 1 : 0);
    if (echo) {
      assert.equal(sent[0].url.searchParams.get('chatId'), chat.chatId);
      assert.equal(sent[0].url.searchParams.get('text'), `Heard: ${transcript.replace('&', '&amp;')}`);
    }
    assert.equal(f.seen.preflights.length, 1); assert.equal(f.seen.dispatches, 1);
    assert.equal(f.seen.contexts[0].media[0].transcribed, true);
  });
}
