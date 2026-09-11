import { CHANNEL_ID, isRecord, matchesAllowFrom } from './config.js';
import { inboundMedia } from './media.js';
import { getRuntime } from './runtime.js';
import { sendPayload } from './send.js';
import { getMessageStore } from './message-store.js';

const validMessageId = (value) => typeof value === 'number' ? Number.isSafeInteger(value)
  : typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x20\x7f]/.test(value);

export function parseMessage(event, self) {
  if (!['newMessage', 'callbackQuery'].includes(event?.type)) return null;
  const callback = event.type === 'callbackQuery' ? event.payload : undefined;
  if (callback && (!isRecord(callback) || typeof callback.queryId !== 'string' || !callback.queryId || callback.queryId.length > 256 ||
      !/^ocw:[A-Za-z0-9_-]{24}$/.test(callback.callbackData) || !isRecord(callback.message) ||
      (callback.message.from && callback.message.from.userId !== self.userId) ||
      (callback.chat && callback.message.chat && (callback.chat.chatId !== callback.message.chat.chatId || callback.chat.type !== callback.message.chat.type)))) return null;
  const p = callback ? { ...callback.message, chat: callback.message.chat ?? callback.chat, from: callback.from, text: '', parts: [] } : event.payload;
  if (!isRecord(p) || typeof p.chat?.chatId !== 'string' || typeof p.from?.userId !== 'string' ||
      !p.chat.chatId || !p.from.userId || !validMessageId(p.msgId) ||
      p.from.userId === self.userId || p.from.isBot === true) return null;
  // Missing/unknown chat types never downgrade a group into a DM.
  const isGroup = p.chat.type !== 'private';
  const parts = Array.isArray(p.parts) ? p.parts : [];
  const candidateReply = parts.find((part) => part?.type === 'reply')?.payload?.message;
  const reply = validMessageId(candidateReply?.msgId) ? candidateReply : undefined;
  let text = typeof p.text === 'string' ? p.text : '';
  const forwards = parts.filter((part) => part?.type === 'forward').map((part) => part.payload?.message)
    .filter((message) => typeof message?.text === 'string');
  if (forwards.length) text += forwards.map((message) => `\n[Forwarded message]\n${message.text}`).join('');
  const hasFiles = parts.some((part) => ['file', 'voice', 'sticker'].includes(part?.type) && part.payload?.fileId);
  if (!text.trim() && !hasFiles && !callback) return null;
  const wasMentioned = Boolean(callback) || parts.some((part) => part?.type === 'mention' && part.payload?.userId === self.userId) ||
    reply?.from?.userId === self.userId || (typeof p.text === 'string' && p.text.includes(`@[${self.userId}]`));
  return { chatId: p.chat.chatId, senderId: p.from.userId, messageId: callback ? `callback:${callback.queryId}` : String(p.msgId), isGroup, parts,
    callback: callback ? { queryId: callback.queryId, token: callback.callbackData, messageId: String(p.msgId) } : undefined,
    text: text || '[Attachment]', visibleText: typeof p.text === 'string' ? p.text : '', reply, wasMentioned, title: p.chat.title,
    senderName: [p.from.firstName, p.from.lastName].filter(Boolean).join(' ') || p.from.userId,
    timestamp: Number.isFinite(p.timestamp) ? p.timestamp * 1000 : Date.now() };
}

export function checkAccess(message, account, paired = []) {
  const { config } = account;
  if (!account.enabled) return { allowed: false };
  if (message.isGroup) {
    const specific = config.groups?.[message.chatId];
    const fallback = config.groups?.['*'];
    const group = { ...fallback, ...specific };
    const allowFrom = group.allowFrom ?? config.groupAllowFrom ?? [];
    if (config.groupPolicy === 'disabled' || group.enabled === false) return { allowed: false };
    if (config.groupPolicy === 'allowlist' && ((!specific && !fallback) || !matchesAllowFrom(allowFrom, message.senderId))) {
      return { allowed: false };
    }
    return { allowed: true, allowFrom, group, requireMention: group.requireMention ?? config.requireMention };
  }
  const allowFrom = [...(config.allowFrom ?? []), ...(config.dmPolicy === 'pairing' ? paired : [])];
  if (config.dmPolicy === 'disabled') return { allowed: false };
  const allowed = config.dmPolicy === 'open' || matchesAllowFrom(allowFrom, message.senderId);
  return { allowed, challenge: !allowed && config.dmPolicy === 'pairing', allowFrom };
}

