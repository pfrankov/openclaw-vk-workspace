import { CHANNEL_ID, isRecord, normalizeId } from './config.js';
import { TeamsApi, identifier, identifiers, pageCursor } from './api.js';
import { beforePlatformAction } from './send.js';
import { getRuntime } from './runtime.js';
import { getMessageStore } from './message-store.js';

export const operationFlags = { delete: 'delete', pin: 'pins', unpin: 'pins',
  'channel-info': 'chatInfo', 'member-info': 'chatInfo', 'thread-create': 'threads', 'channel-edit': 'chatManagement' };
export const readActions = ['channel-info', 'member-info'];
export function sameConversation(ctx, to, accountId) {
  const current = ctx.toolContext?.currentMessagingTarget ?? ctx.toolContext?.currentChannelId;
  return ctx.toolContext?.currentChannelProvider === CHANNEL_ID && normalizeId(current) === to && ctx.requesterAccountId === accountId;
}
export function authorizeForward(ctx, source, account) {
  if (account.config.actions?.forward !== true) throw new Error('Native forwarding requires actions.forward');
  if (ctx.senderIsOwner !== true && !(ctx.requesterSenderId && sameConversation(ctx, source, account.accountId))) {
    throw new Error('Forwarding requires the owner or the trusted source conversation and account');
  }
}
export const jsonResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const cleanFields = (value, fields) => Object.fromEntries(fields.flatMap((key) =>
  (['creator', 'admin', 'isBot', 'public', 'joinModeration'].includes(key) ? typeof value[key] === 'boolean' : typeof value[key] === 'string' && value[key].length <= 16000)
    ? [[key, value[key]]] : []));
const memberFields = ['userId', 'creator', 'admin'];
const infoFields = ['type', 'title', 'about', 'rules', 'firstName', 'lastName', 'nick', 'isBot', 'public', 'joinModeration'];

