import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBounded } from './api.js';
import { ProcessingFailure } from './processing-failure.js';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.zip': 'application/zip' };
const AUDIO_EXTENSION = { 'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/aac': '.aac',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav', 'audio/webm': '.webm' };
const AUDIO_MIME_ALIAS = { 'application/ogg': 'audio/ogg', 'audio/mp3': 'audio/mpeg',
  'audio/x-aac': 'audio/aac', 'audio/x-m4a': 'audio/mp4', 'audio/x-mpeg': 'audio/mpeg',
  'audio/x-opus+ogg': 'audio/ogg', 'audio/x-wav': 'audio/wav', 'audio/vnd.wave': 'audio/wav' };
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
    throw new ProcessingFailure('media-download', 'untrusted-origin',
      `Media download failed: origin ${url.origin} is not allowed; add it to mediaAllowedOrigins`);
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
        if (!location) throw new ProcessingFailure('media-download', 'invalid-redirect', 'Media redirect has no destination');
        next = new URL(location, url).href;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new ProcessingFailure('media-download', 'http-rejected',
        `Media server rejected the download (HTTP ${response.status})`); }
      let buffer;
      try { buffer = await readBounded(response, maxBytesFor(account)); }
      catch (error) {
        if (error?.message === 'Response exceeds the configured size limit') {
          throw new ProcessingFailure('media-download', 'size-limit', 'Media download exceeds mediaMaxMb');
        }
        throw error;
      }
      return { buffer,
        contentType: response.headers.get('content-type')?.split(';')[0], fileName: safeFileName(url.pathname) };
    }
    throw new ProcessingFailure('media-download', 'redirect-limit', 'Media download exceeded the redirect limit');
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
    if (error instanceof ProcessingFailure) throw error;
    if (controller.signal.aborted) throw new ProcessingFailure('media-download', 'timeout', 'Media download timed out');
    throw new ProcessingFailure('media-download', 'network-or-tls', 'Media download failed; check DNS, routing and TLS');
  } finally { clearTimeout(timer); }
}

function sniffAudio(buffer) {
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buffer.length >= 8 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4';
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm';
}

export function normalizeVoiceMedia({ buffer, fileName, contentType, declaredType }) {
  const name = safeFileName(fileName || 'voice');
  const declaredMime = typeof declaredType === 'string' && declaredType.includes('/') ? declaredType.split(';')[0] : undefined;
  const extensionMime = MIME[extname(name).toLowerCase()];
  const canonical = (value) => {
    const normalized = value?.trim().toLowerCase();
    const candidate = AUDIO_MIME_ALIAS[normalized] ?? normalized;
    return AUDIO_EXTENSION[candidate] ? candidate : undefined;
  };
  const mime = [contentType?.split(';')[0], declaredMime, extensionMime].map(canonical).find(Boolean) ?? sniffAudio(buffer);
  if (!mime || !AUDIO_EXTENSION[mime]) throw new ProcessingFailure('media-normalize', 'unsupported-audio',
    'Voice attachment format could not be identified');
  const suffix = AUDIO_EXTENSION[mime];
  const normalizedName = AUDIO_EXTENSION[extensionMime] === suffix ? name : `${name}${suffix}`;
  return { contentType: mime, fileName: normalizedName };
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
  if (files.length > 10) throw new ProcessingFailure('media-metadata', 'attachment-limit',
    'At most 10 attachments per message are supported');
  const media = [];
  for (const part of files) {
    let info;
    try { info = await api.getFileInfo(part.payload.fileId, { signal }); }
    catch { throw new ProcessingFailure('media-metadata', 'api-failed', 'files/getInfo failed for the attachment'); }
    if (typeof info.url !== 'string' || (typeof info.size === 'number' && info.size > maxBytesFor(account))) {
      throw new ProcessingFailure('media-metadata', 'invalid', 'Attachment metadata is invalid or exceeds the size limit (mediaMaxMb)');
    }
    // Do not forward signed URLs into the model context. Materialize into the host media store first.
    const fetched = await downloadTrusted(info.url, account, signal);
    let fileName = safeFileName(info.filename || fetched.fileName);
    let contentType = fetched.contentType || MIME[extname(fileName).toLowerCase()] || 'application/octet-stream';
    if (part.type === 'voice') ({ fileName, contentType } = normalizeVoiceMedia({ buffer: fetched.buffer, fileName,
      contentType, declaredType: info.type }));
    let saved;
    try { saved = await core.channel.media.saveMediaBuffer(fetched.buffer, contentType, 'inbound', maxBytesFor(account), fileName); }
    catch { throw new ProcessingFailure('media-store', 'write-failed', 'OpenClaw could not store the inbound attachment'); }
    media.push({ path: saved.path, contentType: saved.contentType || contentType, fileName,
      kind: part.type === 'voice' ? 'audio' : part.type === 'sticker' ? 'sticker'
        : contentType.startsWith('image/') ? 'image' : contentType.startsWith('audio/') ? 'audio'
          : contentType.startsWith('video/') ? 'video' : 'document' });
  }
  return media;
}
