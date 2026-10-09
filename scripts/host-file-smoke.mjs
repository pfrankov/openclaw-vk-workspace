import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, installRuntime } from '../test/helpers.js';

// Exercise the packed plugin with real SDK filesystem checks, not the unit reader double.
export async function checkHostFiles(base, dir) {
  const load = (name) => import(pathToFileURL(join(base, 'dist', `${name}.js`)));
  const [{ readLocalMedia }, { sendPayload }, { resolveAccount }, { setRuntime }, { sdkHelpers }] = await Promise.all(
    ['media', 'send', 'config', 'runtime', 'index'].map(load));
  const cfg = config(), account = resolveAccount(cfg), { core } = installRuntime({ cfg });
  setRuntime(core, sdkHelpers);
  const root = join(dir, 'files-allowed'), second = join(dir, 'files-second'), outside = join(dir, 'files-outside');
  for (const directory of [root, second, outside, join(root, 'slot')]) await fs.mkdir(directory, { recursive: true });
  const normal = join(root, 'normal.txt');
  await fs.writeFile(normal, 'allowed');
  await fs.writeFile(join(second, 'second.txt'), 'second');
  await fs.writeFile(join(outside, 'secret.txt'), 'private');
  for (const path of ['normal.txt', normal, pathToFileURL(normal).href]) {
    assert.equal((await readLocalMedia(path, [root], 1024)).buffer.toString(), 'allowed');
  }
  assert.equal((await readLocalMedia('second.txt', [root, second], 1024)).buffer.toString(), 'second');
  await fs.writeFile(join(second, 'normal.txt'), 'ok');
  await assert.rejects(readLocalMedia('normal.txt', [root, second], 4), /size limit/);
  assert.equal((await readLocalMedia(normal, [root], 7.5)).buffer.toString(), 'allowed');
  await assert.rejects(readLocalMedia(normal, [], 1024), /approved media roots/);
  await assert.rejects(readLocalMedia(normal, [root], 4), /size limit/);
  await assert.rejects(readLocalMedia('../files-outside/secret.txt', [root], 1024));
  if (process.platform === 'win32') return;
  await fs.symlink(normal, join(root, 'inside.txt'));
  await fs.symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  await fs.link(join(outside, 'secret.txt'), join(root, 'hardlink.txt'));
  assert.equal((await readLocalMedia('inside.txt', [root], 1024)).buffer.toString(), 'allowed');
  await assert.rejects(readLocalMedia('escape.txt', [root], 1024));
  await assert.rejects(readLocalMedia('hardlink.txt', [root], 1024));

  const target = join(root, 'slot', 'payload.txt');
  await fs.writeFile(target, 'allowed');
  await fs.writeFile(join(outside, 'payload.txt'), 'private');
  const realOpen = fs.open;
  let replaced = false, sends = 0;
  try {
    // Insert a real parent-directory replacement after validation, just before the real open.
    fs.open = async (path, ...options) => {
      if (path === target && !replaced) {
        replaced = true;
        await fs.rename(join(root, 'slot'), join(root, 'original'));
        await fs.symlink(outside, join(root, 'slot'));
      }
      return realOpen(path, ...options);
    };
    syncBuiltinESMExports();
    await assert.rejects(sendPayload('user@example.com', { mediaUrl: target }, {
      cfg, account, core, mediaLocalRoots: [root],
      api: { sendFile: async () => { sends++; return { messageId: 'unexpected' }; } },
    }));
    assert.equal(replaced, true, 'The test must reach the validation/open race');
    assert.equal(sends, 0, 'Unsafe bytes must not reach the Bot API');
  } finally { fs.open = realOpen; syncBuiltinESMExports(); }

  const movableRoot = join(dir, 'files-movable');
  await fs.mkdir(movableRoot);
  await fs.writeFile(join(movableRoot, 'payload.txt'), 'allowed');
  const realRead = sdkHelpers.readLocalFileFromRoots;
  let rootReplaced = false;
  try {
    // A fresh SDK Root must not widen the caller's already selected canonical roots.
    sdkHelpers.readLocalFileFromRoots = async (options) => {
      rootReplaced = true;
      await fs.rename(movableRoot, join(dir, 'files-moved'));
      await fs.symlink(outside, movableRoot);
      return realRead(options);
    };
    await assert.rejects(sendPayload('user@example.com', { mediaUrl: join(movableRoot, 'payload.txt') }, {
      cfg, account, core, mediaLocalRoots: [movableRoot],
      api: { sendFile: async () => { sends++; return { messageId: 'unexpected' }; } },
    }));
    assert.equal(rootReplaced, true);
    assert.equal(sends, 0);
  } finally { sdkHelpers.readLocalFileFromRoots = realRead; }

  const fifo = join(root, 'input.fifo');
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 5000 });
  assert.equal(created.status, 0, created.error?.message ?? created.stderr);
  const moduleUrl = (name) => JSON.stringify(pathToFileURL(join(base, 'dist', `${name}.js`)).href);
  // Keep a broken blocking open from hanging the entire host smoke run.
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { readLocalMedia } from ${moduleUrl('media')};
    import { setRuntime } from ${moduleUrl('runtime')};
    import { sdkHelpers } from ${moduleUrl('index')};
    setRuntime({}, sdkHelpers);
    await assert.rejects(readLocalMedia(process.argv[1], [process.argv[2]], 1024), /Local media/);
  `, fifo, root], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
}
