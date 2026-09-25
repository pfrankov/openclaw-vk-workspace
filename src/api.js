import { normalizeBaseUrl } from './config.js';
import { formatParameters } from './rich-format.js';

const ENDPOINTS = new Set(['self/get', 'events/get', 'files/getInfo', 'chats/getInfo',
  'messages/sendText', 'messages/sendFile', 'messages/sendVoice', 'messages/editText',
  'messages/deleteMessages', 'messages/answerCallbackQuery', 'chats/sendActions',
  'chats/getAdmins', 'chats/getMembers', 'chats/pinMessage', 'chats/unpinMessage',
  'chats/setTitle', 'chats/setAbout', 'chats/setRules', 'threads/add',
  'threads/autosubscribe', 'threads/subscribers/get']);

export class ApiError extends Error {
  constructor(endpoint, kind, status) {
    super(`VK Teams ${endpoint}: ${kind}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'VkTeamsApiError';
    this.status = status;
    this.kind = kind;
  }
}

export async function readBounded(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Response exceeds the configured size limit');
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error('Response exceeds the configured size limit');
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks, size);
}

export class TeamsApi {
  #token;
  #fetch;
  constructor(account, fetchImpl = globalThis.fetch) {
    if (!account.token?.trim()) throw new Error('VK Workspace bot token is missing');
    this.baseUrl = normalizeBaseUrl(account.baseUrl, account.config?.allowInsecureHttp);
    this.timeoutMs = account.config?.requestTimeoutMs ?? 30000;
    this.#token = account.token.trim();
    this.#fetch = fetchImpl;
  }
  async request(endpoint, params = {}, { signal, timeoutMs = this.timeoutMs, file } = {}) {
    if (!ENDPOINTS.has(endpoint)) throw new Error('Unsupported VK Teams endpoint');
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || key === 'token') continue;
      const values = ['inlineKeyboardMarkup', 'format'].includes(key) ? [JSON.stringify(value)] : Array.isArray(value) ? value : [value];
      for (const item of values) {
        url.searchParams.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
      }
    }
    // Authentication and every non-file parameter stay in the query, including multipart uploads.
    url.searchParams.set('token', this.#token);
    let body;
    if (file) {
      body = new FormData();
      body.append('file', new Blob([file.buffer], { type: file.contentType || 'application/octet-stream' }), file.fileName);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const response = await this.#fetch(url, { method: file ? 'POST' : 'GET', body,
        signal: combined, redirect: 'manual', headers: { Accept: 'application/json' } });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(endpoint, response.status === 429 ? 'rate limited' : 'request rejected', response.status);
      }
      let data;
      try { data = JSON.parse((await readBounded(response, 8 * 1024 * 1024)).toString('utf8')); }
      catch { throw new ApiError(endpoint, 'invalid or oversized JSON response'); }
      // Some installations omit ok for metadata. Explicit errors always fail, even with HTTP 200.
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.ok === false ||
          (data.ok !== true && (data.description || data.error))) {
        throw new ApiError(endpoint, 'API rejected request; check token, permissions and parameters');
      }
      return data;
    } catch (error) {
      // Never attach raw fetch errors, response descriptions or URLs: they can contain the token.
      if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
      if (controller.signal.aborted) throw new ApiError(endpoint, 'request timed out');
      if (error instanceof ApiError) throw error;
      throw new ApiError(endpoint, controller.signal.aborted ? 'request timed out' : 'network request failed');
    } finally { clearTimeout(timer); }
  }
  async getSelf(options) {
    const result = await this.request('self/get', {}, options);
    if (typeof result.userId !== 'string' || !result.userId.trim()) throw new ApiError('self/get', 'missing bot userId');
    return result;
  }
  async getEvents(lastEventId, pollTime, options = {}) {
    const result = await this.request('events/get', { lastEventId, pollTime },
      { ...options, timeoutMs: Math.max(this.timeoutMs, (pollTime + 10) * 1000) });
    if (result.ok !== true || !Array.isArray(result.events)) throw new ApiError('events/get', 'missing events array');
    return result.events;
  }
  async sendText(chatId, text, options = {}) {
    const result = await this.request('messages/sendText', { chatId, text, ...messageReferences(options),
      ...formatParameters(text, options), inlineKeyboardMarkup: options.inlineKeyboardMarkup }, { signal: options.signal });
    return messageResult(result, chatId);
  }
  async sendFile(chatId, file, options = {}) { return this.sendMedia('sendFile', chatId, file, options); }
  async sendVoice(chatId, file, options = {}) { return this.sendMedia('sendVoice', chatId, file, options); }
  async sendMedia(method, chatId, file, options) {
    if (Boolean(file) === Boolean(options.fileId)) throw new Error('Provide exactly one of file or fileId');
    const result = await this.request(`messages/${method}`, { chatId, fileId: options.fileId,
      ...(method === 'sendFile' ? { caption: options.caption, ...formatParameters(options.caption ?? '', options) } : {}),
      ...messageReferences(options), inlineKeyboardMarkup: options.inlineKeyboardMarkup }, { signal: options.signal, file });
    return { ...messageResult(result, chatId), ...(typeof result.fileId === 'string' ? { fileId: result.fileId } : {}) };
  }
  async editText(chatId, msgId, text, options = {}) {
    const result = await this.request('messages/editText', { chatId, msgId, text,
      ...formatParameters(text, options), inlineKeyboardMarkup: options.inlineKeyboardMarkup }, { signal: options.signal });
    if (result.ok !== true) throw new ApiError('messages/editText', 'missing success confirmation');
    return { messageId: String(msgId), chatId };
  }
  async answerCallbackQuery(queryId, text, options = {}) {
    // Use the verified n8n contract: text, not the PHP client's textAnswer parameter.
    if (options.showAlert !== undefined && typeof options.showAlert !== 'boolean') throw new Error('showAlert must be a boolean');
    const result = await this.request('messages/answerCallbackQuery', { queryId, text, showAlert: options.showAlert }, { signal: options.signal });
    if (result.ok !== true) throw new ApiError('messages/answerCallbackQuery', 'missing success confirmation');
  }
  async confirmed(endpoint, params, options) {
    const result = await this.request(endpoint, params, options);
    if (result.ok !== true) throw new ApiError(endpoint, 'missing success confirmation');
  }
  deleteMessages(chatId, messageIds, options) {
    return this.confirmed('messages/deleteMessages', { chatId: identifier(chatId), msgId: identifiers(messageIds, 100) }, options);
  }
  pinMessage(chatId, msgId, options) {
    return this.confirmed('chats/pinMessage', { chatId: identifier(chatId), msgId: identifier(msgId) }, options);
  }
  unpinMessage(chatId, msgId, options) {
    return this.confirmed('chats/unpinMessage', { chatId: identifier(chatId), msgId: identifier(msgId) }, options);
  }
  async getChatInfo(chatId, options) {
    const result = await this.request('chats/getInfo', { chatId: identifier(chatId) }, options);
    if (!['private', 'group', 'channel'].includes(result.type)) throw new ApiError('chats/getInfo', 'invalid chat type');
    return result;
  }
  async getChatMembers(chatId, cursor, options) {
    const endpoint = 'chats/getMembers';
    const result = await this.request(endpoint, { chatId: identifier(chatId), cursor: pageCursor(cursor) }, options);
    validatePage(result, 'members', 'userId', endpoint);
    return result;
  }
  async getChatAdmins(chatId, options) {
    const result = await this.request('chats/getAdmins', { chatId: identifier(chatId) }, options);
    validatePage(result, 'admins', 'userId', 'chats/getAdmins');
    return result;
  }
  setChatField(chatId, field, value, options) {
    const methods = { title: 'setTitle', about: 'setAbout', rules: 'setRules' };
    if (!Object.hasOwn(methods, field) || typeof value !== 'string' || value.length > (field === 'title' ? 256 : 4096) ||
        (field === 'title' && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Invalid chat update');
    return this.confirmed(`chats/${methods[field]}`, { chatId: identifier(chatId), [field]: value }, options);
  }
  async addThread(chatId, msgId, options) {
    const result = await this.request('threads/add', { chatId: identifier(chatId), msgId: identifier(msgId) }, options);
    try { identifier(result.threadId); }
    catch { throw new ApiError('threads/add', 'missing threadId'); }
    return { threadId: result.threadId };
  }
  autoSubscribeThreads(chatId, enable, withExisting = false, options) {
    if (typeof enable !== 'boolean' || typeof withExisting !== 'boolean' || (!enable && withExisting)) {
      throw new Error('Invalid thread subscription options');
    }
    return this.confirmed('threads/autosubscribe', { chatId: identifier(chatId), enable, withExisting }, options);
  }
  async getThreadSubscribers(threadId, cursor, options) {
    const endpoint = 'threads/subscribers/get';
    const result = await this.request(endpoint, { threadId: identifier(threadId), cursor: pageCursor(cursor),
      ...(!cursor ? { pageSize: 100 } : {}) }, options);
    validatePage(result, 'subscribers', 'sn', endpoint);
    return result;
  }
  getFileInfo(fileId, options) { return this.request('files/getInfo', { fileId }, options); }
  sendActions(chatId, actions, options) {
    if (!Array.isArray(actions) || actions.length > 2 || new Set(actions).size !== actions.length ||
        actions.some((action) => !['typing', 'looking'].includes(action))) throw new Error('Invalid chat activities');
    return this.confirmed('chats/sendActions', { chatId: identifier(chatId), actions: actions.length ? actions : '' }, options);
  }
  sendTyping(chatId, options) { return this.sendActions(chatId, ['typing'], options); }
  stopTyping(chatId, options) { return this.sendActions(chatId, [], options); }
}
function messageResult(result, chatId) {
  if (result.ok !== true || !['string', 'number'].includes(typeof result.msgId) || !String(result.msgId).trim() ||
      (typeof result.msgId === 'number' && !Number.isSafeInteger(result.msgId))) {
    throw new ApiError('messages/send', 'missing message id');
  }
  return { messageId: String(result.msgId), chatId };
}

export function eventId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe event id');
  const id = String(value);
  if (!/^\d+$/.test(id)) throw new Error('Invalid event id');
  return BigInt(id).toString();
}

// Native ids are opaque strings, never social VK numeric ids. Limits here are
// local safety bounds, not claims about every server's configured limits.
export function identifier(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\x00-\x20\x7f]/.test(value)) throw new Error('Invalid VK Teams identifier');
  return value;
}
export function identifiers(value, max = 20) {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new Error(`Expected 1 to ${max} message ids`);
  const ids = value.map(identifier);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate message ids');
  return ids;
}
export function pageCursor(value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid pagination cursor');
  return value;
}
function validatePage(result, field, idField, endpoint) {
  try {
    if (!Array.isArray(result[field]) || result[field].length > 1000) throw new Error('invalid page');
    for (const item of result[field]) identifier(item?.[idField]);
    pageCursor(result.cursor);
  } catch { throw new ApiError(endpoint, 'invalid or oversized result page'); }
}
function messageReferences(options) {
  if (options.forwardChatId === undefined && options.forwardMessageIds === undefined) {
    const reply = options.replyToId;
    return { replyMsgId: reply == null ? undefined : Array.isArray(reply) ? identifiers(reply) : identifier(reply) };
  }
  if (options.replyToId !== undefined && options.replyToId !== null) throw new Error('Forwarding and replying are mutually exclusive');
  return { forwardChatId: identifier(options.forwardChatId), forwardMsgId: identifiers(options.forwardMessageIds) };
}