// One logical update per call: no partial multi-field administrative operations.
export function chatUpdate(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !['title', 'about', 'rules', 'threadAutoSubscribe', 'includeExistingThreads'].includes(key))) {
    throw new Error('Invalid vkChatUpdate');
  }
  const fields = Object.keys(value).filter((key) => key !== 'includeExistingThreads');
  if (fields.length !== 1) throw new Error('vkChatUpdate must change exactly one field');
  const field = fields[0];
  if (field === 'threadAutoSubscribe') {
    if (typeof value[field] !== 'boolean' || (value.includeExistingThreads !== undefined && typeof value.includeExistingThreads !== 'boolean') ||
        (!value[field] && value.includeExistingThreads)) throw new Error('Invalid thread subscription update');
  } else if (value.includeExistingThreads !== undefined || typeof value[field] !== 'string' ||
      value[field].length > (field === 'title' ? 256 : 4096) || (field === 'title' && !value[field].trim()) ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value[field])) throw new Error('Invalid chat field value');
  return field;
}
export async function handleOperation(ctx, to, account) {
  const { action, params } = ctx;
  const flag = operationFlags[action];
  if (!flag || account.config.actions?.[flag] !== true) throw new Error(`VK Workspace action requires actions.${flag || 'unknown'}`);
  const same = sameConversation(ctx, to, account.accountId);
  if (ctx.senderIsOwner !== true && !(ctx.requesterSenderId && same)) throw new Error('This action requires the owner or its trusted current conversation and account');
  if (['pin', 'unpin', 'channel-edit'].includes(action) && ctx.senderIsOwner !== true) throw new Error('Administrative actions require the trusted OpenClaw owner');
  identifier(to);
  if (params.vkMessageIds !== undefined && (action !== 'delete' || params.messageId !== undefined)) throw new Error('Use messageId or vkMessageIds for delete, not both');
  const deleteIds = action === 'delete' ? identifiers(params.vkMessageIds ?? [params.messageId]) : undefined;
  const msgId = ['pin', 'unpin', 'thread-create'].includes(action) ? identifier(params.messageId) : deleteIds?.[0];
  const userId = action === 'member-info' ? identifier(params.userId) : undefined;
  const cursor = ['channel-info', 'member-info'].includes(action) ? pageCursor(params.vkCursor) : undefined;
  const info = params.vkInfo ?? 'info';
  if (action === 'channel-info' && !['info', 'members', 'admins', 'thread-subscribers'].includes(info)) throw new Error('Invalid vkInfo');
  if (action === 'channel-info' && cursor && !['members', 'thread-subscribers'].includes(info)) throw new Error('This info method has no cursor');
  const field = action === 'channel-edit' ? chatUpdate(params.vkChatUpdate) : undefined;
  if (ctx.dryRun) return jsonResult({ channel: CHANNEL_ID, chatId: to, action, dryRun: true, validated: 'arguments-and-caller-policy' });
  const api = new TeamsApi(account);
  const options = { onPlatformSendDispatch: ctx.onPlatformSendDispatch, assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff };
  const call = async (fn) => { await beforePlatformAction(options); return fn(); };
  const store = () => getMessageStore(getRuntime().core, account);
  const ownReply = (entry) => {
    if (ctx.senderIsOwner !== true && (!ctx.requesterSenderId || entry.requesterId !== ctx.requesterSenderId)) {
      throw new Error('Cannot change another sender\'s bot reply');
    }
  };
  if (action === 'channel-info') {
    let result;
    if (info === 'info') result = cleanFields(await call(() => api.getChatInfo(to)), infoFields);
    else if (info === 'thread-subscribers') {
      const page = await call(() => api.getThreadSubscribers(to, cursor));
      result = { subscribers: page.subscribers.map((item) => ({ userId: item.sn })), cursor: pageCursor(page.cursor) ?? null };
    } else {
      const page = info === 'admins' ? await call(() => api.getChatAdmins(to)) : await call(() => api.getChatMembers(to, cursor));
      result = { [info]: page[info].map((item) => cleanFields(item, memberFields)), cursor: pageCursor(page.cursor) ?? null };
    }
    // Do not return invite links, avatar/signed URLs, last-seen data or arbitrary
    // provider extensions from the Bot API into an agent's tool context.
    return jsonResult({ channel: CHANNEL_ID, chatId: to, ...result });
  }
  if (action === 'member-info') {
    let next = cursor;
    const cursors = new Set();
    for (let index = 0; index < 20; index++) {
      if (cursors.has(next)) throw new Error('VK Teams pagination did not advance');
      cursors.add(next);
      const page = await call(() => api.getChatMembers(to, next));
      const member = page.members.find((item) => item.userId === userId);
      if (member) return jsonResult({ channel: CHANNEL_ID, chatId: to, member: cleanFields(member, memberFields), complete: true });
      next = pageCursor(page.cursor);
      if (!next) return jsonResult({ channel: CHANNEL_ID, chatId: to, member: null, complete: true });
    }
    return jsonResult({ channel: CHANNEL_ID, chatId: to, member: null, complete: false, cursor: next, reason: '20-page safety limit; resume with vkCursor' });
  }
  if (action === 'delete') {
    await beforePlatformAction(options);
    const messages = store();
    await messages.prepareDeleteMany(to, deleteIds, ownReply);
    try { await beforePlatformAction(options); await api.deleteMessages(to, deleteIds); await messages.forgetMany(to, deleteIds); }
    catch { throw Object.assign(new Error('VK Workspace deletion is unconfirmed; inspect the message in VK Teams before further changes'), { noRetry: true, mayHaveSent: true }); }
    return jsonResult({ channel: CHANNEL_ID, chatId: to, messageId: msgId, messageIds: deleteIds, deleted: true });
  }
  // These endpoints change a group/channel, never a private user's profile.
  const chat = await call(() => api.getChatInfo(to));
  if (chat.type === 'private') throw new Error('This operation requires a group or channel');
  if (action === 'thread-create' && ctx.senderIsOwner !== true && String(ctx.toolContext?.currentMessageId) !== msgId) {
    const entry = await store().get(to, msgId);
    if (!entry || entry.deletePending) throw new Error('Create a thread on the current inbound message or a tracked bot reply');
    ownReply(entry);
  }
  await beforePlatformAction(options);
  let result;
  try {
    if (action === 'pin') await api.pinMessage(to, msgId);
    else if (action === 'unpin') await api.unpinMessage(to, msgId);
    else if (action === 'thread-create') result = await api.addThread(to, msgId);
    else if (field === 'threadAutoSubscribe') await api.autoSubscribeThreads(to, params.vkChatUpdate[field], params.vkChatUpdate.includeExistingThreads ?? false);
    else await api.setChatField(to, field, params.vkChatUpdate[field]);
  } catch { throw Object.assign(new Error('VK Workspace operation is unconfirmed; inspect the chat before retrying'), { noRetry: true, mayHaveSent: true }); }
  return jsonResult({ channel: CHANNEL_ID, chatId: to, action, ...(msgId ? { messageId: msgId } : {}), ...result, ok: true });
}
