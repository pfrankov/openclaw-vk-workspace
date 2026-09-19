import { randomUUID } from 'node:crypto';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Inbox } from './inbox.js';
import { eventId } from './api.js';
import { syncDirectory } from './state.js';

// Offline only: acquire the same exclusive lock as the channel. Never remove a stale lock here.
export async function runInboxCli(args, { out = console.log, error = console.error } = {}) {
  const [command, inputPath, selection] = args;
  if (!['status', 'retry', 'discard'].includes(command) || !inputPath || !isAbsolute(inputPath) || args.length > 3 ||
      (command === 'status' ? selection !== undefined : !selection) || (command === 'discard' && selection === '--all')) {
    error('Stop all consumers, then run: node <plugin>/dist/inbox-cli.js status /absolute/inbox.json');
    error('For changes use: retry /absolute/inbox.json EVENT_ID|--all, or discard /absolute/inbox.json EVENT_ID');
    return 1;
  }
  let inbox;
  let code = 0;
  try {
    // Validate selection before touching the queue, including its interrupted-turn recovery.
    const id = selection && selection !== '--all' ? eventId(selection) : undefined;
    // Resolve aliases before deriving the lock or atomic-write path. A mistyped path
    // fails here instead of initializing a new cursor; a symlink never becomes a new queue.
    const path = await realpath(inputPath);
    const fileState = await stat(path);
    if (!fileState.isFile() || fileState.nlink !== 1) {
      error('Inbox recovery requires a regular file without hard links; no files were changed.');
      return 1;
    }
    inbox = new Inbox(path);
    await inbox.open({ recoverInterrupted: false });
    let backup;
    if (command !== 'status') {
      const candidates = [...inbox.state.failed, ...inbox.state.pending.filter((entry) => entry.started)];
      if (id !== undefined && !candidates.some((entry) => entry.event.eventId === id)) {
        throw new Error('Failed event not found');
      }
      // Copy the original bytes under the consumer lock, before parsed ID normalization
      // or reserialization, with restrictive permissions and durable writes.
      // Mutation must not run if backup creation or directory synchronization fails.
      backup = `${path}.backup-${randomUUID()}`;
      const file = await open(backup, 'wx', 0o600);
      try { await file.writeFile(await readFile(path)); await file.sync(); }
      finally { await file.close(); }
      await syncDirectory(dirname(path));
      out(JSON.stringify({ backup }));
      if (inbox.state.pending.some((entry) => entry.started)) await inbox.quarantineInterrupted();
      if (command === 'retry') await inbox.retryFailed(id);
      else await inbox.discardFailed(id);
    }
    out(JSON.stringify({ cursor: inbox.state.cursor, pending: inbox.state.pending.length,
      interrupted: inbox.state.pending.filter((entry) => entry.started).map((entry) => entry.event.eventId),
      failed: inbox.state.failed.map(({ event, attempts, reason, failure }) => ({ eventId: event.eventId,
        type: event.type, attempts, reason, failure })) }, null, 2));
  } catch {
    // Filesystem errors may include paths; JSON parser errors may include message content.
    error('Inbox operation failed; check the path, permissions, lock and event ID. Never reset the cursor.');
    code = 1;
  } finally {
    try { await inbox?.close(); }
    catch { error('Could not release the inbox lock; verify all consumers are stopped before recovery.'); code = 1; }
  }
  return code;
}

// Importing the packed module for SDK validation must not run a command or touch state.
const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await runInboxCli(process.argv.slice(2));
}
