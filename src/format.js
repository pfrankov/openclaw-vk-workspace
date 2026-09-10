// A deliberately small Markdown subset. Unsupported constructs stay readable as literal text.
const MAX_TEXT = 1024 * 1024;
const escapeHtml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function safeLink(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\x00-\x20\x7f]/.test(value)) return false;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
export function chunkText(text, limit = 4096) {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error('Invalid text chunk limit');
  const chunks = [];
  let rest = String(text ?? '');
  while (rest.length > limit) {
    let end = limit;
    if (/^[\uDC00-\uDFFF]$/.test(rest[end]) && /[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    const boundary = rest.lastIndexOf('\n', end - 1);
    if (boundary > end / 2) end = boundary + 1;
    chunks.push(rest.slice(0, end)); rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
function inline(text, tags = [], depth = 0) {
  if (depth >= 8) return [{ text, tags }];
  const runs = [];
  let plain = '';
  const flush = () => { if (plain) { runs.push({ text: plain, tags }); plain = ''; } };
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && /[\\`*_~\[\]()]/.test(text[i + 1] ?? '')) { plain += text[i + 1]; i += 2; continue; }
    if (text[i] === '`') {
      const ticks = text.slice(i).match(/^`+/)[0];
      const end = text.indexOf(ticks, i + ticks.length);
      if (end > i + ticks.length) { flush(); runs.push({ text: text.slice(i + ticks.length, end), tags: [...tags, ['<code>', '</code>']] }); i = end + ticks.length; continue; }
    }
    if (text[i] === '[') {
      const match = /^\[([^\[\]\n]+)\]\(([^\s)]+)\)/.exec(text.slice(i));
      if (match && safeLink(match[2])) {
        flush(); runs.push(...inline(match[1], [...tags, [`<a href="${escapeHtml(match[2])}">`, '</a>']], depth + 1)); i += match[0].length; continue;
      }
    }
    let matched = false;
    for (const [marker, tag] of [['**', 'b'], ['__', 'b'], ['~~', 's'], ['*', 'i'], ['_', 'i']]) {
      if (!text.startsWith(marker, i) || /\s/.test(text[i + marker.length] ?? ' ')) continue;
      // Do not interpret underscores inside identifiers as emphasis.
      if (marker.includes('_') && /[\p{L}\p{N}]/u.test(text[i - 1] ?? '')) continue;
      const end = text.indexOf(marker, i + marker.length);
      if (end <= i + marker.length || /\s/.test(text[end - 1])) continue;
      flush(); runs.push(...inline(text.slice(i + marker.length, end), [...tags, [`<${tag}>`, `</${tag}>`]], depth + 1));
      i = end + marker.length; matched = true; break;
    }
    if (!matched) plain += text[i++];
  }
  flush(); return runs;
}
function markdownRuns(text) {
  const runs = [];
  let fence;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n?$/.exec(line);
    if (fence) {
      if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
      else runs.push({ text: line, tags: [['<pre>', '</pre>']] });
      continue;
    }
    if (opening) { fence = opening[1]; continue; }
    const heading = /^ {0,3}#{1,6} (.*?)(\n?)$/.exec(line);
    runs.push(...inline(heading ? heading[1] + heading[2] : line, heading ? [['<b>', '</b>']] : []));
  }
  return runs;
}
export function formatText(value, { mode = 'markdown', limit = 4096 } = {}) {
  const text = String(value ?? '');
  if (text.length > MAX_TEXT) throw new Error('Message exceeds the supported text size');
  if (mode === 'plain') return chunkText(text, limit).map((text) => ({ text }));
  if (mode !== 'markdown' || !Number.isSafeInteger(limit) || limit < 64) throw new Error('Invalid text format or chunk limit');
  const chunks = [];
  let body = '', active = [];
  const close = () => active.toReversed().map((tag) => tag[1]).join('');
  const finish = () => { if (body) chunks.push({ text: body + close(), parseMode: 'HTML' }); body = ''; active = []; };
  for (const run of markdownRuns(text)) {
    for (const char of run.text) {
      const encoded = escapeHtml(char);
      let shared = 0;
      while (shared < active.length && shared < run.tags.length && active[shared][0] === run.tags[shared][0]) shared++;
      let transition = active.slice(shared).toReversed().map((tag) => tag[1]).join('') + run.tags.slice(shared).map((tag) => tag[0]).join('');
      const closing = run.tags.toReversed().map((tag) => tag[1]).join('');
      if ((body + transition + encoded + closing).length > limit) {
        finish(); transition = run.tags.map((tag) => tag[0]).join('');
      }
      if ((transition + encoded + closing).length > limit) throw new Error('Formatting exceeds the message chunk limit');
      body += transition + encoded; active = run.tags;
    }
  }
  finish(); return chunks;
}