export async function handleInbound({ event, self, account, cfg, api, signal, log, setStatus, messageStore }) {
  signal?.throwIfAborted();
  cfg = { ...cfg, session: { ...cfg.session, dmScope: cfg.session?.dmScope ?? 'per-account-channel-peer' } };
  const message = parseMessage(event, self);
  if (!message) return;
  const { core, sdk } = getRuntime();
  const answer = async (text) => {
    if (message.callback) {
      try { await api.answerCallbackQuery(message.callback.queryId, text, { signal }); }
      catch { log?.('VK Workspace callback acknowledgement failed'); }
    }
  };
  const pairing = sdk.createPairing({ core, channel: CHANNEL_ID, accountId: account.accountId });
  const paired = !message.isGroup && account.config.dmPolicy === 'pairing'
    ? await pairing.readAllowFromStore() : [];
  signal?.throwIfAborted();
  const access = checkAccess(message, account, paired);
  if (!access.allowed) {
    if (message.callback) { await answer('Access denied. Contact the bot administrator.'); return; }
    if (access.challenge) {
      await pairing.issueChallenge({ senderId: message.senderId, senderIdLine: `Your VK Teams user id: ${message.senderId}`,
        meta: {}, sendPairingReply: (text) => api.sendText(message.chatId, text, { signal }),
        onReplyError: () => log?.('VK Workspace pairing reply failed') });
    }
    return;
  }
  const store = messageStore ?? getMessageStore(core, account);
  if (message.callback) {
    const text = await store.lookup(message.chatId, message.callback.messageId, message.callback.token, message.senderId);
    if (!text) { await answer('This menu has expired, was already used, or belongs to another user.'); return; }
    message.text = text; message.visibleText = text;
  }
  const hasCommand = core.channel.text.hasControlCommand(message.text, cfg);
  const commandGate = sdk.commandGate({ useAccessGroups: cfg.commands?.useAccessGroups !== false,
    allowTextCommands: core.channel.commands.shouldHandleTextCommands({ cfg, surface: CHANNEL_ID }),
    hasControlCommand: hasCommand,
    authorizers: [{ configured: access.allowFrom.length > 0, allowed: matchesAllowFrom(access.allowFrom, message.senderId) }] });
  if (hasCommand && commandGate.shouldBlock) { await answer('Command access denied.'); return; }
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg);
  let mentioned = message.wasMentioned || core.channel.mentions.matchesMentionPatterns(message.visibleText, mentionRegexes);
  let route;
  let media;
  let preflightTranscript;
  const mediaParts = message.parts.filter((part) => ['file', 'voice', 'sticker'].includes(part?.type) && part.payload?.fileId);
  const voiceOnly = !message.visibleText.trim() && mediaParts.length === 1 && mediaParts[0].type === 'voice';
  if (message.isGroup && access.requireMention && !mentioned && !(hasCommand && commandGate.commandAuthorized) && voiceOnly && mentionRegexes.length) {
    route = core.channel.routing.resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: account.accountId,
      peer: { kind: 'group', id: message.chatId } });
    media = await inboundMedia(message.parts, { api, account, core, signal });
    const mediaFacts = sdk.mediaFacts(media, { messageId: message.messageId });
    const preflightCtx = { Provider: CHANNEL_ID, Surface: CHANNEL_ID, OriginatingChannel: CHANNEL_ID,
      OriginatingTo: `${CHANNEL_ID}:${message.chatId}`, AccountId: account.accountId, media: mediaFacts };
    preflightTranscript = await sdk.audioPreflight.resolve({ abortSignal: signal, request: { cfg,
      ctx: preflightCtx } });
    mentioned = Boolean(preflightTranscript && core.channel.mentions.matchesMentionPatterns(preflightTranscript, mentionRegexes));
    if (mentioned) {
      message.text = sdk.formatAudioTranscript(preflightTranscript);
      media = preflightCtx.media;
    }
  }
  if (message.isGroup && access.requireMention && !mentioned && !(hasCommand && commandGate.commandAuthorized)) return;

  if (message.callback) {
    signal?.throwIfAborted();
    const accepted = await store.consume(message.chatId, message.callback.messageId, message.callback.token, message.senderId);
    if (accepted !== message.text) { await answer('This menu is no longer active.'); return; }
    await answer('Accepted');
  }
  signal?.throwIfAborted();
  // Authorization runs before downloads. Mention policy runs before downloads except for the
  // bounded voice-only preflight above, which is required to detect a spoken mention.
  route ??= core.channel.routing.resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: account.accountId,
    peer: { kind: message.isGroup ? 'group' : 'direct', id: message.chatId } });
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
  media ??= await inboundMedia(message.parts, { api, account, core, signal });
  signal?.throwIfAborted();
  const from = `${CHANNEL_ID}:${message.isGroup ? 'chat:' : ''}${message.chatId}`;
  const ctx = core.channel.reply.finalizeInboundContext({
    Body: core.channel.reply.formatAgentEnvelope({ channel: 'VK Workspace', from,
      timestamp: message.timestamp, previousTimestamp: core.channel.session.readSessionUpdatedAt({ storePath, sessionKey: route.sessionKey }),
      envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg), body: message.text }),
    BodyForAgent: message.text, RawBody: message.text, CommandBody: message.text,
    From: from, To: `${CHANNEL_ID}:${message.chatId}`, SessionKey: route.sessionKey, AccountId: account.accountId,
    ChatType: message.isGroup ? 'group' : 'direct', ConversationLabel: message.title || from,
    SenderId: message.senderId, SenderName: message.senderName,
    GroupSubject: message.isGroup ? message.title : undefined, GroupSystemPrompt: access.group?.systemPrompt,
    Provider: CHANNEL_ID, Surface: CHANNEL_ID, OriginatingChannel: CHANNEL_ID, OriginatingTo: `${CHANNEL_ID}:${message.chatId}`,
    MessageSid: message.messageId, Timestamp: message.timestamp, WasMentioned: mentioned,
    CommandAuthorized: commandGate.commandAuthorized,
    ReplyToId: message.reply?.msgId, ReplyToBody: message.reply?.text,
    media: media.length ? sdk.mediaFacts(media, { messageId: message.messageId }) : undefined,
  });
  await core.channel.session.recordInboundSession({ storePath, ctx, sessionKey: route.sessionKey,
    onRecordError: () => log?.('VK Workspace session metadata could not be updated') });
  if (preflightTranscript) await sdk.audioPreflight.send({ transcript: preflightTranscript, cfg,
    accountId: account.accountId, originatingTo: `${CHANNEL_ID}:${message.chatId}` });
  signal?.throwIfAborted();
  setStatus?.({ lastInboundAt: Date.now() });
  const { onModelSelected, ...prefix } = sdk.replyPrefix({ cfg, agentId: route.agentId, channel: CHANNEL_ID, accountId: account.accountId });
  let deliveryFailed = false;
  let settled = false;
  const typing = () => !settled && !signal?.aborted
    ? api.sendTyping(message.chatId, { signal }).catch(() => {}) : Promise.resolve();
  void typing();
  const timer = setInterval(() => { void typing(); }, 8000);
  timer.unref?.();
  try {
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({ ctx, cfg,
      dispatcherOptions: { ...prefix,
        deliver: async (payload) => {
          if (settled || signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
          const result = await sendPayload(message.chatId, payload, { cfg, account, api, core, signal,
            requesterSenderId: message.senderId, messageStore: store,
            replyToId: message.callback?.messageId ?? (message.isGroup ? message.messageId : undefined),
            mediaLocalRoots: sdk.mediaRoots(cfg, route.agentId) });
          if (result.messageId) setStatus?.({ lastOutboundAt: Date.now() });
        },
        onError: () => { deliveryFailed = true; log?.('VK Workspace reply dispatch failed'); },
      }, replyOptions: { onModelSelected, abortSignal: signal } });
    if (deliveryFailed) throw new Error('VK Workspace reply delivery failed');
  } finally { settled = true; clearInterval(timer); }
}
