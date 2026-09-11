import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAccount } from '../src/config.js';
import { setRuntime } from '../src/runtime.js';

const runtimeDirs = new Set();
process.once('exit', () => { for (const dir of runtimeDirs) rmSync(dir, { recursive: true, force: true }); });

export const config = (settings = {}) => ({ channels: { 'vk-workspace': { botToken: 'test-token-DO-NOT-LOG', ...settings } } });
export const account = (settings = {}) => resolveAccount(config(settings), 'default', { env: {} });
export const event = (id = 1, payload = {}) => ({ eventId: id, type: 'newMessage', payload: {
  msgId: `message-${id}`, chat: { chatId: 'user@example.com', type: 'private' },
  from: { userId: 'user@example.com', firstName: 'Test' }, text: 'Привет', timestamp: 1700000000, ...payload } });
export async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vk-workspace-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
export async function httpServer(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const item = { method: req.method, url: new URL(req.url, 'http://localhost'), headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8') };
      requests.push(item);
      res.setHeader('Content-Type', 'application/json');
      await handler(item, res);
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, account: account({ baseUrl: origin, allowInsecureHttp: true }) };
}
export function installRuntime({ cfg = config(), payloads = [{ text: 'Ответ' }], paired = [], mediaRoots = [],
  mentionPatterns = [], audioTranscript } = {}) {
  const seen = { routes: [], contexts: [], sessions: [], challenges: [], storeReads: 0, dispatches: 0, saved: [], preflights: [], transcriptEchoes: [] };
  const stateDir = mkdtempSync(join(tmpdir(), 'vk-workspace-runtime-'));
  runtimeDirs.add(stateDir);
  const core = {
    state: { resolveStateDir: () => stateDir },
    config: { current: () => cfg },
    channel: {
      commands: { shouldHandleTextCommands: () => true },
      text: { hasControlCommand: (text) => text.startsWith('/') },
      mentions: { buildMentionRegexes: () => mentionPatterns,
        matchesMentionPatterns: (text, patterns) => patterns.some((pattern) => pattern.test(text)) },
      routing: { resolveAgentRoute: (params) => { seen.routes.push(params); return {
        agentId: 'main', accountId: params.accountId, sessionKey: `${params.accountId}:${params.peer.kind}:${params.peer.id}` }; } },
      session: { resolveStorePath: () => '/test/session.json', readSessionUpdatedAt: () => undefined,
        recordInboundSession: async (params) => { seen.sessions.push(params); } },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}), formatAgentEnvelope: ({ body }) => body,
        finalizeInboundContext: (ctx) => { seen.contexts.push(ctx); return ctx; },
        dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions }) => {
          seen.dispatches++;
          for (const payload of payloads) await dispatcherOptions.deliver(payload);
        },
      },
      media: {
        fetchRemoteMedia: async () => { throw new Error('Private or unapproved remote URL'); },
        saveMediaBuffer: async (buffer, contentType, _directory, _limit, fileName) => {
          seen.saved.push({ buffer, fileName, contentType }); return { path: `/test/media/${fileName}`, contentType };
        },
      },
    },
  };
  const sdk = {
    createPairing: (params) => ({ readAllowFromStore: async () => { seen.storeReads++; return paired; },
      issueChallenge: async (challenge) => { seen.challenges.push(params); await challenge.sendPairingReply('Pairing required: code TEST'); } }),
    commandGate: ({ useAccessGroups, authorizers, hasControlCommand }) => {
      const authorized = !useAccessGroups || authorizers.some((item) => item.allowed);
      return { commandAuthorized: authorized, shouldBlock: hasControlCommand && !authorized };
    },
    mediaFacts: (media) => media, replyPrefix: () => ({}), mediaRoots: () => mediaRoots,
    audioPreflight: {
      resolve: async ({ request }) => { seen.preflights.push(request); if (audioTranscript && request.ctx.media[0]) request.ctx.media[0].transcribed = true; return audioTranscript; },
      send: async (params) => { seen.transcriptEchoes.push(params); },
    },
    formatAudioTranscript: (transcript) => `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(transcript)}`,
  };
  setRuntime(core, sdk);
  return { core, sdk, seen };
}
