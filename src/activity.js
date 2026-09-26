// One in-flight activity request per turn. Stopping waits for it before clearing,
// so a late typing response cannot overwrite the final empty action.
export function startActivity(api, chatId, signal, intervalMs = 8000) {
  let stopped = false, pending;
  const tick = () => {
    if (stopped || signal?.aborted || pending) return;
    pending = Promise.resolve().then(() => {
      if (!stopped && !signal?.aborted) return api.sendTyping(chatId, { signal });
    }).catch(() => {}).finally(() => { pending = undefined; });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return async () => {
    if (stopped) return;
    stopped = true; clearInterval(timer);
    await pending;
    if (!signal?.aborted) {
      try { await api.stopTyping?.(chatId, { signal }); } catch { /* Activity is best effort, not reply delivery. */ }
    }
  };
}
