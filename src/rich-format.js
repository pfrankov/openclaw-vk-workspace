import { isRecord } from './config.js';
import { chunkText, safeLink } from './format.js';

const STYLES = ['bold', 'italic', 'underline', 'strikethrough', 'link', 'mention',
  'inline_code', 'pre', 'ordered_list', 'unordered_list', 'quote'];
const rangeProperties = { offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1 } };
export const nativeFormatSchema = { type: 'object', additionalProperties: false,
  description: 'Native VK Teams format ranges in the literal message, using UTF-16 offsets. Do not combine with vkTextFormat=markdown.',
  properties: Object.fromEntries(STYLES.map((style) => [style, { type: 'array', maxItems: 100, items: {
    type: 'object', additionalProperties: false, required: ['offset', 'length', ...(style === 'link' ? ['url'] : [])],
    properties: { ...rangeProperties, ...(style === 'link' ? { url: { type: 'string', maxLength: 512 } } : {}),
      ...(style === 'pre' ? { language: { type: 'string', maxLength: 32 } } : {}) },
  } }])) };
const boundary = (text, at) => !(at > 0 && at < text.length &&
  /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]));
export function validateNativeFormat(text, format) {
  if (typeof text !== 'string' || text.length > 1024 * 1024 || !text.isWellFormed() || !isRecord(format)) throw new Error('Invalid native formatted text');
  const result = {};
  let count = 0;
  for (const [style, ranges] of Object.entries(format)) {
    if (!STYLES.includes(style) || !Array.isArray(ranges) || (count += ranges.length) > 100) throw new Error('Unsupported or oversized native format');
    result[style] = ranges.map((range) => {
      const extras = style === 'link' ? ['url'] : style === 'pre' ? ['language'] : [];
      if (!isRecord(range) || Object.keys(range).some((key) => !['offset', 'length', ...extras].includes(key)) ||
          !Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 || range.length < 1 ||
          range.offset + range.length > text.length || !boundary(text, range.offset) || !boundary(text, range.offset + range.length)) throw new Error('Invalid native format range');
      if (style === 'link' && !safeLink(range.url)) throw new Error('Native links require a credential-free HTTP(S) URL');
      if (range.language !== undefined && (typeof range.language !== 'string' || !/^[a-zA-Z0-9_+.-]{1,32}$/.test(range.language))) throw new Error('Invalid code language');
      return { ...range };
    });
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 16384) throw new Error('Native format exceeds the size limit');
  return result;
}
export function nativeChunks(text, format, limit = 4096) {
  const checked = validateNativeFormat(text, format);
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + chunkText(text.slice(start, start + limit + 2), limit)[0].length;
    // Never split a native mention into two independent notifications.
    for (;;) {
      const crossing = (checked.mention ?? []).filter((range) => range.offset < end && range.offset + range.length > end);
      if (!crossing.length) break;
      end = Math.min(...crossing.map((range) => range.offset));
      if (end <= start) throw new Error('A native mention must fit a single message chunk');
    }
    const part = {};
    for (const [style, ranges] of Object.entries(checked)) {
      const selected = ranges.filter((range) => range.offset < end && range.offset + range.length > start)
        .map((range) => ({ ...range, offset: Math.max(start, range.offset) - start,
          length: Math.min(end, range.offset + range.length) - Math.max(start, range.offset) }));
      if (selected.length) part[style] = selected;
    }
    chunks.push({ text: text.slice(start, end), ...(Object.keys(part).length ? { format: part } : {}) });
    start = end;
  }
  return chunks;
}
export function formatParameters(text, options) {
  if (options.format !== undefined) {
    if (options.parseMode !== undefined) throw new Error('format and parseMode are mutually exclusive');
    return { format: validateNativeFormat(text, options.format) };
  }
  return { parseMode: options.parseMode };
}
