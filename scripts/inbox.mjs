import { runInboxCli } from '../src/inbox-cli.js';
process.exitCode = await runInboxCli(process.argv.slice(2));
