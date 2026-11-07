// Re-asks Ankr for the transactions Tatum returned and counts how many links both providers agree on.
// A link is one transaction: same sender, same gas sponsor, same status, same SUI change for the address.
const suiChange = (tx, a) => tx.balanceChanges
  .filter((b) => b.owner === a && b.coin.endsWith('::sui::SUI'))
  .reduce((s, b) => s + BigInt(b.amount), 0n);

export function compareTx(tatumTx, ankrTx, address) {
  if (!ankrTx) return { agree: false, reason: 'ankr has no such transaction' };
  const diffs = [];
  if (tatumTx.sender !== ankrTx.sender) diffs.push('sender');
  if (tatumTx.gasSponsor !== ankrTx.gasSponsor) diffs.push('gas sponsor');
  if (tatumTx.status !== ankrTx.status) diffs.push('status');
  if (suiChange(tatumTx, address) !== suiChange(ankrTx, address)) diffs.push('SUI change');
  return diffs.length ? { agree: false, reason: `differs on ${diffs.join(', ')}` } : { agree: true };
}

// Y is the number of Tatum links checked. Ankr is asked for each by digest, which does not depend on its address history depth.
export async function crossCheck({ tatum, ankr, address, first = 20 }) {
  const a = address.toLowerCase();
  const page = await tatum.listTransactions(a, { first });
  const results = [];
  for (const t of page.transactions) {
    results.push({ digest: t.digest, ...compareTx(t, await ankr.transactionByDigest(t.digest), a) });
  }
  const listing = await ankr.listTransactions(a, { first });
  const ankrDigests = new Set(listing.transactions.map((t) => t.digest));
  const missingFromAnkrListing = page.transactions.filter((t) => !ankrDigests.has(t.digest)).length;
  return {
    checked: results.length,
    agree: results.filter((r) => r.agree).length,
    disagreements: results.filter((r) => !r.agree),
    tatumOldestCheckpoint: page.oldestCheckpoint,
    ankrOldestCheckpoint: listing.oldestCheckpoint,
    ankrListingEmpty: listing.reachedDepthLimit,
    missingFromAnkrListing,
    depthNote: listing.reachedDepthLimit || missingFromAnkrListing > 0
      ? 'Ankr address history is shallower than Tatum for this address; links it cannot list were still checked by digest.'
      : null,
  };
}
