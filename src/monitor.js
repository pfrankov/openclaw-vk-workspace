import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, TeamsApi } from './api.js';
import { Inbox, inboxPath } from './inbox.js';
import { handleInbound } from './inbound.js';
import { getRuntime } from './runtime.js';
import { resolveStateDir } from './state.js';
export { resolveStateDir } from './state.js';

export async function drainInbox({ inbox, handle, signal, onFailure }) {
  // FIFO per chat, four independent chats at a time. A broken conversation does not stop the others.
  const chatKey = (item) => item.event.payload?.chat?.chatId ?? item.event.payload?.message?.chat?.chatId ?? `event:${item.event.eventId}`;
  const blocked = new Set(inbox.state.failed.map(chatKey));
  const groups = new Map();
  for (const item of [...inbox.state.pending]) {
    const key = chatKey(item);
    if (blocked.has(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const queues = [...groups.values()];
  const worker = async () => {
    while (!signal?.aborted && queues.length) {
      for (const item of queues.shift()) {
        if (signal?.aborted) return;
        await inbox.start(item.event.eventId); // Durable fence before any possible agent/tool effect.
        try { await handle(item.event); }
        catch {
          if (signal?.aborted) return;
          await inbox.fail(item.event.eventId, { terminal: true });
          onFailure?.(item.event.eventId);
          // Preserve order: an operator must resolve the failed turn before this chat continues.
          break;
        }
        if (signal?.aborted) return;
        await inbox.complete(item.event.eventId);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queues.length) }, worker));
}
export async function monitorAccount(ctx, deps = {}) {
  const account = ctx.account;
  if (!account.enabled || !account.token) throw new Error('VK Workspace account is disabled or its bot token is missing');
  const core = deps.core ?? getRuntime().core;
  const api = deps.api ?? new TeamsApi(account);
  const inbox = deps.inbox ?? new Inbox(inboxPath(resolveStateDir(core), account));
  const signal = ctx.abortSignal;
  const setStatus = (patch) => ctx.setStatus?.({ accountId: account.accountId, ...patch });
  const log = (message) => ctx.log?.warn?.(message);
  setStatus({ running: true, connected: false, lastStartAt: Date.now(), lastError: null });
  let opened = false;
  let ready = false;
  let failures = 0;
  try {
    signal?.throwIfAborted();
    await inbox.open();
    opened = true;
    let self;
    while (!signal?.aborted && !self) {
      try { self = await api.getSelf({ signal }); failures = 0; }
      catch (error) {
        if (signal?.aborted) break;
        if (!(error instanceof ApiError)) throw error;
        setStatus({ connected: false, lastError: error.message });
        log(error.message);
        await (deps.delay ?? delay)(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)), undefined, { signal });
      }
    }
    while (!signal?.aborted) {
      if (inbox.state.pending.length) {
        await drainInbox({ inbox, signal,
          handle: (event) => (deps.handle ?? handleInbound)({ event, self, account, cfg: ctx.cfg, api, signal, log, setStatus }),
          onFailure: () => { log('VK Workspace event processing failed; retained in durable inbox');
            setStatus({ lastError: 'Event processing failed; inspect the durable inbox' }); },
        });
        if (signal?.aborted) break;
        // Blocked conversations do not prevent polling or progress in unrelated chats.
      }
      try {
        const events = await api.getEvents(inbox.state.cursor, ready ? account.config.pollTime : 1, { signal });
        await inbox.ingest(events); // Persist before the next poll acknowledges lastEventId.
        failures = 0;
        ready = true;
        setStatus({ connected: true, lastConnectedAt: Date.now(), lastEventAt: Date.now(),
          lastError: inbox.state.failed.length ? 'Failed deliveries retained in durable inbox' : null });
        if (!events.length) await delay(250, undefined, { signal }); // Avoid a busy loop on non-blocking servers.
      } catch (error) {
        if (signal?.aborted) break;
        // Storage/validation errors fail closed; never fetch-and-ack a batch we could not persist.
        if (!(error instanceof ApiError)) throw error;
        setStatus({ connected: false, lastError: error.message });
        log(error.message);
        const backoff = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
        await delay(backoff, undefined, { signal });
      }
    }
  } catch (error) {
    if (!signal?.aborted) {
      const message = error instanceof ApiError ? error.message : 'VK Workspace monitor failed; check configuration and inbox storage';
      setStatus({ lastError: message });
      throw new Error(message);
    }
  } finally {
    if (opened) await inbox.close();
    setStatus({ running: false, connected: false, lastStopAt: Date.now() });
  }
}
