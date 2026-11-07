import { isKnownExchange } from './exchanges.js';

export const CORRELATION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes, as in the source
export const AMOUNT_TOLERANCE_BPS = 200n; // 2%

/** Amounts match when either is unknown (0) or they are within 2%. */
export function amountsMatch(a, b) {
  a = BigInt(a ?? 0);
  b = BigInt(b ?? 0);
  if (a === 0n || b === 0n) return true;
  const diff = a > b ? a - b : b - a;
  return diff * 10000n <= b * AMOUNT_TOLERANCE_BPS;
}

/**
 * Correlated funding: other wallets funded by a DIFFERENT address within 10
 * minutes of this one with a matching amount. Catches an operator who uses a
 * different funder per wallet but funds them all in one burst.
 * `first`: this wallet's first funding. `others`: {wallet, funder, amount, timestampMs, digest}[].
 */
export function correlatedFunding(first, others, opts = {}) {
  if (!first || first.isExchange) return { count: 0, matches: [] };
  const matches = others.filter(
    (o) =>
      o.funder &&
      o.funder.toLowerCase() !== first.funder &&
      !isKnownExchange(o.funder, opts.extraExchanges) &&
      Math.abs(o.timestampMs - first.timestampMs) <= (opts.windowMs ?? CORRELATION_WINDOW_MS) &&
      amountsMatch(first.amount, o.amount),
  );
  return { count: matches.length, matches };
}
