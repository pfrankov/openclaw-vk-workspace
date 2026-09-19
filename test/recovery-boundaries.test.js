import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInboxCli } from '../src/inbox-cli.js';
import { inboundMedia, normalizeVoiceMedia } from '../src/media.js';
import { account, event, httpServer, installRuntime, tempDir } from './helpers.js';

test('offline recovery backs up exact original bytes, before ID normalization or reserialization', async (t) => {
  const path = join(await tempDir(t), 'inbox.json');
  const before = JSON.stringify({ version: 1, cursor: '86', pending: [], failed: [
    { event: event(86), attempts: 1, reason: 'processing-failed' },
  ] }, null, 2) + '\n';
  await writeFile(path, before);
  const lines = [];
  assert.equal(await runInboxCli(['discard', path, '86'], { out: (s) => lines.push(s), error: assert.fail }), 0);
  assert.equal(await readFile(JSON.parse(lines[0]).backup, 'utf8'), before);
  const after = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(after.cursor, '86'); assert.equal(after.failed.length, 0);
});

for (const [extension, contentType] of [['aac', 'audio/aac'], ['webm', 'audio/webm']]) {
  test(`long .${extension} metadata names retain their fallback format before filename truncation`, async (t) => {
    const fileName = `${'voice-'.repeat(40)}.${extension}`;
    // No recognized signature: the original metadata filename is the remaining format hint.
    const buffer = Buffer.from('unrecognized header');
    const normalized = normalizeVoiceMedia({ buffer, fileName, contentType: 'application/octet-stream' });
    assert.equal(normalized.contentType, contentType);
    assert(normalized.fileName.length <= 180); assert(normalized.fileName.endsWith(`.${extension}`));
    const cdn = await httpServer(t, (_req, res) => { res.setHeader('Content-Type', 'application/octet-stream'); res.end(buffer); });
    const { core, seen } = installRuntime();
    const [media] = await inboundMedia([{ type: 'voice', payload: { fileId: 'voice' } }], {
      account: account({ allowInsecureHttp: true, mediaAllowedOrigins: [cdn.origin] }), core,
      api: { getFileInfo: async () => ({ url: cdn.origin + '/opaque', filename: fileName }) },
    });
    assert.equal(media.contentType, contentType); assert.equal(seen.saved[0].fileName, normalized.fileName);
  });
}

for (const active of [false, true]) {
  test(`recovery through a queue symlink ${active ? 'respects the active consumer lock' : 'updates the real queue and preserves the symlink'}`,
    { skip: process.platform === 'win32' }, async (t) => {
      const { symlink, lstat, realpath } = await import('node:fs/promises');
      const { Inbox } = await import('../src/inbox.js');
      const dir = await tempDir(t), path = join(dir, 'inbox.json'), alias = join(dir, 'queue-alias.json');
      const inbox = await new Inbox(path).open();
      await inbox.ingest([event(86)]); await inbox.fail('86', { terminal: true });
      if (active) t.after(() => inbox.close()); else await inbox.close();
      await symlink(path, alias);
      const before = await readFile(path, 'utf8'), lines = [];
      const code = await runInboxCli(['discard', alias, '86'], { out: (s) => lines.push(s), error: () => {} });
      assert.equal(code, active ? 1 : 0);
      assert.equal((await lstat(alias)).isSymbolicLink(), true);
      if (active) assert.equal(await readFile(path, 'utf8'), before);
      else {
        assert.equal(JSON.parse(await readFile(path, 'utf8')).failed.length, 0);
        const { backup } = JSON.parse(lines[0]);
        assert(backup.startsWith(await realpath(path) + '.backup-'));
        assert.equal(await readFile(backup, 'utf8'), before);
      }
    });
}

test('the shipped CLI executes through an entrypoint symlink instead of silently doing nothing',
  { skip: process.platform === 'win32' }, async (t) => {
    const { symlink } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { spawnSync } = await import('node:child_process');
    const dir = await tempDir(t), path = join(dir, 'inbox.json'), script = join(dir, 'inbox-cli.js');
    const before = JSON.stringify({ version: 1, cursor: '86', pending: [], failed: [
      { event: event(86), attempts: 1, reason: 'processing-failed' },
    ] });
    await writeFile(path, before);
    await symlink(fileURLToPath(new URL('../src/inbox-cli.js', import.meta.url)), script);
    const result = spawnSync(process.execPath, [script, 'status', path], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).cursor, '86');
    assert.equal(await readFile(path, 'utf8'), before);
  });

for (const active of [false, true]) {
  test(`recovery refuses hard-linked inboxes ${active ? 'while their consumer is active' : 'while offline'}`,
    async (t) => {
      const { link, stat, readdir } = await import('node:fs/promises');
      const { Inbox } = await import('../src/inbox.js');
      const dir = await tempDir(t), path = join(dir, 'inbox.json'), alias = join(dir, 'hard-link.json');
      const inbox = await new Inbox(path).open();
      await inbox.ingest([event(86)]); await inbox.fail('86', { terminal: true });
      if (active) t.after(() => inbox.close()); else await inbox.close();
      await link(path, alias);
      const before = await readFile(path, 'utf8'), names = (await readdir(dir)).sort();
      for (const input of [path, alias]) {
        for (const args of [['status', input], ['retry', input, '86'], ['discard', input, '86']]) {
          const output = [];
          assert.equal(await runInboxCli(args, { out: (s) => output.push(s), error: () => {} }), 1);
          assert.deepEqual(output, []);
          assert.equal(await readFile(path, 'utf8'), before); assert.equal(await readFile(alias, 'utf8'), before);
          assert.equal((await stat(path)).ino, (await stat(alias)).ino);
          assert.deepEqual((await readdir(dir)).sort(), names, 'No alias lock or backup may be created');
        }
      }
    });
}
