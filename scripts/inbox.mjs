import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Inbox } from '../src/inbox.js';
import { eventId } from '../src/api.js';
const [command, path, id] = process.argv.slice(2);
if (!['status', 'retry', 'discard'].includes(command) || !path || !isAbsolute(path) || (command === 'discard' && !id)) {
  console.error('Stop the channel, then run: node scripts/inbox.mjs status|retry|discard /absolute/path/to/inbox.json [eventId]');
  process.exitCode = 1;
} else {
  const inbox = new Inbox(path);
  try {
    await access(path); // Do not accidentally initialize a new cursor when the operator mistypes a path.
    await inbox.open();
    if (command === 'retry') await inbox.retryFailed();
    if (command === 'discard') await inbox.discardFailed(eventId(id));
    console.log(JSON.stringify({ cursor: inbox.state.cursor, pending: inbox.state.pending.length,
      failed: inbox.state.failed.map(({ event, attempts, reason, failure }) => ({ eventId: event.eventId,
        type: event.type, attempts, reason, failure })) }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await inbox.close(); }
}
