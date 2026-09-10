import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const dir = await mkdtemp(join(tmpdir(), 'vk-workspace-pack-'));
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { encoding: 'utf8' }));
  const paths = pack.files.map((file) => file.path);
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  for (const path of ['package.json', 'openclaw.plugin.json', 'README.md', 'CHANGELOG.md', 'LICENSE',
    ...pkg.openclaw.extensions, pkg.openclaw.setupEntry]) assert(paths.includes(path.replace(/^\.\//, '')), `Missing ${path}`);
  for (const path of paths) assert(/^(dist\/[^/]+\.js|package\.json|openclaw\.plugin\.json|README\.md|CHANGELOG\.md|LICENSE)$/.test(path), `Unexpected package file: ${path}`);
  // Check actual compressed bytes as well as npm's file list, not merely a dry-run.
  const tar = gunzipSync(await readFile(join(dir, pack.filename)));
  const contents = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length);
    contents.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (const path of paths) assert(contents.has(`package/${path}`), `Archive missing ${path}`);
  for (const path of paths.filter((path) => path.startsWith('dist/'))) {
    const text = contents.get(`package/${path}`).toString();
    for (const [, dependency] of text.matchAll(/from ['"]\.\/([^'"]+)['"]/g)) {
      assert(contents.has(`package/dist/${dependency}`), `Unpackaged dependency: ${dependency}`);
    }
  }
  console.log(`Verified ${pack.filename}: ${paths.length} files; no source, tests, credentials or dependencies bundled`);
} finally { await rm(dir, { recursive: true, force: true }); }
