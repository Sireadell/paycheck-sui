import { analyzeFanOut } from './exchanges.js';

export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Other wallets first funded by the same funder, within a time window of this
 * wallet's own first funding. Ported from the cluster-size signal.
 * `funderPayouts`: the funder's outbound SUI transfers {recipient, timestampMs, digest}.
 * An exchange funder (static list or behavioural fan-out) returns no group.
 * @returns {{funder, groupSize, siblings, excluded}|null}
 */
export function sharedFunder(wallet, first, funderPayouts, opts = {}) {
  if (!first) return null;
  if (first.isExchange) return { funder: first.funder, groupSize: 0, siblings: [], excluded: 'known_exchange' };
  const fanOut = analyzeFanOut(funderPayouts);
  if (fanOut.looksLikeExchange) {
    return { funder: first.funder, groupSize: 0, siblings: [], excluded: 'exchange_like_fan_out', fanOut };
  }
  const w = wallet.toLowerCase();
  const window = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const firstPay = new Map();
  for (const p of [...funderPayouts].sort((a, b) => a.timestampMs - b.timestampMs)) {
    const r = p.recipient?.toLowerCase();
    if (r && !firstPay.has(r)) firstPay.set(r, p);
  }
  const siblings = [...firstPay]
    .filter(([r, p]) => r !== w && r !== first.funder && Math.abs(p.timestampMs - first.timestampMs) <= window)
    .map(([address, p]) => ({ address, digest: p.digest, timestampMs: p.timestampMs }));
  return { funder: first.funder, groupSize: siblings.length ? siblings.length + 1 : 0, siblings, excluded: null, fanOut };
}

/** A funder's payouts as touches for classifyHub (one entry per payout). */
export function funderTouches(funderPayouts) {
  return funderPayouts.map((p) => ({ wallet: p.recipient, timestampMs: p.timestampMs }));
}
