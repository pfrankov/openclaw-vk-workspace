import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/core';
import { setupPlugin } from './channel-setup.js';
export { setupPlugin };
export default defineSetupPluginEntry(setupPlugin);
