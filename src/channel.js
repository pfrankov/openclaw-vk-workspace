import { CHANNEL_ID, normalizeId, resolveAccount, sectionOf } from './config.js';
import { setupPlugin } from './channel-setup.js';
import { TeamsApi } from './api.js';
import { monitorAccount } from './monitor.js';
import { sendPayload } from './send.js';
import { messageActions } from './actions.js';
import { buildModelBrowseChannelData, buildModelsListChannelData, buildModelsProviderChannelData } from './keyboard.js';

const targetType = (raw) => /^vk-workspace:chat:/i.test(raw) || normalizeId(raw).endsWith('@chat.agent') ? 'group' : 'direct';
const validTarget = (raw) => { const id = normalizeId(raw); return id && !/[\x00-\x20\x7f]/.test(id) ? id : undefined; };
export async function probeAccount({ account, timeoutMs = 10000 }) {
  const start = Date.now();
  try {
    const self = await new TeamsApi(account).getSelf({ timeoutMs });
    return { ok: true, elapsedMs: Date.now() - start, bot: { id: self.userId, username: self.nick } };
  } catch { return { ok: false, elapsedMs: Date.now() - start, error: 'Bot API probe failed; check URL, token, TLS and permissions' }; }
}
export const channelPlugin = {
  ...setupPlugin,
  commands: {
    buildModelsMenuChannelData: buildModelsProviderChannelData,
    buildModelsProviderChannelData,
    buildModelsListChannelData,
    buildModelBrowseChannelData,
  },
  actions: messageActions,
  agentPrompt: { messageToolHints: () => [
    'VK Workspace: message(action=send) accepts vkButtons (rows of text/url or text/callbackData), vkFileId, vkVoice and vkTextFormat.',
    'message(action=edit) updates a tracked bot text message by messageId. Omit text to change only buttons; vkButtons: [] removes a menu.',
    'Callbacks are single-use, expire after 24 hours and follow sender access rules. They are not native execution approvals.',
  ] },
  pairing: {
    idLabel: 'vkTeamsUserId', normalizeAllowEntry: normalizeId,
    notifyApproval: ({ cfg, id, accountId }) => sendPayload(id, { text: 'OpenClaw: your access has been approved.' }, { cfg, accountId }),
  },
  security: {
    resolveDmPolicy: ({ cfg, account, accountId }) => ({ policy: account.config.dmPolicy,
      allowFrom: account.config.allowFrom ?? [],
      allowFromPath: `channels.${CHANNEL_ID}.${sectionOf(cfg).accounts?.[accountId || account.accountId] ? `accounts.${accountId || account.accountId}.` : ''}`,
      approveHint: `openclaw pairing approve ${CHANNEL_ID} <code>`, normalizeEntry: normalizeId }),
    collectWarnings: ({ account }) => [
      ...(account.config.dmPolicy === 'open' ? ['VK Workspace DMs are open to all users. Prefer pairing or an explicit allowlist.'] : []),
      ...(account.config.groupPolicy === 'open' ? ['VK Workspace groups are open. Prefer group and sender allowlists.'] : []),
      ...(account.config.allowInsecureHttp ? ['VK Workspace allows unencrypted HTTP. Bot tokens and messages may be exposed.'] : []),
    ],
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const { config } = resolveAccount(cfg, accountId, { readToken: false });
      return config.groups?.[groupId]?.requireMention ?? config.groups?.['*']?.requireMention ?? config.requireMention;
    },
  },
  messaging: {
    normalizeTarget: validTarget,
    parseExplicitTarget: ({ raw }) => validTarget(raw) ? { to: validTarget(raw), chatType: targetType(raw) } : null,
    inferTargetChatType: ({ to }) => validTarget(to) ? targetType(to) : undefined,
    targetResolver: { looksLikeId: (id) => Boolean(validTarget(id)), hint: '<userId|chatId>, e.g. user@example.com or 123@chat.agent' },
  },
  outbound: {
    deliveryMode: 'direct', textChunkLimit: 4096, sendPayloadGroupsMedia: true,
    shouldSkipPlainTextSanitization: () => true,
    sendFormattedText: async ({ to, text, ...options }) => {
      const results = [];
      await sendPayload(to, { text }, { ...options, signal: options.signal ?? options.abortSignal,
        onDeliveryResult: async (result) => { results.push(result); await options.onDeliveryResult?.(result); } });
      return results;
    },
    sendPayload: ({ to, payload, ...options }) => sendPayload(to, payload, options),
    sendText: ({ to, text, ...options }) => sendPayload(to, { text }, options),
    sendMedia: ({ to, text, mediaUrl, ...options }) => sendPayload(to, { text, mediaUrl }, options),
  },
  status: {
    defaultRuntime: { accountId: 'default', running: false, connected: false, lastStartAt: null, lastStopAt: null, lastError: null },
    probeAccount,
    collectStatusIssues: (accounts) => accounts.filter((account) => !account.configured || account.lastError).map((account) => ({
      channel: CHANNEL_ID, accountId: account.accountId, kind: account.configured ? 'runtime' : 'config',
      message: account.configured ? account.lastError : 'VK Teams bot token is not configured',
    })),
    buildChannelSummary: ({ snapshot }) => ({ configured: snapshot.configured, running: snapshot.running,
      connected: snapshot.connected, lastStartAt: snapshot.lastStartAt, lastStopAt: snapshot.lastStopAt,
      lastError: snapshot.lastError, probe: snapshot.probe }),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({ ...runtime,
      ...setupPlugin.config.describeAccount(account), mode: 'longpoll', probe }),
  },
  gateway: { startAccount: monitorAccount },
};
