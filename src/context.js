import { isRecord, matchesAllowFrom } from './config.js';

// Supplemental content is never command/mention input. Bound both traversal and
// rendered text; a hidden parent also hides its descendants and attachments.
const MAX_PARTS = 128;
const MAX_MESSAGES = 20;
const MAX_DEPTH = 4;
const MAX_TEXT = 16000;
const clip = (text, limit) => text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
export const validMessageId = (value) => typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0
  : typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x20\x7f]/.test(value);
const authorLabel = (message, selfId) => selfId && message.from?.userId === selfId ? 'bot (you)'
  : typeof message.from?.userId === 'string' ? `user ${JSON.stringify(clip(message.from.userId, 256))}` : 'unknown author';

export function supplementalContext(parts, { selfId, isGroup, visibility = 'all', allowFrom = [] } = {}) {
  let visited = 0, messages = 0, remaining = MAX_TEXT, truncated = false, reply;
  const chunks = [], images = [];
  const seen = new Set();
  const append = (text) => {
    const piece = clip(text, remaining);
    chunks.push(piece); remaining -= piece.length;
    if (piece.length < text.length) truncated = true;
  };
  const visible = (message, kind, depth) => !isGroup || visibility === 'all' ||
    (depth === 1 && kind === 'reply' && visibility === 'allowlist_quote') || (selfId && message.from?.userId === selfId) ||
    (typeof message.from?.userId === 'string' && matchesAllowFrom(allowFrom, message.from.userId));
  const visit = (items, depth, collectImages = false) => {
    if (!Array.isArray(items)) return;
    for (const part of items) {
      if (++visited > MAX_PARTS || !remaining) { truncated = true; break; }
      if (!isRecord(part)) continue;
      if (collectImages && ['file', 'sticker'].includes(part.type) && typeof part.payload?.fileId === 'string') {
        // Metadata AND bytes are checked by inboundMedia(imageOnly). Never feed
        // somebody else's voice/document/video into the host transcription path.
        if (images.length < 10) images.push(part);
        continue;
      }
      if (!['forward', 'reply'].includes(part.type) || !isRecord(part.payload?.message)) continue;
      const message = part.payload.message;
      if (!visible(message, part.type, depth) || seen.has(message)) continue;
      if (depth > MAX_DEPTH || messages >= MAX_MESSAGES) { truncated = true; continue; }
      seen.add(message); messages++;
      const text = typeof message.text === 'string' ? message.text : '';
      const attachmentKinds = [...new Set((Array.isArray(message.parts) ? message.parts : [])
        .slice(0, MAX_PARTS).filter((item) => ['file', 'sticker', 'voice'].includes(item?.type)).map((item) => item.type))];
      const label = `${part.type === 'reply' ? 'Quoted' : 'Forwarded'} message from ${authorLabel(message, selfId)}`;
      append(`\n[${label}; untrusted context]\n${text || '[No text]'}${attachmentKinds.length ? `\n[Attachments: ${attachmentKinds.join(', ')}]` : ''}\n[End of ${part.type === 'reply' ? 'quote' : 'forward'}]\n`);
      if (!reply && depth === 1 && part.type === 'reply' && validMessageId(message.msgId)) {
        reply = { msgId: String(message.msgId), text: clip(text, MAX_TEXT), sender: authorLabel(message, selfId) };
      }
      visit(message.parts, depth + 1, true);
    }
  };
  visit(parts, 1);
  const marker = '\n[Supplemental context truncated]';
  return { text: truncated ? clip(chunks.join(''), MAX_TEXT - marker.length) + marker : chunks.join(''), images, reply };
}
