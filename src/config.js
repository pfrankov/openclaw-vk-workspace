import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const CHANNEL_ID = 'vk-workspace';
export const DEFAULT_ACCOUNT_ID = 'default';
export const DEFAULT_BASE_URL = 'https://api.internal.myteam.mail.ru/bot/v1';
const TOKEN_FILE_MAX_BYTES = 64 * 1024;
export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const normalizeId = (value) => String(value ?? '').trim().replace(/^vk-workspace:(?:user:|chat:)?/i, '');
const string = { type: 'string' };
const boolean = { type: 'boolean' };
const strings = { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true };
const policy = (values) => ({ type: 'string', enum: values });
const groupSchema = {
  type: 'object', additionalProperties: false,
  properties: { enabled: boolean, requireMention: boolean, allowFrom: strings, systemPrompt: string },
};
const accountProperties = {
  enabled: boolean, name: string, baseUrl: string, botToken: string, tokenFile: string,
  allowInsecureHttp: boolean,
  dmPolicy: policy(['pairing', 'allowlist', 'open', 'disabled']), allowFrom: strings,
  groupPolicy: policy(['allowlist', 'open', 'disabled']), groupAllowFrom: strings,
  groups: { type: 'object', additionalProperties: groupSchema },
  requireMention: boolean, defaultTo: string, textFormat: policy(['markdown', 'plain']),
  pollTime: { type: 'integer', minimum: 1, maximum: 60 },
  requestTimeoutMs: { type: 'integer', minimum: 1000, maximum: 300000 },
  mediaMaxMb: { type: 'number', minimum: 1, maximum: 100 },
  mediaAllowedOrigins: strings,
};
export const channelSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    ...accountProperties, defaultAccount: string,
    accounts: {
      type: 'object', propertyNames: { pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
      additionalProperties: { type: 'object', additionalProperties: false, properties: accountProperties },
    },
  },
};
export const uiHints = {
  baseUrl: { label: 'VK Teams Bot API URL', placeholder: 'https://teams.example.com/bot/v1' },
  botToken: { label: 'Bot API token', sensitive: true },
  tokenFile: { label: 'Bot token file' },
  'accounts.*.botToken': { label: 'Bot API token', sensitive: true },
};

