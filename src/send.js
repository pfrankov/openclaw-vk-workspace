import { extname } from 'node:path';
import { TeamsApi, identifier, identifiers } from './api.js';
import { CHANNEL_ID, isRecord, normalizeId, resolveAccount } from './config.js';
import { loadOutboundMedia } from './media.js';
import { getRuntime } from './runtime.js';
import { formatText } from './format.js';
import { nativeChunks, validateNativeFormat } from './rich-format.js';
import { normalizeButtons, prepareKeyboard } from './keyboard.js';
import { getMessageStore } from './message-store.js';
export { chunkText } from './format.js';

export function channelData(payload) {
  const data = payload.channelData?.[CHANNEL_ID] ?? {};
  if (!isRecord(data) || Object.keys(data).some((key) => !['buttons', 'fileId', 'voice', 'textFormat', 'buttonOwnerId', 'forward', 'replyToIds', 'format'].includes(key))) throw new Error('Invalid VK Workspace channelData');
  normalizeButtons(data.buttons);
  if (data.replyToIds !== undefined) identifiers(data.replyToIds);
  if (data.forward && data.replyToIds) throw new Error('Forwarding and replying are mutually exclusive');
  if (data.format !== undefined) {
    validateNativeFormat(payload.text, data.format);
    if (data.textFormat === 'markdown') throw new Error('Native format requires literal text, not Markdown');
  }
  if (data.forward !== undefined) {
    if (!isRecord(data.forward) || Object.keys(data.forward).some((key) => !['chatId', 'messageIds'].includes(key))) throw new Error('Invalid forwarding parameters');
    identifier(data.forward.chatId); identifiers(data.forward.messageIds);
  }
  if (data.fileId !== undefined && (typeof data.fileId !== 'string' || !data.fileId || data.fileId.length > 1024 || /[\s\x00-\x1f\x7f]/.test(data.fileId))) throw new Error('Invalid fileId');
  if (data.voice !== undefined && typeof data.voice !== 'boolean') throw new Error('voice must be a boolean');
  if (data.textFormat !== undefined && !['plain', 'markdown'].includes(data.textFormat)) throw new Error('Invalid textFormat');
  if (data.buttonOwnerId !== undefined && (typeof data.buttonOwnerId !== 'string' || !data.buttonOwnerId.trim())) throw new Error('Invalid button owner');
  return data;
}
function context(to, options) {
  const core = options.core ?? getRuntime().core;
  const cfg = options.cfg ?? core.config.current();
  const account = options.account ?? resolveAccount(cfg, options.accountId);
  if (!account.enabled) throw new Error('VK Workspace account is disabled');
  const target = normalizeId(to);
  if (!target || /[\x00-\x20\x7f]/.test(target)) throw new Error('Invalid VK Teams chat id');
  return { core, cfg, account, target, api: options.api ?? new TeamsApi(account),
    store: options.messageStore ?? getMessageStore(core, account) };
}
export async function beforePlatformAction(options) {
  options.signal?.throwIfAborted();
  await options.onPlatformSendDispatch?.();
  options.signal?.throwIfAborted();
  options.assertDirectAdapterHandoff?.();
}
function deliveryError(results, attempted) {
  const error = new Error('VK Workspace delivery failed; inspect the conversation before retrying');
  error.noRetry = true; error.mayHaveSent = attempted;
  if (results.length) Object.assign(error, { code: 'CHANNEL_PARTIAL_DELIVERY', sentBeforeError: true, visibleReplySent: true,
    deliveryResult: { visibleReplySent: true, messageIds: results.map((result) => result.messageId) } });
  return error;
}
const supportsVoice = (file) => ['.aac', '.ogg', '.m4a'].includes(extname(file.fileName || '').toLowerCase()) ||
  ['audio/aac', 'audio/ogg', 'audio/mp4'].includes(file.contentType?.split(';')[0]);
