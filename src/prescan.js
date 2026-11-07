// Pre-scan helpers: the public pick rule (docs/METHOD.md), verdict counts and error classes. Pure, no network.
import { padAddress } from './address.js';

export const ZERO_ADDRESS = padAddress('0x0');
export const BATCH = 20;

/** Pick rule for one checkpoint: the sender of each successful transaction among the first 50, minus duplicates and the zero address, in the order found. */
export function pickFromCheckpoint(txs, seen) {
  const out = [];
  for (const t of txs.slice(0, 50)) {
    if (t.status !== 'SUCCESS' || !t.sender) continue;
    const a = padAddress(t.sender);
    if (!a || a === ZERO_ADDRESS || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

/**
 * Walk down from the checkpoint we stopped at until the list holds `count` addresses. Resumable: the checkpoint we stopped in is read
 * again from its start, and duplicates are skipped, so the list stays a prefix of any longer list.
 * progress: { startCheckpoint, currentCheckpoint, picks: [] } (changed in place). Returns progress.
 */
export async function extendPicks(progress, count, { checkpointTransactions, floor, onCheckpoint = () => {} }) {
  const seen = new Set(progress.picks);
  while (progress.picks.length < count) {
    const cp = progress.currentCheckpoint;
    if (cp < floor) throw new Error('Reached the data floor before the list was full');
    const txs = (await checkpointTransactions(cp)) ?? [];
    for (const a of pickFromCheckpoint(txs, seen)) {
      if (progress.picks.length >= count) break;
      progress.picks.push(a);
    }
    onCheckpoint(cp);
    if (progress.picks.length >= count) break; // stay in this checkpoint, it may hold more for a longer list
    progress.currentCheckpoint = cp - 1;
  }
  return progress;
}

/** Counts of pre-scan verdicts by kind (a wallet can be both a shared service and in a verdict group, so kinds and verdicts are separate tables). */
export function tally(rows) {
  const t = { total: rows.length, byVerdict: { pay: 0, caution: 0, 'do not pay': 0 }, byKind: { 'shared service': 0, linked: 0, 'no history': 0, other: 0 } };
  for (const r of rows) {
    t.byVerdict[r.verdict] = (t.byVerdict[r.verdict] ?? 0) + 1;
    const hub = typeof r.walletHub === 'string' && r.walletHub.startsWith('shared service');
    if (hub) t.byKind['shared service']++;
    else if (r.code === 'LINKED_NO_BAD_HISTORY') t.byKind.linked++;
    else if (r.code === 'NO_LINKS_NO_BAD_HISTORY') t.byKind['no history']++;
    else t.byKind.other++;
  }
  return t;
}

export const isRateOrQuota = (msg) => /\b429\b|rate.?limit|too many|quota|\b402\b|credit|exceed|insufficient|payment required/i.test(String(msg));
export const isNetwork = (msg) => /fetch failed|network|econn|enotfound|etimedout|eai_again|socket|timed out|timeout|\b50[234]\b|terminated/i.test(String(msg));

export async function withBackoff(fn, { tries = 5, baseMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRetry = () => {} } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (isRateOrQuota(e?.message) || !isNetwork(e?.message)) throw e;
      onRetry(i + 1, e);
      await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}
