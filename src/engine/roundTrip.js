/**
 * Round trip: has this wallet itself sent SUI back to its funder (or the
 * funder's own funder)? Ported from detectCircularFunding. One direct hop,
 * plus a weaker second hop through a small capped set of the wallet's own
 * recipients. Pure: the caller passes data. `getOutbound(address)` is only
 * used for the second hop and returns that address's outbound transfers
 * {recipient, digest}.
 */
export const MAX_COUNTERPARTIES = 5;

export function directRoundTrip(funderAddresses, outbound) {
  const funders = new Set(funderAddresses.filter(Boolean).map((a) => a.toLowerCase()));
  if (!funders.size) return null;
  const hit = outbound.find((t) => funders.has(t.recipient?.toLowerCase()));
  return hit ? { matchedFunder: hit.recipient.toLowerCase(), digest: hit.digest } : null;
}

export function roundTrip(wallet, funderAddresses, outbound, getOutbound) {
  const funders = new Set(funderAddresses.filter(Boolean).map((a) => a.toLowerCase()));
  if (!funders.size) return { circular: false, secondHopCircular: false };
  const direct = directRoundTrip(funderAddresses, outbound);
  if (direct) return { circular: true, secondHopCircular: false, ...direct };
  if (getOutbound) {
    const seen = new Set();
    for (const t of outbound) {
      const r = t.recipient?.toLowerCase();
      if (!r || funders.has(r) || r === wallet.toLowerCase() || seen.has(r)) continue;
      if (seen.size >= MAX_COUNTERPARTIES) break;
      seen.add(r);
      const hop = directRoundTrip(funderAddresses, getOutbound(r) ?? []);
      if (hop) {
        return {
          circular: false,
          secondHopCircular: true,
          secondHopIntermediary: r,
          secondHopMatchedFunder: hop.matchedFunder,
          secondHopDigest: hop.digest,
        };
      }
    }
  }
  return { circular: false, secondHopCircular: false };
}
