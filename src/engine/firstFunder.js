import { isKnownExchange } from './exchanges.js';

/**
 * Who sent this wallet its first SUI. Input is the wallet's incoming SUI
 * transfers: {digest, sender, recipient, amount (mist, string|bigint), timestampMs}.
 * Self transfers are ignored. Returns null when there is none.
 */
export function firstFunder(wallet, incoming, opts = {}) {
  const w = wallet.toLowerCase();
  const list = incoming
    .filter((t) => t.recipient?.toLowerCase() === w && t.sender && t.sender.toLowerCase() !== w)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  if (!list.length) return null;
  const t = list[0];
  return {
    funder: t.sender.toLowerCase(),
    digest: t.digest,
    amount: BigInt(t.amount ?? 0),
    timestampMs: t.timestampMs,
    isExchange: isKnownExchange(t.sender, opts.extraExchanges),
  };
}
