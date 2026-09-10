import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = pkg.openclaw.build.openclawVersion;
const host = join(root, '.tmp', 'host-deps');
await mkdir(host, { recursive: true });
// A required dependency in an isolated fixture cannot be silently skipped as an optional peer.
await writeFile(join(host, 'package.json'), JSON.stringify({ private: true, dependencies: { openclaw: version } }, null, 2) + '\n');
const args = ['install', '--prefix', host, '--ignore-scripts', '--no-audit', '--no-fund'];
if (process.env.npm_execpath) execFileSync(process.execPath, [process.env.npm_execpath, ...args], { stdio: 'inherit' });
else execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { stdio: 'inherit' });
const installed = join(host, 'node_modules', 'openclaw');
const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
if (metadata.version !== version) throw new Error(`Expected OpenClaw ${version}, got ${metadata.version}`);
await mkdir(join(root, 'node_modules'), { recursive: true });
await rm(join(root, 'node_modules', 'openclaw'), { recursive: true, force: true });
await symlink(installed, join(root, 'node_modules', 'openclaw'), 'junction');
console.log(`Installed required OpenClaw ${version} SDK fixture`);
