/**
 * Known exchange addresses on Sui. A shared funder that is an exchange is not
 * evidence of a group (an exchange pays out to everyone), so the engine
 * excludes these from group counting. Ported rule from PulseVerify's
 * knownExchanges.js: exclude by static list, plus a behavioural fan-out test.
 *
 * Every entry needs a public label source. The list is intentionally only
 * filled with entries whose source was checked; an unverified address must not
 * be added. Extra addresses can be supplied at run time with the
 * KNOWN_EXCHANGE_ADDRESSES env name (comma separated) or the `extra` option.
 *
 * @type {{address: string, label: string, source: string}[]}
 */
export const KNOWN_EXCHANGES = [];

const norm = (a) => (typeof a === 'string' ? a.toLowerCase() : '');

export function exchangeSet(extra = []) {
  const env = (process.env.KNOWN_EXCHANGE_ADDRESSES || '').split(',');
  return new Set(
    [...KNOWN_EXCHANGES.map((e) => e.address), ...env, ...extra].map((a) => norm(a.trim?.() ?? a)).filter((a) => a.startsWith('0x')),
  );
}

export function isKnownExchange(address, extra = []) {
  return exchangeSet(extra).has(norm(address));
}

export const FAN_OUT_THRESHOLD = 15; // distinct recipients before a funder looks exchange-like
export const MIN_FAN_OUT_SPAN_MS = 25 * 60 * 60 * 1000; // and spread over at least 25 hours

/**
 * Behavioural exchange test (ported from analyzeFunderFanOut). A burst of
 * payouts in a short span does not earn the exchange exemption.
 * @param {{recipient: string, timestampMs: number}[]} payouts outbound transfers of one funder
 */
export function analyzeFanOut(payouts) {
  const recipients = new Set(payouts.map((p) => norm(p.recipient)).filter(Boolean));
  const ts = payouts.map((p) => p.timestampMs).filter(Number.isFinite);
  const spanMs = ts.length >= 2 ? Math.max(...ts) - Math.min(...ts) : 0;
  return {
    recipientCount: recipients.size,
    spanMs,
    looksLikeExchange: recipients.size >= FAN_OUT_THRESHOLD && spanMs >= MIN_FAN_OUT_SPAN_MS,
  };
}
