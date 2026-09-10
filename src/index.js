import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/core';
import { createChannelPairingController } from 'openclaw/plugin-sdk/channel-pairing';
import { resolveControlCommandGate } from 'openclaw/plugin-sdk/command-auth-native';
import { toInboundMediaFacts } from 'openclaw/plugin-sdk/channel-inbound';
import { createReplyPrefixOptions } from 'openclaw/plugin-sdk/channel-outbound';
import { getAgentScopedMediaLocalRoots } from 'openclaw/plugin-sdk/media-local-roots';
import { channelPlugin } from './channel.js';
import { setRuntime } from './runtime.js';
export { channelPlugin };
export const sdkHelpers = { createPairing: createChannelPairingController, commandGate: resolveControlCommandGate,
  mediaFacts: toInboundMediaFacts, replyPrefix: createReplyPrefixOptions, mediaRoots: getAgentScopedMediaLocalRoots };
export default defineChannelPluginEntry({ id: 'vk-workspace', name: 'VK Workspace',
  description: 'VK Workspaces / VK Teams bot channel', plugin: channelPlugin,
  setRuntime: (runtime) => setRuntime(runtime, sdkHelpers) });
