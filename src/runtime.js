let runtime;
let sdk;
export function setRuntime(next, helpers) { runtime = next; if (helpers) sdk = helpers; }
export function getRuntime() {
  if (!runtime || !sdk) throw new Error('VK Workspace runtime is not initialized');
  return { core: runtime, sdk };
}
