import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { eventId } from './api.js';
import { atomicWrite, syncDirectory } from './state.js';

const MAX_ITEMS = 1000;
const MAX_BYTES = 16 * 1024 * 1024;
export function inboxPath(stateDir, account) {
  // The same endpoint/token must share a lock even if accidentally configured under two account ids.
  const key = createHash('sha256').update(account.baseUrl).update('\0').update(account.token).digest('hex').slice(0, 32);
  return join(stateDir, 'vk-workspace', `${key}.json`);
}
export class Inbox {
  #tail = Promise.resolve();
  #lease;
  constructor(path) { this.path = path; this.state = { version: 1, cursor: '0', pending: [], failed: [] }; }
  async open() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await syncDirectory(dirname(dirname(this.path)));
    const lock = `${this.path}.lock`;
    try {
      this.#lease = await open(lock, 'wx', 0o600);
      await this.#lease.writeFile(String(process.pid));
    } catch (error) {
      if (this.#lease) { await this.#lease.close(); this.#lease = undefined; await rm(lock, { force: true }); }
      if (error.code === 'EEXIST') throw new Error('VK Workspace inbox is locked; stop all consumers before removing a stale .lock file');
      throw error;
    }
    try {
      let raw;
      try {
        if ((await stat(this.path)).size > MAX_BYTES) throw new Error('Inbox exceeds size limit');
        raw = await readFile(this.path, 'utf8');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (raw !== undefined) {
        const state = JSON.parse(raw);
        if (state.version !== 1 || !Array.isArray(state.pending) || !Array.isArray(state.failed) ||
            state.pending.length + state.failed.length > MAX_ITEMS) throw new Error('Invalid inbox state');
        state.cursor = eventId(state.cursor);
        const ids = new Set();
        for (const entry of [...state.pending, ...state.failed]) {
          const id = eventId(entry.event?.eventId);
          if (BigInt(id) > BigInt(state.cursor) || ids.has(id) || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0) throw new Error('Invalid inbox entry');
          entry.event.eventId = id;
          ids.add(id);
        }
        // A process may have stopped after a tool effect or send but before completion.
        // Quarantine those turns rather than executing them again automatically.
        const interrupted = state.pending.filter((entry) => entry.started);
        if (interrupted.length) {
          state.pending = state.pending.filter((entry) => !entry.started);
          state.failed.push(...interrupted.map((entry) => ({ ...entry, reason: 'interrupted' })));
          await this.#commit(state);
        } else this.state = state;
      }
    } catch {
      await this.close();
      throw new Error('VK Workspace inbox is unreadable or corrupt; restore it instead of resetting the cursor');
    }
    return this;
  }
  async #commit(next) {
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('VK Workspace inbox storage limit reached');
    await atomicWrite(this.path, text);
    this.state = next;
  }

  #update(fn) {
    const result = this.#tail.then(async () => {
      if (!this.#lease) throw new Error('Inbox is not open');
      await this.#commit(fn(structuredClone(this.state)));
    });
    this.#tail = result.catch(() => {});
    return result;
  }
  ingest(events) {
    return this.#update((state) => {
      const sorted = events.map((event) => ({ ...event, eventId: eventId(event.eventId) }))
        .sort((a, b) => BigInt(a.eventId) < BigInt(b.eventId) ? -1 : BigInt(a.eventId) > BigInt(b.eventId) ? 1 : 0);
      for (const event of sorted) {
        if (BigInt(event.eventId) <= BigInt(state.cursor)) continue;
        state.pending.push({ event, attempts: 0 });
        state.cursor = event.eventId;
      }
      if (state.pending.length + state.failed.length > MAX_ITEMS) throw new Error('VK Workspace inbox is full; resolve failed deliveries');
      return state;
    });
  }
  complete(id) { return this.#update((state) => ({ ...state, pending: state.pending.filter((item) => item.event.eventId !== id) })); }
  start(id) {
    return this.#update((state) => {
      const entry = state.pending.find((item) => item.event.eventId === id);
      if (entry) entry.started = true;
      return state;
    });
  }
  fail(id, { terminal = false } = {}) {
    return this.#update((state) => {
      const entry = state.pending.find((item) => item.event.eventId === id);
      if (!entry) return state;
      entry.attempts++;
      if (terminal || entry.attempts >= 3) {
        state.pending = state.pending.filter((item) => item !== entry);
        state.failed.push({ ...entry, reason: terminal ? 'processing-failed' : 'attempts-exhausted' });
      }
      return state;
    });
  }
  discardFailed(id) {
    return this.#update((state) => {
      if (!state.failed.some((entry) => entry.event.eventId === id)) throw new Error('Failed event not found');
      state.failed = state.failed.filter((entry) => entry.event.eventId !== id);
      return state;
    });
  }
  retryFailed() {
    return this.#update((state) => {
      state.pending.push(...state.failed.map((entry) => ({ ...entry, started: false, reason: undefined, attempts: 0 })));
      state.pending.sort((a, b) => BigInt(a.event.eventId) < BigInt(b.event.eventId) ? -1 : 1);
      state.failed = [];
      return state;
    });
  }
  async close() {
    await this.#tail;
    if (this.#lease) {
      await this.#lease.close();
      this.#lease = undefined;
      await rm(`${this.path}.lock`, { force: true });
    }
  }
}
