import { isKnownExchange } from './exchanges.js';

const MAX_TXS_TO_CHECK = 5; // same cap as the source rule: first sponsored tx is enough

/**
 * Hero signal 2. Who paid the gas for this wallet's own transactions.
 * On Sui the gas owner equals the sender when nobody sponsors, so a sponsor is
 * a gas owner that differs from the sender (this replaces the EVM rule of
 * comparing a decoded sender with the broadcaster).
 * Input: the wallet's own sent transactions {digest, sender, gasSponsor, timestampMs}.
 * @returns {{sponsor: string, digest: string, isExchange: boolean} | null}
 */
export function detectGasSponsor(wallet, sentTxs, opts = {}) {
  const w = wallet.toLowerCase();
  const own = sentTxs.filter((t) => t.sender?.toLowerCase() === w).slice(0, MAX_TXS_TO_CHECK);
  for (const t of own) {
    const s = t.gasSponsor?.toLowerCase();
    if (s && s !== w) {
      return { sponsor: s, digest: t.digest, isExchange: isKnownExchange(s, opts.extraExchanges) };
    }
  }
  return null;
}

/**
 * Wallets that share one gas sponsor. `wallets` is {address, sponsor}[] (from
 * detectGasSponsor per wallet). Returns groups of 2 or more. Exchange or
 * platform sponsors are skipped: a shared paymaster alone is not group evidence.
 */
export function groupByGasSponsor(wallets, opts = {}) {
  const map = new Map();
  for (const { address, sponsor } of wallets) {
    if (!sponsor || isKnownExchange(sponsor, opts.extraExchanges)) continue;
    const k = sponsor.toLowerCase();
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(address.toLowerCase());
  }
  return [...map].filter(([, s]) => s.size >= 2).map(([sponsor, s]) => ({ sponsor, wallets: [...s] }));
}

/**
 * Distinct senders a gas sponsor paid for, as touches for classifyHub.
 * `sponsoredTxs` is {sender, gasSponsor, timestampMs}[]; own-paid gas is skipped.
 */
export function sponsoredSenders(sponsor, sponsoredTxs) {
  const s = sponsor.toLowerCase();
  return sponsoredTxs
    .filter((t) => t.gasSponsor?.toLowerCase() === s && t.sender && t.sender.toLowerCase() !== s)
    .map((t) => ({ wallet: t.sender, timestampMs: t.timestampMs }));
}
