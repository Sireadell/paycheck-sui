// Records every provider call (provider, read type, milliseconds, ok or fail) so each check can show its own totals.
const entries = [];

export function record(provider, type, ms, ok) {
  entries.push({ provider, type, ms: Math.round(ms), ok: Boolean(ok), at: Date.now() });
}

export function mark() {
  return entries.length;
}

export function summarize(since = 0, provider) {
  const list = entries.slice(since).filter((e) => !provider || e.provider === provider);
  const byType = {};
  for (const e of list) byType[e.type] = (byType[e.type] || 0) + 1;
  const sorted = list.map((e) => e.ms).sort((a, b) => a - b);
  return {
    calls: list.length,
    failed: list.filter((e) => !e.ok).length,
    medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    byType,
  };
}

export function reset() {
  entries.length = 0;
}
