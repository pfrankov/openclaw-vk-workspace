import { CHANNEL_ID, channelSchema, uiHints, listAccountIds, defaultAccountId, resolveAccount,
  inspectAccount, normalizeId, editAccount, sectionOf } from './config.js';
import { isAbsolute } from 'node:path';

export const meta = {
  id: CHANNEL_ID, label: 'VK Workspace', selectionLabel: 'VK Workspace (VK Teams Bot)',
  detailLabel: 'VK Teams Bot API', docsPath: '/channels/vk-workspace', docsLabel: 'vk-workspace',
  blurb: 'VK Teams bot over long polling; cloud or an on-premises Bot API endpoint.',
  systemImage: 'message.fill', quickstartAllowFrom: true, markdownCapable: true,
};
export const capabilities = { chatTypes: ['direct', 'group'], media: true, threads: false,
  reactions: false, nativeCommands: false, blockStreaming: true, edit: true, reply: true,
  tts: { voice: { synthesisTarget: 'voice-note', transcodesAudio: false, audioFileFormats: ['aac', 'ogg', 'm4a'], captionedFinalText: false } } };
const describe = (account) => ({ accountId: account.accountId, name: account.name, enabled: account.enabled,
  configured: account.configured, tokenSource: account.tokenSource });
export const setupPlugin = {
  id: CHANNEL_ID, meta, capabilities,
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  configSchema: { schema: channelSchema, uiHints },
  config: {
    listAccountIds, defaultAccountId, resolveAccount,
    inspectAccount, isConfigured: (account) => account.configured,
    describeAccount: describe,
    resolveAllowFrom: ({ cfg, accountId }) => resolveAccount(cfg, accountId, { readToken: false }).config.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) => allowFrom.map(normalizeId).filter(Boolean),
    resolveDefaultTo: ({ cfg, accountId }) => resolveAccount(cfg, accountId, { readToken: false }).config.defaultTo,
    setAccountEnabled: ({ cfg, accountId, enabled }) => editAccount(cfg, accountId, { enabled }),
    deleteAccount: ({ cfg, accountId }) => {
      const section = structuredClone(sectionOf(cfg));
      const id = accountId || defaultAccountId(cfg);
      if (section.accounts?.[id]) delete section.accounts[id];
      if (id === 'default') {
        delete section.botToken; delete section.tokenFile;
        (section.accounts ??= {}).default = { enabled: false };
      }
      if (section.defaultAccount === id) delete section.defaultAccount;
      return { ...cfg, channels: { ...cfg.channels, [CHANNEL_ID]: section } };
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => accountId?.trim() || 'default',
    applyAccountName: ({ cfg, accountId, name }) => editAccount(cfg, accountId, name?.trim() ? { name: name.trim() } : {}),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv) return accountId !== 'default' ? 'Environment credentials are only available to the default account.'
        : process.env.VK_WORKSPACE_BOT_TOKEN?.trim() ? null : 'Set VK_WORKSPACE_BOT_TOKEN before using --use-env.';
      if (input.token && input.tokenFile) return 'Set token or tokenFile, not both.';
      if (input.tokenFile?.trim() && !isAbsolute(input.tokenFile.trim())) return 'tokenFile must be an absolute path.';
      return input.token?.trim() || input.tokenFile?.trim() ? null : 'A bot token or tokenFile is required.';
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const section = structuredClone(sectionOf(cfg));
      const id = accountId || 'default';
      const current = id === 'default' && !section.accounts?.default
        ? section : (section.accounts ??= {}, section.accounts[id] ??= {});
      delete current.botToken; delete current.tokenFile;
      if (!input.useEnv) {
        if (input.tokenFile) current.tokenFile = input.tokenFile;
        else current.botToken = input.token;
      }
      // Explicit default-account entries can use --use-env without copying a secret into the config.
      if (input.useEnv && section.accounts?.default) {
        Object.assign(section, section.accounts.default);
        delete section.accounts.default;
      }
      current.enabled = true; section.enabled = true;
      return { ...cfg, channels: { ...cfg.channels, [CHANNEL_ID]: section } };
    },
  },
};
