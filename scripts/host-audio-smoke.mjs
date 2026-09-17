import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, event, installRuntime } from '../test/helpers.js';

// A local transport/SDK contract test, not a live corporate service or ASR-quality test.
export async function checkHostAudio(base, dir) {
  const { transcribeAudioFile, createChannelPreflightAudio } = await import('openclaw/plugin-sdk/media-understanding-runtime');
  const load = (name) => import(pathToFileURL(join(base, 'dist', `${name}.js`)));
  const [{ inboundMedia }, { TeamsApi }, { resolveAccount }, { Inbox }, { drainInbox },
    { handleInbound }, { setRuntime }, { sdkHelpers }] = await Promise.all(
    ['media', 'api', 'config', 'inbox', 'monitor', 'inbound', 'runtime', 'index'].map(load));
  const audio = await readFile(new URL('../test/fixtures/voice.aac', import.meta.url));
  const requests = [], downloads = [], serverErrors = [];
  let rejectTranscription = false;
  const start = async (handler) => {
    const server = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((error) => { serverErrors.push(error); res.statusCode = 500; res.end('{}'); });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
  };
  const stop = async (server) => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };
  const origin = (server) => `http://127.0.0.1:${server.address().port}`;
  const cdn = await start((req, res) => {
    downloads.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/octet-stream'); res.end(audio);
  });
  let server;
  try {
    server = await start(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/bot/v1/files/getInfo') {
        assert.equal(url.searchParams.get('fileId'), 'voice');
        res.end(JSON.stringify({ ok: true, url: `${origin(cdn)}/opaque?signature=TEST-SIGNED-URL`, filename: 'voice.aac' }));
      } else if (url.pathname === '/v1/audio/transcriptions') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const file = form.get('file');
        requests.push({ method: req.method, authorization: req.headers.authorization, model: form.get('model'),
          name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
        res.statusCode = rejectTranscription ? 400 : 200;
        res.end(JSON.stringify(rejectTranscription ? { error: { message: 'Test transcription rejected' } } : { text: 'OpenClaw, hello' }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
    const cfg = { ...config({ baseUrl: origin(server), allowInsecureHttp: true, mediaAllowedOrigins: [origin(cdn)],
      groupPolicy: 'allowlist', groupAllowFrom: ['user@example.com'], groups: { 'group@chat.agent': {} } }),
      plugins: { allow: ['openai'], entries: { openai: { enabled: true } } },
      models: { providers: { openai: { baseUrl: `${origin(server)}/v1`, api: 'openai-completions', auth: 'api-key',
        apiKey: 'TEST-STT-KEY', request: { allowPrivateNetwork: true }, models: [] } } },
      tools: { media: { models: [{ type: 'provider', provider: 'openai', model: 'test-stt', capabilities: ['audio'],
        baseUrl: `${origin(server)}/v1` }], audio: { enabled: true, preferredModel: 'openai/test-stt', timeoutSeconds: 5 } } },
    };
    const account = resolveAccount(cfg), api = new TeamsApi(account);
    const { core, seen } = installRuntime({ cfg, payloads: [], mentionPatterns: [/openclaw/i] });
    const mediaDir = join(dir, 'audio-media'), agentDir = join(dir, 'audio-agent');
    await mkdir(mediaDir, { recursive: true }); await mkdir(agentDir, { recursive: true });
    core.channel.media.saveMediaBuffer = async (buffer, contentType, _direction, _limit, fileName) => {
      const path = join(mediaDir, fileName); await writeFile(path, buffer);
      return { path, contentType };
    };
    const parts = [{ type: 'voice', payload: { fileId: 'voice' } }];
    const [media] = await inboundMedia(parts, { account, api, core });
    assert.equal(media.contentType, 'audio/aac');
    const transcribe = (config) => transcribeAudioFile({ filePath: media.path, mime: media.contentType, cfg: config, agentDir });
    const result = await transcribe(cfg);
    assert.equal(result.text, 'OpenClaw, hello'); assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], { method: 'POST', authorization: 'Bearer TEST-STT-KEY', model: 'test-stt',
      name: 'voice.m4a', type: 'audio/aac', bytes: audio });
    assert.equal(downloads[0].authorization, undefined); assert(!downloads[0].url.includes('token='));
    assert(!JSON.stringify(media).includes('TEST-SIGNED-URL'));

    const untrusted = structuredClone(cfg); delete untrusted.models.providers.openai.request;
    await assert.rejects(transcribe(untrusted));
    assert.equal(requests.length, 1, 'Private STT must be blocked before uploading audio without explicit provider trust');

    rejectTranscription = true;
    // Exercise the real SDK's catch-and-continue preflight around the actual provider pipeline.
    // The injected file API supplies deterministic local roots; no provider/HTTP implementation is mocked.
    const preflight = createChannelPreflightAudio({ channel: 'vk-workspace', isAudio: () => true,
      transcribeFirstAudio: async ({ cfg: next }) => (await transcribe(next)).text });
    let preflights = 0;
    setRuntime(core, { ...sdkHelpers, audioPreflight: { ...preflight,
      resolve: async (params) => { preflights++; return preflight.resolve(params); } } });
    const inbox = await new Inbox(join(dir, 'audio-inbox.json')).open();
    try {
      const chat = { chatId: 'group@chat.agent', type: 'group' };
      await inbox.ingest([event(86, { chat, text: '', parts }), event(87, { chat, text: 'OpenClaw, hello' })]);
      await drainInbox({ inbox, handle: (item) => handleInbound({ event: item, self: { userId: 'bot@example.com' },
        account, cfg, api: { ...api, getFileInfo: api.getFileInfo.bind(api), sendTyping: async () => {} } }) });
      assert.equal(preflights, 1); assert.equal(requests.length, 2, 'The rejected STT request must actually reach the fixture');
      assert.equal(seen.dispatches, 1); assert.equal(seen.contexts[0].MessageSid, 'message-87');
      assert.equal(inbox.state.failed.length, 0); assert.equal(inbox.state.pending.length, 0); assert.equal(inbox.state.cursor, '87');
    } finally { await inbox.close(); }
    assert.deepEqual(serverErrors, []);
    console.log('Real SDK audio: separate CDN -> AAC -> configured OpenAI media provider -> HTTP multipart; scoped private-network denial; failed STT preflight preserves mention gating and next-event progress');
  } finally { if (server) await stop(server); await stop(cdn); }
}