function readTokenFile(path) {
  if (!isAbsolute(path)) throw new Error('VK Workspace tokenFile must be an absolute path');
  let fd;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('invalid token file');
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > TOKEN_FILE_MAX_BYTES) throw new Error('invalid token file');
    const buffer = Buffer.allocUnsafe(TOKEN_FILE_MAX_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    if (bytes > TOKEN_FILE_MAX_BYTES) throw new Error('invalid token file');
    return buffer.toString('utf8', 0, bytes).trim();
  } catch {
    throw new Error('Cannot read VK Workspace tokenFile');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Keep runtime validation equivalent to the manifest without pulling in a schema library.
export function validate(value, schema = channelSchema, path = `channels.${CHANNEL_ID}`) {
  if (schema.type === 'object') {
    if (!isRecord(value)) throw new Error(`${path} must be an object`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.propertyNames && !new RegExp(schema.propertyNames.pattern).test(key)) {
        throw new Error(`${path}: invalid account id`);
      }
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`${path}: reserved key`);
      const rule = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : schema.additionalProperties;
      if (!rule || rule === false) throw new Error(`${path}: unknown setting ${key}`);
      validate(child, rule, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    value.forEach((child) => validate(child, schema.items, path));
    if (schema.uniqueItems && new Set(value).size !== value.length) throw new Error(`${path}: duplicate entries`);
  } else {
    const matches = schema.type === 'integer' ? Number.isSafeInteger(value)
      : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === schema.type;
    if (!matches || (schema.enum && !schema.enum.includes(value)) ||
        (schema.minimum !== undefined && value < schema.minimum) ||
        (schema.maximum !== undefined && value > schema.maximum) ||
        (schema.minLength !== undefined && value.length < schema.minLength)) {
      throw new Error(`${path}: invalid value`);
    }
  }
}

export function normalizeBaseUrl(input, allowInsecureHttp = false) {
  let url;
  try { url = new URL(input); } catch { throw new Error('baseUrl must be an absolute Bot API URL'); }
  if (url.username || url.password || url.search || url.hash ||
      !['https:', 'http:'].includes(url.protocol)) {
    throw new Error('baseUrl must be HTTP(S), without credentials, query or fragment');
  }
  if (url.protocol === 'http:' && !allowInsecureHttp) {
    throw new Error('HTTP sends the bot token in cleartext; use HTTPS or explicitly set allowInsecureHttp');
  }
  // Accept a server origin or a full prefixed /bot/v1 endpoint. Never strip a reverse-proxy prefix.
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/bot/v1') ? path : `${path}/bot/v1`;
  return url.href.replace(/\/$/, '');
}

export function sectionOf(cfg) { return cfg?.channels?.[CHANNEL_ID] ?? {}; }
export function listAccountIds(cfg, env = process.env) {
  const section = sectionOf(cfg);
  const ids = Object.keys(section.accounts ?? {});
  if (!ids.length || section.botToken || section.tokenFile || env.VK_WORKSPACE_BOT_TOKEN) ids.push(DEFAULT_ACCOUNT_ID);
  return [...new Set(ids)].sort();
}
export function defaultAccountId(cfg, env = process.env) {
  const section = sectionOf(cfg);
  const ids = listAccountIds(cfg, env);
  const selected = section.defaultAccount ?? (ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : ids[0]);
  if (!ids.includes(selected)) throw new Error('defaultAccount must name a configured account');
  return selected;
}

export function resolveAccount(cfg, requestedId, { env = process.env, readToken = true } = {}) {
  const section = sectionOf(cfg);
  validate(section);
  const accountId = requestedId?.trim() || defaultAccountId(cfg, env);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(accountId)) throw new Error('Invalid VK Workspace account id');
  const own = section.accounts?.[accountId];
  if (accountId !== DEFAULT_ACCOUNT_ID && !own) throw new Error('Unknown VK Workspace account');
  const { accounts: _accounts, defaultAccount: _default, botToken: rootToken, tokenFile: rootFile, ...shared } = section;
  const config = { ...shared, ...own };
  // Named accounts inherit policy/URL, never another account's credentials or the default environment token.
  const credentials = own ?? (accountId === DEFAULT_ACCOUNT_ID ? { botToken: rootToken, tokenFile: rootFile } : {});
  if (credentials.botToken && credentials.tokenFile) throw new Error('Set botToken or tokenFile, not both');
  let token = credentials.botToken?.trim() || '';
  let tokenSource = token ? 'config' : 'none';
  if (credentials.tokenFile) {
    tokenSource = 'file';
    if (!isAbsolute(credentials.tokenFile)) throw new Error('VK Workspace tokenFile must be an absolute path');
    if (readToken) {
      token = readTokenFile(credentials.tokenFile);
      if (!token) throw new Error('VK Workspace tokenFile is empty');
    }
  } else if (!token && accountId === DEFAULT_ACCOUNT_ID && !own) {
    token = env.VK_WORKSPACE_BOT_TOKEN?.trim() || '';
    tokenSource = token ? 'env' : 'none';
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl ||
    (accountId === DEFAULT_ACCOUNT_ID ? env.VK_WORKSPACE_BASE_URL : undefined) || DEFAULT_BASE_URL,
  config.allowInsecureHttp);
  config.baseUrl = baseUrl;
  config.dmPolicy ??= 'pairing';
  config.groupPolicy ??= 'allowlist';
  config.requireMention ??= true;
  config.pollTime ??= 30;
  config.requestTimeoutMs ??= 30000;
  config.mediaMaxMb ??= 20;
  config.textFormat ??= 'markdown';
  for (const origin of config.mediaAllowedOrigins ?? []) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('mediaAllowedOrigins must contain HTTP(S) origins'); }
    if (url.origin !== origin || !['https:', 'http:'].includes(url.protocol) ||
        (url.protocol === 'http:' && !config.allowInsecureHttp)) {
      throw new Error('mediaAllowedOrigins must contain exact origins, without paths; HTTPS is required by default');
    }
  }
  return {
    accountId, name: config.name, enabled: section.enabled !== false && config.enabled !== false,
    configured: tokenSource !== 'none', token, tokenSource, baseUrl, config,
  };
}
export function inspectAccount(cfg, accountId) {
  const account = resolveAccount(cfg, accountId, { readToken: false });
  return { accountId: account.accountId, name: account.name, enabled: account.enabled,
    configured: account.configured, tokenSource: account.tokenSource };
}
export function editAccount(cfg, accountId, patch) {
  const section = sectionOf(cfg);
  const id = accountId || defaultAccountId(cfg);
  let next;
  if (id === DEFAULT_ACCOUNT_ID && !section.accounts?.[id] && !Object.keys(section.accounts ?? {}).length) {
    next = { ...section, ...patch };
  } else {
    const current = section.accounts?.[id] ?? (id === DEFAULT_ACCOUNT_ID
      ? Object.fromEntries(['botToken', 'tokenFile'].filter((key) => section[key] !== undefined).map((key) => [key, section[key]])) : {});
    next = { ...section, accounts: { ...section.accounts, [id]: { ...current, ...patch } } };
    if (id === DEFAULT_ACCOUNT_ID) { delete next.botToken; delete next.tokenFile; }
  }
  validate(next);
  return { ...cfg, channels: { ...cfg.channels, [CHANNEL_ID]: next } };
}
export function matchesAllowFrom(entries, id) {
  return (entries ?? []).some((entry) => entry === '*' || normalizeId(entry) === normalizeId(id));
}
