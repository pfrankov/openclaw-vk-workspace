import { fileURLToPath } from 'node:url';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { channelSchema, CHANNEL_ID } from '../src/config.js';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
process.chdir(fileURLToPath(root));
const manifest = JSON.parse(await readFile('openclaw.plugin.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[''].version, pkg.version);
assert.equal(manifest.id, CHANNEL_ID);
assert.deepEqual(manifest.channels, [CHANNEL_ID]);
assert.equal(manifest.version, pkg.version);
assert.deepEqual(manifest.channelConfigs[CHANNEL_ID].schema, channelSchema, 'Update the manifest when changing channelSchema');
for (const name of await readdir('src')) {
  if (name.endsWith('.js')) execFileSync(process.execPath, ['--check', `src/${name}`], { stdio: 'inherit' });
}
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
await cp('src', 'dist', { recursive: true });
console.log(`Built ${pkg.name}@${pkg.version}`);
