// Wallet profile: age, activity and pass-through, read from the history that is already fetched (no extra Tatum calls).
// Evidence only. Nothing here is read by the verdict rules, so no benchmark number can move because of it.
// Pure: takes the listing and the clock, returns plain facts. Unknown stays unknown (null), never "nothing there".
import { padAddress } from '../address.js';

const SUI_SUFFIX = '::sui::SUI';
const isSui = (b) => typeof b.coin === 'string' && b.coin.endsWith(SUI_SUFFIX);
const tsMs = (t) => Date.parse(t.timestamp ?? '');

export const PASS_THROUGH_WINDOW_MS = 30 * 60 * 1000; // sent on within 30 minutes
export const PASS_THROUGH_SHARE_BPS = 9000n; // 90% or more of what came in goes straight out
export const MAX_EXAMPLES = 3;

/**
 * @param {string} wallet
 * @param {{transactions: object[], hasNextPage?: boolean}} page oldest first, Tatum shape
 * @param {number} nowMs
 */
export function walletProfile(wallet, page, nowMs) {
  const w = padAddress(wallet) ?? String(wallet).toLowerCase();
  const txs = (page?.transactions ?? []).filter((t) => t.status === 'SUCCESS' && Number.isFinite(tsMs(t)));
  const capped = Boolean(page?.hasNextPage);
  if (!txs.length) return { firstSeenMs: null, ageDays: null, activeDays: 0, txsRead: 0, received: 0, sent: 0, capped, passThrough: { count: 0, examples: [] } };

  const times = txs.map(tsMs);
  const firstSeenMs = Math.min(...times);
  const lastReadMs = Math.max(...times);
  const days = new Set(times.map((t) => Math.floor(t / 86_400_000)));

  const incoming = [];
  const outflows = []; // positive SUI this wallet sent to others, per transaction it sent
  let received = 0;
  let sent = 0;
  for (const t of txs) {
    const at = tsMs(t);
    const gain = t.balanceChanges.filter((b) => isSui(b) && b.owner === w && BigInt(b.amount) > 0n).reduce((s, b) => s + BigInt(b.amount), 0n);
    if (t.sender !== w && gain > 0n) { received += 1; incoming.push({ digest: t.digest, at, amount: gain }); }
    if (t.sender === w) {
      sent += 1;
      const out = t.balanceChanges.filter((b) => isSui(b) && b.owner && b.owner !== w && BigInt(b.amount) > 0n).reduce((s, b) => s + BigInt(b.amount), 0n);
      if (out > 0n) outflows.push({ digest: t.digest, at, amount: out });
    }
  }

  // Pass-through: SUI arrives and almost all of it leaves again within 30 minutes. Each outflow is used once.
  const used = new Set();
  const examples = [];
  let count = 0;
  for (const inc of incoming) {
    const window = outflows.filter((o) => !used.has(o.digest) && o.at >= inc.at && o.at - inc.at <= PASS_THROUGH_WINDOW_MS);
    const total = window.reduce((s, o) => s + o.amount, 0n);
    if (window.length && total * 10000n >= inc.amount * PASS_THROUGH_SHARE_BPS) {
      window.forEach((o) => used.add(o.digest));
      count += 1;
      if (examples.length < MAX_EXAMPLES) examples.push({ inDigest: inc.digest, outDigest: window[0].digest, minutes: Math.max(0, Math.round((window[window.length - 1].at - inc.at) / 60000)) });
    }
  }

  return {
    firstSeenMs,
    ageDays: Math.max(0, Math.floor((nowMs - firstSeenMs) / 86_400_000)),
    // Days with any activity in the part of the history that was read. At least this many if the history was capped.
    activeDays: days.size,
    lastReadMs,
    txsRead: txs.length,
    received,
    sent,
    capped,
    passThrough: { count, examples },
  };
}

/** The funder's fan-out as shown to the reader. Taken from the hub rule's result, so it is the same number the rules used. */
export function fanOutFacts(hub) {
  if (!hub) return null;
  return { wallets: hub.wallets, atLeast: hub.atLeast, hours: hub.hours, countText: hub.countText, reading: hub.verdict, reason: hub.reason };
}