export async function sendPayload(to, payload, options = {}) {
  const data = channelData(payload);
  const { core, account, target, api, store } = context(to, options);
  if (options.threadId !== undefined && options.threadId !== null && normalizeId(options.threadId) !== target) {
    throw new Error('Use the native thread id as the message target; a parent-chat fallback is not allowed');
  }
  if (data.forward && (!options.forwardAuthorized || account.config.actions?.forward !== true)) throw new Error('Native forwarding requires an authorized message-tool invocation and actions.forward');
  if (data.forward && (payload.replyToId != null || options.replyToId != null)) throw new Error('Forwarding and replying are mutually exclusive');
  const sources = [...new Set([...(payload.mediaUrls ?? []), ...(payload.mediaUrl ? [payload.mediaUrl] : [])])];
  if (data.fileId && sources.length) throw new Error('fileId and media URLs are mutually exclusive');
  if (sources.length > 10) throw new Error('At most 10 outgoing attachments are supported');
  const wantVoice = !options.forceDocument && (data.voice ?? payload.audioAsVoice ?? options.audioAsVoice ?? false);
  if (wantVoice && sources.length + (data.fileId ? 1 : 0) !== 1) throw new Error('A voice message requires exactly one attachment');
  const prepared = [];
  // Resolve and validate all attachments before the first send to reduce partial delivery.
  let totalBytes = 0;
  for (const source of sources) {
    const file = await loadOutboundMedia(source, { account, core, signal: options.signal, mediaLocalRoots: options.mediaLocalRoots });
    totalBytes += file.buffer.byteLength;
    if (totalBytes > 100 * 1024 * 1024) throw new Error('Outgoing attachments exceed the 100 MB total limit');
    prepared.push(file);
  }
  const voice = wantVoice && (data.fileId || supportsVoice(prepared[0]));
  const media = data.fileId ? [undefined] : prepared;
  const limit = media.length && !voice ? 1024 : 4096;
  const chunks = data.format === undefined
    ? formatText(payload.text, { mode: data.textFormat ?? account.config.textFormat ?? 'markdown', limit })
    : nativeChunks(payload.text, data.format, limit);
  const parts = media.map((file, index) => ({ kind: voice ? 'voice' : 'file', file,
    ...(index === 0 && !voice && chunks.length ? chunks.shift() : {}) }));
  parts.push(...chunks.map((chunk) => ({ kind: 'text', ...chunk })));
  if (!parts.length && data.forward) parts.push({ kind: 'text', text: '' });
  if (!parts.length && data.buttons?.length) throw new Error('Buttons require text or an attachment');
  const menu = prepareKeyboard(data.buttons, options.requesterSenderId ?? data.buttonOwnerId);
  const results = [];
  let attempted = false;
  let replyToId = data.replyToIds ?? payload.replyToId ?? options.replyToId;
  try {
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      const keyboard = index === parts.length - 1 ? menu : {};
      await beforePlatformAction(options);
      attempted = true;
      const params = { signal: options.signal, replyToId, parseMode: part.parseMode, format: part.format, inlineKeyboardMarkup: keyboard.keyboard, fileId: data.fileId,
        ...(index === 0 && data.forward ? { forwardChatId: data.forward.chatId, forwardMessageIds: data.forward.messageIds } : {}) };
      const result = part.kind === 'text' ? await api.sendText(target, part.text, params)
        : part.kind === 'voice' ? await api.sendVoice(target, part.file, params)
        : await api.sendFile(target, part.file, { ...params, caption: part.text });
      const receipt = { channel: CHANNEL_ID, ...result };
      results.push(receipt);
      await options.onDeliveryResult?.(receipt);
      await store.remember(target, result.messageId, { kind: index === 0 && data.forward ? 'forward' : part.kind, text: part.text, parseMode: part.parseMode, format: part.format,
        keyboard: keyboard.keyboard, callbacks: keyboard.callbacks ?? [], requesterId: options.requesterSenderId });
      replyToId = undefined;
    }
  } catch (error) {
    if (!attempted) throw error;
    throw deliveryError(results, attempted);
  }
  return results.length ? { ...results.at(-1), messageIds: results.map((result) => result.messageId) }
    : { channel: CHANNEL_ID, chatId: target, messageId: '' };
}
export async function editMessage(to, messageId, payload, options = {}) {
  const data = channelData(payload);
  if (typeof messageId !== 'string' || !messageId.trim()) throw new Error('A messageId is required for editing');
  if (data.forward || data.replyToIds) throw new Error('Forwarding and reply references cannot be edited');
  if (data.fileId || payload.mediaUrl || payload.mediaUrls?.length || data.voice) throw new Error('Editing supports text and buttons, not attachments');
  const { account, target, api, store } = context(to, options);
  const chunks = payload.text === undefined ? undefined : data.format === undefined
    ? formatText(payload.text, { mode: data.textFormat ?? account.config.textFormat ?? 'markdown' })
    : nativeChunks(payload.text, data.format);
  if (chunks && chunks.length !== 1) throw new Error('An edit must fit one non-empty message; it is never truncated');
  await store.edit(target, messageId, async (entry) => {
    if (options.requesterSenderId && entry.requesterId && options.requesterSenderId !== entry.requesterId && !options.senderIsOwner) throw new Error('Cannot edit another sender\'s bot reply');
    const body = chunks?.[0] ?? { text: entry.text, parseMode: entry.parseMode, format: entry.format };
    const menu = data.buttons === undefined ? { keyboard: entry.keyboard, callbacks: entry.callbacks }
      : prepareKeyboard(data.buttons, options.requesterSenderId ?? entry.requesterId ?? data.buttonOwnerId);
    await beforePlatformAction(options);
    try { await api.editText(target, messageId, body.text, { ...body, signal: options.signal, inlineKeyboardMarkup: menu.keyboard }); }
    catch { throw Object.assign(new Error('VK Workspace edit failed; inspect the message before retrying'), { editAttempted: true, noRetry: true }); }
    return { ...body, parseMode: body.parseMode, format: body.format, ...menu };
  });
  return { channel: CHANNEL_ID, chatId: target, messageId };
}
