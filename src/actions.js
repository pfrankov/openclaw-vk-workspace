import { CHANNEL_ID, normalizeId, resolveAccount } from './config.js';
import { channelData, sendPayload, editMessage } from './send.js';
import { identifier } from './api.js';
import { nativeFormatSchema } from './rich-format.js';
import { operationFlags, readActions, sameConversation, authorizeForward, handleOperation, jsonResult } from './operations.js';

const baseActions = ['send', 'edit'];
const actions = [...baseActions, ...Object.keys(operationFlags)];
const button = { type: 'object', additionalProperties: false, required: ['text'], properties: {
  text: { type: 'string', minLength: 1, maxLength: 128 }, url: { type: 'string' }, callbackData: { type: 'string' },
  style: { type: 'string', enum: ['base', 'primary', 'attention'] },
}, oneOf: [{ required: ['url'] }, { required: ['callbackData'] }] };
// The pinned SDK makes contributed fields optional when merging the shared message-tool schema.
const idList = { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 1024 } };
const schema = { visibility: 'all-configured', actions, properties: {
  vkFormat: nativeFormatSchema,
  vkReplyToIds: { ...idList, description: 'Send: quote multiple messages from the destination conversation. Cannot be combined with replyTo or vkForward.' },
  vkMessageIds: { ...idList, description: 'Delete: explicit list of tracked bot message IDs, e.g. all chunks of one reply. Cannot be combined with messageId.' },
  vkForward: { type: 'object', additionalProperties: false, required: ['chatId', 'messageIds'],
    description: 'Native forwarding from a trusted source conversation. Requires actions.forward; cannot be combined with replyTo.',
    properties: { chatId: { type: 'string', minLength: 1, maxLength: 1024 }, messageIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 1024 } } } },
  vkInfo: { type: 'string', enum: ['info', 'members', 'admins', 'thread-subscribers'], description: 'channel-info view; paginated views return a cursor, not a complete directory.' },
  vkCursor: { type: 'string', maxLength: 4096, description: 'Opaque cursor returned by channel-info or an incomplete member-info result.' },
  vkChatUpdate: { type: 'object', additionalProperties: false, minProperties: 1,
    description: 'channel-edit: change exactly one of title/about/rules/threadAutoSubscribe. Requires actions.chatManagement and a trusted owner.',
    properties: { title: { type: 'string', minLength: 1, maxLength: 256 }, about: { type: 'string', maxLength: 4096 },
      rules: { type: 'string', maxLength: 4096 }, threadAutoSubscribe: { type: 'boolean' }, includeExistingThreads: { type: 'boolean' } } },
  vkButtons: { type: 'array', description: 'VK Workspace inline keyboard; callbacks are single-use choices and follow sender access policy. An empty array removes buttons on edit.',
    maxItems: 10, items: { type: 'array', minItems: 1, maxItems: 8, items: button } },
  vkFileId: { type: 'string', description: 'Reuse a VK Teams fileId without downloading or uploading. Do not also provide a media URL.' },
  vkVoice: { type: 'boolean', description: 'Send one AAC/OGG/M4A attachment or voice fileId as a native voice message.' },
  vkTextFormat: { type: 'string', enum: ['markdown', 'plain'], description: 'Supported Markdown subset or exact plain text; raw HTML is never interpreted.' },
} };
const targetOf = (args) => normalizeId(args.to ?? args.target ?? args.chatId ?? args.channelId);
function withParams(payload, params) {
  const data = { ...(payload.channelData?.[CHANNEL_ID] ?? {}) };
  for (const [param, key] of [['vkButtons', 'buttons'], ['vkFileId', 'fileId'], ['vkVoice', 'voice'], ['vkTextFormat', 'textFormat'], ['vkForward', 'forward'], ['vkReplyToIds', 'replyToIds'], ['vkFormat', 'format']]) {
    if (params[param] !== undefined) data[key] = params[param];
  }
  const result = { ...payload, channelData: { ...payload.channelData, [CHANNEL_ID]: data } };
  channelData(result); return result;
}
function assertThreadTarget(to, threadId) {
  if (threadId !== undefined && threadId !== null && normalizeId(threadId) !== to) {
    throw new Error('Use the native thread id as target; parent-chat delivery is not a thread reply');
  }
}
export const messageActions = {
  describeMessageTool: ({ cfg, accountId } = {}) => {
    const account = resolveAccount(cfg ?? {}, accountId, { readToken: false });
    const enabled = account.enabled ? [...baseActions, ...Object.keys(operationFlags).filter((action) => account.config.actions?.[operationFlags[action]] === true)] : [];
    return { actions: enabled, schema: { ...schema, actions: enabled } };
  },
  supportsAction: ({ action }) => actions.includes(action),
  isToolDeliveryAction: ({ args }) => actions.includes(args.action) && !readActions.includes(args.action),
  messageActionTargetAliases: Object.fromEntries(actions.map((action) => [action, { aliases: ['chatId', 'channelId'], deliveryTargetAliases: ['chatId', 'channelId'] }])),
  extractToolSend: ({ args }) => args.action === 'send' && targetOf(args) ? { to: targetOf(args), accountId: args.accountId } : null,
  prepareSendPayload: ({ ctx, to, payload, threadId, replyToId }) => {
    if (ctx.params.vkMessageIds !== undefined) throw new Error('vkMessageIds is only valid for delete');
    assertThreadTarget(normalizeId(to), threadId ?? ctx.params.threadId);
    const result = withParams(payload, ctx.params);
    if (result.channelData[CHANNEL_ID].replyToIds) {
      if (ctx.params.replyTo != null || payload.replyToId != null) throw new Error('Use replyTo or vkReplyToIds, not both');
      // Explicit native quotes supersede the host's implicit reply anchor.
      delete result.replyToId;
    }
    const accountId = ctx.accountId || resolveAccount(ctx.cfg, undefined, { readToken: false }).accountId;
    if (channelData(result).forward) {
      authorizeForward(ctx, channelData(result).forward.chatId, resolveAccount(ctx.cfg, accountId, { readToken: false }));
      if (replyToId != null || result.replyToId != null || ctx.params.replyTo != null) throw new Error('Forwarding and replying are mutually exclusive');
      // Source access belongs to this invocation, not to a durable payload that
      // might later run without its trusted sender. Use the guarded direct path.
      return null;
    }
    // Derived only from host-owned identity, this field restricts a menu; it never grants access.
    result.channelData[CHANNEL_ID].buttonOwnerId = ctx.requesterSenderId && sameConversation(ctx, normalizeId(to), accountId)
      ? ctx.requesterSenderId : undefined;
    return result;
  },
  handleAction: async (ctx) => {
    if (!actions.includes(ctx.action)) throw new Error('Unsupported VK Workspace message action');
    const to = targetOf(ctx.params);
    if (!to) throw new Error('A message target is required');
    const account = resolveAccount(ctx.cfg, ctx.accountId);
    if (!account.enabled) throw new Error('VK Workspace account is disabled');
    if (!baseActions.includes(ctx.action)) return handleOperation(ctx, to, account);
    assertThreadTarget(to, ctx.params.threadId);
    if (ctx.action === 'edit') identifier(ctx.params.messageId);
    const same = sameConversation(ctx, to, account.accountId);
    if (ctx.action === 'edit' && ctx.requesterSenderId && !ctx.senderIsOwner && !same) {
      throw new Error('Editing from an inbound turn is limited to its current account and conversation');
    }
    const payload = withParams({ text: ctx.params.message ?? ctx.params.text,
      ...(ctx.params.media ? { mediaUrl: ctx.params.media } : {}),
      ...(ctx.params.asVoice ? { audioAsVoice: true } : {}) }, ctx.params);
    if (ctx.params.vkMessageIds !== undefined) throw new Error('vkMessageIds is only valid for delete');
    if (channelData(payload).replyToIds && (ctx.action !== 'send' || ctx.params.replyTo != null)) throw new Error('vkReplyToIds requires send without replyTo');
    const forward = channelData(payload).forward;
    if (forward) {
      if (ctx.action !== 'send') throw new Error('Forwarding is not an edit');
      authorizeForward(ctx, forward.chatId, account);
      if (ctx.params.replyTo != null) throw new Error('Forwarding and replying are mutually exclusive');
    }
    if (ctx.dryRun) return jsonResult({ channel: CHANNEL_ID, chatId: to, action: ctx.action, dryRun: true });
    const options = { cfg: ctx.cfg, account, mediaLocalRoots: ctx.mediaLocalRoots, threadId: ctx.params.threadId,
      forwardAuthorized: Boolean(forward),
      replyToId: ctx.params.replyTo, forceDocument: ctx.params.forceDocument === true,
      requesterSenderId: same ? ctx.requesterSenderId : undefined, senderIsOwner: ctx.senderIsOwner,
      onPlatformSendDispatch: ctx.onPlatformSendDispatch, assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff };
    const result = ctx.action === 'edit' ? await editMessage(to, ctx.params.messageId, payload, options) : await sendPayload(to, payload, options);
    return jsonResult(result);
  },
};
