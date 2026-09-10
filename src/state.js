import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export function resolveStateDir(core) {
  if (typeof core.state?.resolveStateDir === 'function') return core.state.resolveStateDir();
  const configured = process.env.OPENCLAW_STATE_DIR;
  return configured ? resolve(configured.replace(/^~(?=$|\/)/, homedir())) : join(homedir(), '.openclaw');
}
export async function syncDirectory(path) {
  // Node cannot portably open/fsync directories on Windows. Never suppress POSIX I/O failures.
  if (process.platform === 'win32') return;
  const dir = await open(path, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
export async function atomicWrite(path, text, syncDir = syncDirectory) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    await syncDir(dirname(path));
  } finally { await rm(temp, { force: true }); }
}
