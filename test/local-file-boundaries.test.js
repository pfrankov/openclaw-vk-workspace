import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readLocalMedia } from '../src/media.js';
import { installRuntime, tempDir } from './helpers.js';

const moduleUrl = (path) => JSON.stringify(new URL(path, import.meta.url).href);
const cases = {
  tokenFile: `
    import { resolveAccount } from ${moduleUrl('../src/config.js')};
    assert.throws(() => resolveAccount({ channels: { 'vk-workspace': { tokenFile: file } } },
      'default', { env: {} }), /^Error: Cannot read VK Workspace tokenFile$/);
  `,
  'outgoing media': `
    import { sendPayload } from ${moduleUrl('../src/send.js')};
    import { account, installRuntime } from ${moduleUrl('./helpers.js')};
    const { core } = installRuntime();
    let sends = 0;
    await assert.rejects(sendPayload('user@example.com', { mediaUrl: file }, {
      core, account: account(), mediaLocalRoots: [root],
      api: { sendFile: async () => { sends++; return { messageId: 'unexpected' }; } },
    }), /not a regular file/);
    assert.equal(sends, 0);
  `,
};

for (const [name, check] of Object.entries(cases)) {
  test(`${name} rejects a FIFO without waiting for a writer`, { skip: process.platform === 'win32' }, async (t) => {
    const root = await tempDir(t), file = join(root, 'input.fifo');
    const created = spawnSync('mkfifo', [file], { encoding: 'utf8', timeout: 5000 });
    assert.equal(created.status, 0, created.error?.message ?? created.stderr);
    // A subprocess timeout also catches a blocking synchronous token-file open.
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      const [file, root] = process.argv.slice(1);
      process.stdout.write('started\\n');
      ${check}
      process.stdout.write('rejected\\n');
    `, file, root], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    assert.equal(child.stdout, 'started\nrejected\n');
  });
}

test('local media delegates its final read and byte cap to the injected SDK boundary', async (t) => {
  const root = await tempDir(t), file = join(root, 'input.txt');
  await writeFile(file, 'local');
  const { sdk } = installRuntime();
  const calls = [];
  sdk.readLocalFileFromRoots = async (options) => {
    calls.push(options); return { buffer: Buffer.from('safe-sdk'), realPath: file };
  };
  assert.equal((await readLocalMedia(file, [root], 1024.5)).buffer.toString(), 'safe-sdk');
  assert.deepEqual(calls, [{ filePath: file, roots: [root], maxBytes: 1024, symlinks: 'follow-within-root' }]);
  sdk.readLocalFileFromRoots = async () => ({ buffer: Buffer.from('private'), realPath: join(root, '..', 'outside.txt') });
  await assert.rejects(readLocalMedia(file, [root], 1024));
  sdk.readLocalFileFromRoots = async () => { throw new Error('SECRET provider path'); };
  await assert.rejects(readLocalMedia(file, [root], 1024), (error) => {
    assert(!String(error).includes('SECRET')); assert.equal(error.cause, undefined); return true;
  });
  sdk.readLocalFileFromRoots = undefined;
  await assert.rejects(readLocalMedia(file, [root], 1024));
});
