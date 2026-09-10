import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWrite, resolveStateDir, syncDirectory } from './state.js';
import { isRecord } from './config.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const tails = new Map();
const keyOf = (chatId, messageId) => JSON.stringify([chatId, messageId]);
export function messageStorePath(core, account) {
  const key = createHash('sha256').update(JSON.stringify([account.baseUrl, account.accountId, account.token])).digest('hex');
  return join(resolveStateDir(core), 'vk-workspace', `${key}.messages.json`);
}
export class MessageStore {
  constructor(path, { now = Date.now } = {}) { this.path = path; this.now = now; }
  async #transaction(fn) {
    const previous = tails.get(this.path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await syncDirectory(dirname(dirname(this.path)));
      let lease;
      try {
        try { lease = await open(`${this.path}.lock`, 'wx', 0o600); }
        catch { throw new Error('VK Workspace message store is locked or unavailable'); }
        let state = { version: 1, messages: {} };
        try {
          if ((await stat(this.path)).size > MAX_BYTES) throw new Error('oversized');
          state = JSON.parse(await readFile(this.path, 'utf8'));
          if (state.version !== 1 || !isRecord(state.messages) || Object.keys(state.messages).length > MAX_MESSAGES) throw new Error('invalid');
          for (const [key, entry] of Object.entries(state.messages)) {
            if (!isRecord(entry) || typeof entry.chatId !== 'string' || typeof entry.messageId !== 'string' ||
                key !== keyOf(entry.chatId, entry.messageId) || !Number.isFinite(entry.createdAt) ||
                !['text', 'file', 'voice'].includes(entry.kind) || typeof entry.revision !== 'string' || !entry.revision ||
                !Array.isArray(entry.callbacks) || entry.callbacks.length > 80 || entry.callbacks.some((callback) =>
                  !isRecord(callback) || !/^ocw:[A-Za-z0-9_-]{24}$/.test(callback.token) ||
                  typeof callback.data !== 'string' || !callback.data || Buffer.byteLength(callback.data) > 256 ||
                  !Number.isFinite(callback.expiresAt) || (callback.ownerId !== undefined && typeof callback.ownerId !== 'string'))) throw new Error('invalid');
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw new Error('VK Workspace message store is unreadable or corrupt');
        }
        for (const [key, entry] of Object.entries(state.messages)) if (this.now() - entry.createdAt >= RETENTION_MS) delete state.messages[key];
        const result = await fn(state.messages);
        const entries = Object.entries(state.messages).sort((a, b) => a[1].createdAt - b[1].createdAt);
        for (const [key] of entries.slice(0, Math.max(0, entries.length - MAX_MESSAGES))) delete state.messages[key];
        let text = JSON.stringify(state);
        for (const [key] of entries.slice(0, -1)) {
          if (Buffer.byteLength(text) <= MAX_BYTES) break;
          delete state.messages[key]; text = JSON.stringify(state);
        }
        if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('VK Workspace message store entry exceeds the size limit');
        await atomicWrite(this.path, text);
        return result;
      } finally {
        if (lease) { await lease.close(); await rm(`${this.path}.lock`, { force: true }); }
      }
    });
    tails.set(this.path, next);
    try { return await next; } finally { if (tails.get(this.path) === next) tails.delete(this.path); }
  }
  remember(chatId, messageId, data = {}) {
    return this.#transaction((messages) => {
      messages[keyOf(chatId, messageId)] = { ...data, revision: randomUUID(), chatId, messageId,
        createdAt: this.now(), callbacks: data.callbacks ?? [] };
    });
  }
  get(chatId, messageId) { return this.#transaction((messages) => structuredClone(messages[keyOf(chatId, messageId)])); }
  async edit(chatId, messageId, update) {
    // Serialize edits and callback consumption across the network call. A failed/ambiguous edit
    // disarms the old menu; it must not retain authority for buttons no longer displayed.
    const result = await this.#transaction(async (messages) => {
      const entry = messages[keyOf(chatId, messageId)];
      if (!entry || entry.kind !== 'text') throw new Error('Only tracked bot text messages can be edited (retention: 7 days / 1000 messages)');
      try {
        const patch = await update(structuredClone(entry));
        messages[keyOf(chatId, messageId)] = { ...entry, ...patch, revision: randomUUID(), createdAt: this.now() };
        return {};
      } catch (error) {
        if (!error.editAttempted) throw error;
        entry.callbacks = []; entry.keyboard = []; entry.revision = randomUUID();
        return { error };
      }
    });
    if (result.error) throw result.error;
  }
  lookup(chatId, messageId, token, senderId) {
    return this.#transaction((messages) => {
      const entry = messages[keyOf(chatId, messageId)];
      const callback = entry?.callbacks.find((item) => item.token === token && item.expiresAt > this.now() && (!item.ownerId || item.ownerId === senderId));
      return callback?.data ?? null;
    });
  }
  consume(chatId, messageId, token, senderId) {
    return this.#transaction((messages) => {
      const entry = messages[keyOf(chatId, messageId)];
      const callback = entry?.callbacks.find((item) => item.token === token && item.expiresAt > this.now() && (!item.ownerId || item.ownerId === senderId));
      if (!callback) return null;
      // One choice consumes the whole menu before dispatch. Repeated clicks cannot repeat a turn.
      entry.revision = randomUUID(); entry.callbacks = []; entry.keyboard = [];
      return callback.data;
    });
  }
}
export function getMessageStore(core, account) { return new MessageStore(messageStorePath(core, account)); }
