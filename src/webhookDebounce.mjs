/** Debounced analyze trigger after Graph webhook notifications. */

let debounceTimer = null;
let lastRunAt = 0;

export function scheduleDebouncedAnalyze(callback, debounceMs = 5 * 60 * 1000) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    const now = Date.now();
    if (now - lastRunAt < debounceMs - 1000) return;
    lastRunAt = now;
    try {
      await callback();
    } catch (error) {
      console.error('Debounced analyze failed:', error);
    }
  }, Math.min(debounceMs, 30_000));
}

export function resetDebounceForTests() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  lastRunAt = 0;
}
