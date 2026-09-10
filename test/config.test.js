import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAccount, inspectAccount, listAccountIds, normalizeBaseUrl, validate, matchesAllowFrom, channelSchema } from '../src/config.js';
import { setupPlugin } from '../src/channel-setup.js';
import { config, account, tempDir } from './helpers.js';

test('safe defaults: pairing DMs, allowlisted groups, mention required', () => {
  const a = account();
  assert.equal(a.config.dmPolicy, 'pairing'); assert.equal(a.config.groupPolicy, 'allowlist');
  assert.equal(a.config.requireMention, true); assert.equal(a.config.pollTime, 30);
  assert.equal(a.baseUrl, 'https://api.internal.myteam.mail.ru/bot/v1');
});
test('base URL accepts origin, full path and proxy prefixes without duplicating bot/v1', () => {
  for (const value of ['https://teams.example', 'https://teams.example/', 'https://teams.example/bot/v1/']) {
    assert.equal(normalizeBaseUrl(value), 'https://teams.example/bot/v1');
  }
  assert.equal(normalizeBaseUrl('https://teams.example/proxy/'), 'https://teams.example/proxy/bot/v1');
});
for (const value of ['http://teams.example', 'file:///secret', 'https://u:p@teams.example', 'https://teams.example/?token=x', 'https://teams.example/#x', 'teams.example']) {
  test(`reject unsafe Bot API URL: ${value}`, () => assert.throws(() => normalizeBaseUrl(value)));
}
test('plain HTTP requires explicit opt-in', () => assert.equal(normalizeBaseUrl('http://localhost:8080', true), 'http://localhost:8080/bot/v1'));
for (const value of [{ pollTime: 0 }, { pollTime: 61 }, { requestTimeoutMs: 999 }, { mediaMaxMb: 101 }, { token: 'typo' }, { allowFrom: ['x', 'x'] }, { accounts: { '../escape': {} } }, JSON.parse('{"__proto__":{}}')]) {
  test(`runtime schema rejects invalid settings: ${JSON.stringify(value)}`, () => assert.throws(() => validate(value)));
}
test('named accounts inherit policy and URL, never default credentials or environment token', () => {
  const cfg = config({ baseUrl: 'https://teams.example', allowFrom: ['alice'], accounts: { work: { name: 'Work' }, other: { botToken: 'other' } } });
  const env = { VK_WORKSPACE_BOT_TOKEN: 'environment', VK_WORKSPACE_BASE_URL: 'https://env.example' };
  const work = resolveAccount(cfg, 'work', { env });
  assert.equal(work.token, ''); assert.equal(work.configured, false);
  assert.equal(work.baseUrl, 'https://teams.example/bot/v1'); assert.deepEqual(work.config.allowFrom, ['alice']);
  assert.equal(resolveAccount(cfg, 'other', { env }).token, 'other');
  assert.deepEqual(listAccountIds(cfg, env), ['default', 'other', 'work']);
  assert.throws(() => resolveAccount(cfg, 'unknown', { env }));
});
test('default-account environment fallback and account selection', () => {
  const a = resolveAccount({}, undefined, { env: { VK_WORKSPACE_BOT_TOKEN: 'env', VK_WORKSPACE_BASE_URL: 'https://env.example' } });
  assert.equal(a.token, 'env'); assert.equal(a.baseUrl, 'https://env.example/bot/v1');
  assert.equal(resolveAccount({ channels: { 'vk-workspace': { accounts: { work: { botToken: 'work' } } } } }, undefined, { env: {} }).accountId, 'work');
});
test('explicit named credentials, including default, cannot silently borrow the root token', () => {
  assert.equal(resolveAccount(config({ accounts: { default: {} } }), 'default', { env: { VK_WORKSPACE_BOT_TOKEN: 'env' } }).token, '');
});
test('tokenFile precedence, errors and cold inspection never expose or read file secrets', async (t) => {
  const dir = await tempDir(t); const file = join(dir, 'bot.token');
  await writeFile(file, '  file-secret\n');
  const cfg = { channels: { 'vk-workspace': { tokenFile: file } } };
  assert.equal(resolveAccount(cfg).token, 'file-secret');
  const cold = inspectAccount({ channels: { 'vk-workspace': { tokenFile: '/missing/private/token' } } });
  assert.equal(cold.configured, true); assert.equal(cold.token, undefined); assert(!JSON.stringify(cold).includes('/missing'));
  assert.throws(() => resolveAccount(config({ tokenFile: file })), /not both/);
  await writeFile(file, ''); assert.throws(() => resolveAccount(cfg), /empty/);
  assert.throws(() => resolveAccount({ channels: { 'vk-workspace': { tokenFile: '/missing' } } }, undefined, { env: { VK_WORKSPACE_BOT_TOKEN: 'fallback' } }), /Cannot read/);
});
test('root disabled flag dominates account enabled flag', () => {
  assert.equal(resolveAccount(config({ enabled: false, accounts: { work: { enabled: true, botToken: 'work' } } }), 'work').enabled, false);
});
test('media origins are explicit exact HTTP(S) origins', () => {
  for (const bad of ['https://files.example/path', 'https://files.example/', '*', 'http://internal', 'https://u:p@files.example']) assert.throws(() => account({ mediaAllowedOrigins: [bad] }));
  assert.deepEqual(account({ mediaAllowedOrigins: ['https://files.example'] }).config.mediaAllowedOrigins, ['https://files.example']);
});
test('opaque allowlist ids preserve punctuation and accept only the channel prefix', () => {
  assert(matchesAllowFrom(['vk-workspace:user:person+tag@example.com'], 'person+tag@example.com'));
  assert(!matchesAllowFrom(['person@example.com'], 'person+tag@example.com'));
  assert(!matchesAllowFrom(['vk:person@example.com'], 'person@example.com'));
});
test('setup replaces tokenFile with token and preserves URL and sibling accounts', () => {
  const cfg = { channels: { 'vk-workspace': { baseUrl: 'https://teams.example', accounts: { work: { tokenFile: '/secret' }, other: { botToken: 'other' } } } } };
  const next = setupPlugin.setup.applyAccountConfig({ cfg, accountId: 'work', input: { token: 'new' } });
  assert.equal(resolveAccount(next, 'work').token, 'new'); assert.equal(next.channels['vk-workspace'].accounts.work.tokenFile, undefined);
  assert.equal(resolveAccount(next, 'other').token, 'other'); assert.equal(resolveAccount(next, 'work').baseUrl, 'https://teams.example/bot/v1');
});
test('cold setup uses exactly the manifest-owned runtime schema', () => assert.deepEqual(setupPlugin.configSchema.schema, channelSchema));
test('disabling or deleting the default account does not disable named accounts', () => {
  const cfg = config({ accounts: { work: { botToken: 'work' } } });
  for (const next of [setupPlugin.config.setAccountEnabled({ cfg, accountId: 'default', enabled: false }),
    setupPlugin.config.deleteAccount({ cfg, accountId: 'default' })]) {
    assert.equal(resolveAccount(next, 'work').enabled, true);
    assert.equal(resolveAccount(next, 'work').token, 'work');
    assert.equal(resolveAccount(next, 'default').enabled, false);
  }
});
