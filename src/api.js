import { normalizeBaseUrl } from './config.js';

const ENDPOINTS = new Set(['self/get', 'events/get', 'files/getInfo', 'chats/getInfo',
  'messages/sendText', 'messages/sendFile', 'messages/sendVoice', 'messages/editText',
  'messages/deleteMessages', 'messages/answerCallbackQuery', 'chats/sendActions']);

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
      const values = key === 'inlineKeyboardMarkup' ? [JSON.stringify(value)] : Array.isArray(value) ? value : [value];
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
    const result = await this.request('messages/sendText', { chatId, text, replyMsgId: options.replyToId,
      parseMode: options.parseMode, inlineKeyboardMarkup: options.inlineKeyboardMarkup }, { signal: options.signal });
    return messageResult(result, chatId);
  }
  async sendFile(chatId, file, options = {}) { return this.sendMedia('sendFile', chatId, file, options); }
  async sendVoice(chatId, file, options = {}) { return this.sendMedia('sendVoice', chatId, file, options); }
  async sendMedia(method, chatId, file, options) {
    if (Boolean(file) === Boolean(options.fileId)) throw new Error('Provide exactly one of file or fileId');
    const result = await this.request(`messages/${method}`, { chatId, fileId: options.fileId,
      ...(method === 'sendFile' ? { caption: options.caption, parseMode: options.parseMode } : {}),
      replyMsgId: options.replyToId, inlineKeyboardMarkup: options.inlineKeyboardMarkup }, { signal: options.signal, file });
    return { ...messageResult(result, chatId), ...(typeof result.fileId === 'string' ? { fileId: result.fileId } : {}) };
  }
  async editText(chatId, msgId, text, options = {}) {
    const result = await this.request('messages/editText', { chatId, msgId, text,
      parseMode: options.parseMode, inlineKeyboardMarkup: options.inlineKeyboardMarkup }, { signal: options.signal });
    if (result.ok !== true) throw new ApiError('messages/editText', 'missing success confirmation');
    return { messageId: String(msgId), chatId };
  }
  async answerCallbackQuery(queryId, text, options = {}) {
    // Use the verified n8n contract: text, not the PHP client's textAnswer parameter.
    const result = await this.request('messages/answerCallbackQuery', { queryId, text }, { signal: options.signal });
    if (result.ok !== true) throw new ApiError('messages/answerCallbackQuery', 'missing success confirmation');
  }
  getFileInfo(fileId, options) { return this.request('files/getInfo', { fileId }, options); }
  sendTyping(chatId, options) { return this.request('chats/sendActions', { chatId, actions: 'typing' }, options); }
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
