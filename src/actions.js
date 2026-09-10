import { CHANNEL_ID, normalizeId, resolveAccount } from './config.js';
import { channelData, sendPayload, editMessage } from './send.js';

const actions = ['send', 'edit'];
const button = { type: 'object', additionalProperties: false, required: ['text'], properties: {
  text: { type: 'string', minLength: 1, maxLength: 128 }, url: { type: 'string' }, callbackData: { type: 'string' },
  style: { type: 'string', enum: ['base', 'primary', 'attention'] },
}, oneOf: [{ required: ['url'] }, { required: ['callbackData'] }] };
// The pinned SDK makes contributed fields optional when merging the shared message-tool schema.
const schema = { visibility: 'all-configured', actions, properties: {
  vkButtons: { type: 'array', description: 'VK Workspace inline keyboard; callbacks are single-use choices and follow sender access policy. An empty array removes buttons on edit.',
    maxItems: 10, items: { type: 'array', minItems: 1, maxItems: 8, items: button } },
  vkFileId: { type: 'string', description: 'Reuse a VK Teams fileId without downloading or uploading. Do not also provide a media URL.' },
  vkVoice: { type: 'boolean', description: 'Send one AAC/OGG/M4A attachment or voice fileId as a native voice message.' },
  vkTextFormat: { type: 'string', enum: ['markdown', 'plain'], description: 'Supported Markdown subset or exact plain text; raw HTML is never interpreted.' },
} };
const targetOf = (args) => normalizeId(args.to ?? args.target ?? args.chatId);
function withParams(payload, params) {
  const data = { ...(payload.channelData?.[CHANNEL_ID] ?? {}) };
  for (const [param, key] of [['vkButtons', 'buttons'], ['vkFileId', 'fileId'], ['vkVoice', 'voice'], ['vkTextFormat', 'textFormat']]) {
    if (params[param] !== undefined) data[key] = params[param];
  }
  const result = { ...payload, channelData: { ...payload.channelData, [CHANNEL_ID]: data } };
  channelData(result); return result;
}
const jsonResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
function sameConversation(ctx, to, accountId) {
  const current = ctx.toolContext?.currentMessagingTarget ?? ctx.toolContext?.currentChannelId;
  return ctx.toolContext?.currentChannelProvider === CHANNEL_ID && normalizeId(current) === to &&
    ctx.requesterAccountId === accountId;
}
export const messageActions = {
  describeMessageTool: () => ({ actions, schema }),
  supportsAction: ({ action }) => actions.includes(action),
  isToolDeliveryAction: ({ args }) => actions.includes(args.action),
  messageActionTargetAliases: { edit: { aliases: ['chatId'], deliveryTargetAliases: ['chatId'] } },
  extractToolSend: ({ args }) => args.action === 'send' && targetOf(args) ? { to: targetOf(args), accountId: args.accountId } : null,
  prepareSendPayload: ({ ctx, to, payload }) => {
    const result = withParams(payload, ctx.params);
    const accountId = ctx.accountId || resolveAccount(ctx.cfg, undefined, { readToken: false }).accountId;
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
    const same = sameConversation(ctx, to, account.accountId);
    if (ctx.action === 'edit' && ctx.requesterSenderId && !ctx.senderIsOwner && !same) {
      throw new Error('Editing from an inbound turn is limited to its current account and conversation');
    }
    const payload = withParams({ text: ctx.params.message ?? ctx.params.text,
      ...(ctx.params.media ? { mediaUrl: ctx.params.media } : {}),
      ...(ctx.params.asVoice ? { audioAsVoice: true } : {}) }, ctx.params);
    if (ctx.dryRun) return jsonResult({ channel: CHANNEL_ID, chatId: to, action: ctx.action, dryRun: true });
    const options = { cfg: ctx.cfg, account, mediaLocalRoots: ctx.mediaLocalRoots,
      replyToId: ctx.params.replyTo, forceDocument: ctx.params.forceDocument === true,
      requesterSenderId: same ? ctx.requesterSenderId : undefined, senderIsOwner: ctx.senderIsOwner,
      onPlatformSendDispatch: ctx.onPlatformSendDispatch, assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff };
    const result = ctx.action === 'edit' ? await editMessage(to, ctx.params.messageId, payload, options) : await sendPayload(to, payload, options);
    return jsonResult(result);
  },
};
