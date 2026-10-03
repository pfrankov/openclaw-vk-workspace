import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A tag created in the GitHub release form already has a release. Reuse it only
// when it matches this checked-out release; never overwrite notes or assets.
export function ensureGitHubRelease({ phase, tag, head, notesPath, notes, repository }, run = execFileSync) {
  assert(['check', 'create'].includes(phase), 'Expected check or create');
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  assert.equal(run('git', ['rev-parse', `${tag}^{commit}`], options).trim(), head, 'Tag must resolve to HEAD');
  // The by-tag endpoint hides drafts. List every page so a draft is rejected
  // before npm publication rather than mistaken for a missing release.
  const pages = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases`], options));
  assert(Array.isArray(pages) && pages.every((page) => Array.isArray(page)), 'Invalid release listing');
  const releases = pages.flat();
  assert(releases.every((release) => release && typeof release.tag_name === 'string'), 'Invalid release metadata');
  const matches = releases.filter((release) => release.tag_name === tag);
  assert(matches.length <= 1, 'Ambiguous release tag');
  const [release] = matches;
  if (release !== undefined) {
    assert.equal(release.tag_name, tag, 'Release tag mismatch');
    assert.equal(release.target_commitish, head, 'Existing release must target this exact commit');
    assert.equal(release.name, tag, 'Release title mismatch');
    assert.equal(release.draft, false, 'Existing release must be published');
    assert.equal(release.body.trimEnd(), notes.trimEnd(), 'Existing release notes differ; refusing to overwrite');
    return 'existing';
  }
  if (phase === 'create') {
    run('gh', ['release', 'create', tag, '--repo', repository, '--verify-tag', '--target', head,
      '--title', tag, '--notes-file', notesPath], options);
    return 'created';
  }
  return 'missing';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [phase, notesPath] = process.argv.slice(2);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  console.log(ensureGitHubRelease({ phase, notesPath, notes: readFileSync(notesPath, 'utf8'),
    tag: process.env.GITHUB_REF_NAME, repository: process.env.GH_REPO, head }));
}
