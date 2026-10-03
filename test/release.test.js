import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureGitHubRelease } from '../scripts/github-release.mjs';

const head = 'a'.repeat(40);
const options = { phase: 'check', tag: 'v0.1.13', head, notes: 'Release notes\n',
  notesPath: '/fixture/NOTES.md', repository: 'pfrankov/openclaw-vk-workspace' };
const existing = { tag_name: options.tag, target_commitish: head, name: options.tag, draft: false,
  prerelease: true, body: options.notes, assets: [{ name: 'leave-unchanged' }] };
function fixture(value = [[existing]], tagHead = head) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git') return `${tagHead}\n`;
    if (args[0] === 'api') {
      if (value instanceof Error) throw value;
      return JSON.stringify(value);
    }
    return '';
  };
  return { calls, run };
}

for (const phase of ['check', 'create']) for (const prerelease of [true, false]) {
  test(`release ${phase} reuses matching ${prerelease ? 'prerelease' : 'stable release'} without writes`, () => {
    const f = fixture([[{ ...existing, prerelease }]]);
    assert.equal(ensureGitHubRelease({ ...options, phase }, f.run), 'existing');
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1], ['gh', 'api', '--paginate', '--slurp', `repos/${options.repository}/releases`]);
  });
}
for (const patch of [{ target_commitish: 'main' }, { target_commitish: 'b'.repeat(40) },
  { name: 'Unexpected title' }, { body: 'Different notes' }, { draft: true }]) {
  test(`release mismatch fails without overwrite: ${JSON.stringify(patch)}`, () => {
    const f = fixture([[{ ...existing, ...patch }]]);
    assert.throws(() => ensureGitHubRelease({ ...options, phase: 'create' }, f.run));
    assert.equal(f.calls.length, 2);
  });
}
test('only a missing release may be created, after the tag check', () => {
  const f = fixture([[]]);
  assert.equal(ensureGitHubRelease(options, f.run), 'missing');
  assert.equal(f.calls.length, 2);
  assert.equal(ensureGitHubRelease({ ...options, phase: 'create' }, f.run), 'created');
  assert.deepEqual(f.calls.at(-1), ['gh', 'release', 'create', options.tag, '--repo', options.repository,
    '--verify-tag', '--target', head, '--title', options.tag, '--notes-file', options.notesPath]);
});
test('unrelated releases are left unchanged', () => {
  const f = fixture([[{ ...existing, tag_name: 'v0.1.12' }]]);
  assert.equal(ensureGitHubRelease(options, f.run), 'missing');
  assert.equal(f.calls.length, 2);
});
test('tag mismatch, unexpected API errors and malformed metadata fail closed', () => {
  const wrongTag = fixture([[existing]], 'b'.repeat(40));
  assert.throws(() => ensureGitHubRelease(options, wrongTag.run), /Tag must resolve/);
  assert.equal(wrongTag.calls.length, 1);
  for (const value of [Object.assign(new Error('unavailable'), { stderr: 'gh: API rate limit exceeded (HTTP 403)' }),
    null, {}, [existing], [[null]], [[existing, existing]]]) {
    const f = fixture(value);
    assert.throws(() => ensureGitHubRelease({ ...options, phase: 'create' }, f.run));
    assert.equal(f.calls.length, 2);
  }
});

test('a draft on a later page is rejected before publication instead of treated as absent', () => {
  const f = fixture([[{ ...existing, tag_name: 'v0.1.12' }], [{ ...existing, draft: true }]]);
  assert.throws(() => ensureGitHubRelease(options, f.run), /must be published/);
  assert.equal(f.calls.length, 2);
});
