import { firstFunder } from './firstFunder.js';
import { detectGasSponsor, groupByGasSponsor } from './gasSponsor.js';
import { sharedFunder } from './sharedFunder.js';
import { roundTrip } from './roundTrip.js';
import { correlatedFunding } from './timing.js';

export { firstFunder, detectGasSponsor, groupByGasSponsor, sharedFunder, roundTrip, correlatedFunding };
export { isKnownExchange, KNOWN_EXCHANGES } from './exchanges.js';

/**
 * Runs every link rule on plain data (no fetching here). The caller gathers
 * the data from the provider. Verdict wording lives in verdict.js (later step).
 * data: {incoming, sent, outbound, funderPayouts, otherFundings, getOutbound, funderOfFunder}
 */
export function analyze(wallet, data, opts = {}) {
  const first = firstFunder(wallet, data.incoming ?? [], opts);
  const sponsor = detectGasSponsor(wallet, data.sent ?? [], opts);
  const shared = sharedFunder(wallet, first, data.funderPayouts ?? [], opts);
  const trip = roundTrip(wallet, [first?.funder, data.funderOfFunder], data.outbound ?? [], data.getOutbound);
  const timing = correlatedFunding(first, data.otherFundings ?? [], opts);
  return { wallet: wallet.toLowerCase(), firstFunder: first, gasSponsor: sponsor, sharedFunder: shared, roundTrip: trip, timing };
}
