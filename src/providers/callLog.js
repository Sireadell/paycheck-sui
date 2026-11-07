// Records every provider call (provider, read type, milliseconds, ok or fail) so each check can show its own totals.
// The shared list keeps only the newest MAX_ENTRIES. A check that needs exact counts uses its own recorder (withRecorder).
import { AsyncLocalStorage } from 'node:async_hooks';

export const MAX_ENTRIES = 5000;
const entries = [];
let dropped = 0;
const scope = new AsyncLocalStorage();

export function record(provider, type, ms, ok) {
  const e = { provider, type, ms: Math.round(ms), ok: Boolean(ok), at: Date.now() };
  entries.push(e);
  if (entries.length > MAX_ENTRIES) { entries.shift(); dropped++; }
  scope.getStore()?.push(e);
}

/** Run fn(summarizeOwn). Only calls made inside fn (and what it awaits) land in its own list, so concurrent runs never mix. */
export async function withRecorder(fn) {
  const own = [];
  return scope.run(own, () => fn((provider) => summarizeList(own, provider)));
}

export function mark() {
  return dropped + entries.length;
}

export function summarize(since = 0, provider) {
  return summarizeList(entries.slice(Math.max(0, since - dropped)), provider);
}

function summarizeList(all, provider) {
  const list = all.filter((e) => !provider || e.provider === provider);
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
  dropped = 0;
}
