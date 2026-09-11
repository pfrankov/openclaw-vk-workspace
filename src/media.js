import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBounded } from './api.js';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.zip': 'application/zip' };
export function safeFileName(value) {
  const name = basename(String(value || 'attachment.bin').replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '_').slice(0, 180);
  return !name || name === '.' || name === '..' ? 'attachment.bin' : name;
}
const maxBytesFor = (account) => account.config.mediaMaxMb * 1024 * 1024;
export function trustedMediaUrl(input, account) {
  const url = new URL(input);
  const origins = [new URL(account.baseUrl).origin, ...(account.config.mediaAllowedOrigins ?? [])];
  if (url.username || url.password || !origins.includes(url.origin) ||
      !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !account.config.allowInsecureHttp)) {
    throw new Error('Media URL is outside the configured trusted origins');
  }
  return url;
}

// Explicitly trusted on-prem origins may be private. No Bot API credentials are sent to downloads.
export async function downloadTrusted(input, account, signal, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), account.config.requestTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    let next = input;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const url = trustedMediaUrl(next, account);
      const response = await fetchImpl(url, { redirect: 'manual', signal: combined });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('Missing media redirect location');
        next = new URL(location, url).href;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('Media download rejected'); }
      return { buffer: await readBounded(response, maxBytesFor(account)),
        contentType: response.headers.get('content-type')?.split(';')[0], fileName: safeFileName(url.pathname) };
    }
    throw new Error('Too many media redirects');
  } catch {
    if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
    throw new Error('VK Workspace media download failed; check allowed origins, TLS and size limit');
  } finally { clearTimeout(timer); }
}

export async function readLocalMedia(input, roots, maxBytes) {
  const path = input.startsWith('file:') ? fileURLToPath(input) : input;
  const allowed = (await Promise.all((roots ?? []).map((root) => realpath(root).catch(() => null)))).filter(Boolean);
  if (!allowed.length) throw new Error('Local media requires OpenClaw-approved media roots');
  const inside = (candidate) => allowed.some((root) => candidate.startsWith(root.endsWith(sep) ? root : root + sep));
  for (const candidate of isAbsolute(path) ? [path] : allowed.map((root) => resolve(root, path))) {
    const resolved = await realpath(candidate).catch(() => null);
    if (!resolved || !inside(resolved)) continue;
    const file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error('Local media is not a regular file or exceeds the size limit');
      // Read from the validated descriptor with a cap, including files that grow after stat().
      const chunks = [];
      let size = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > maxBytes) throw new Error('Local media exceeds the size limit');
        chunks.push(chunk);
      }
      return { buffer: Buffer.concat(chunks, size), fileName: safeFileName(resolved),
        contentType: MIME[extname(resolved).toLowerCase()] || 'application/octet-stream' };
    } finally { await file.close(); }
  }
  throw new Error('Local media is missing or outside OpenClaw-approved media roots');
}

export async function loadOutboundMedia(input, { account, core, mediaLocalRoots, signal }) {
  signal?.throwIfAborted();
  let result;
  if (/^https?:\/\//i.test(input)) {
    let trusted = false;
    try { trustedMediaUrl(input, account); trusted = true; } catch { /* Public URLs use core SSRF policy. */ }
    if (trusted) result = await downloadTrusted(input, account, signal);
    else {
      try { result = await core.channel.media.fetchRemoteMedia({ url: input, maxBytes: maxBytesFor(account),
        ...(signal ? { requestInit: { signal } } : {}) }); }
      catch { throw new Error('Remote media was blocked or could not be downloaded'); }
    }
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !input.startsWith('file:') && !/^[a-z]:[\\/]/i.test(input)) {
      throw new Error('Unsupported media URL scheme');
    }
    result = await readLocalMedia(input, mediaLocalRoots, maxBytesFor(account));
  }
  signal?.throwIfAborted();
  if (!result?.buffer || result.buffer.byteLength > maxBytesFor(account)) throw new Error('Media exceeds the size limit');
  return { ...result, buffer: Buffer.from(result.buffer), fileName: safeFileName(result.fileName) };
}

export async function inboundMedia(parts, { api, account, core, signal }) {
  const files = parts.filter((part) => ['file', 'voice', 'sticker'].includes(part?.type) && typeof part.payload?.fileId === 'string');
  if (files.length > 10) throw new Error('At most 10 attachments per message are supported');
  const media = [];
  for (const part of files) {
    const info = await api.getFileInfo(part.payload.fileId, { signal });
    if (typeof info.url !== 'string' || (typeof info.size === 'number' && info.size > maxBytesFor(account))) {
      throw new Error('Attachment metadata is invalid or exceeds the size limit');
    }
    // Do not forward signed URLs into the model context. Materialize into the host media store first.
    const fetched = await downloadTrusted(info.url, account, signal);
    const fileName = safeFileName(info.filename || fetched.fileName);
    const contentType = fetched.contentType || MIME[extname(fileName).toLowerCase()] || 'application/octet-stream';
    const saved = await core.channel.media.saveMediaBuffer(fetched.buffer, contentType, 'inbound', maxBytesFor(account), fileName);
    media.push({ path: saved.path, contentType: saved.contentType || contentType, fileName,
      kind: part.type === 'voice' ? 'audio' : part.type === 'sticker' ? 'sticker'
        : contentType.startsWith('image/') ? 'image' : contentType.startsWith('audio/') ? 'audio'
          : contentType.startsWith('video/') ? 'video' : 'document' });
  }
  return media;
}
