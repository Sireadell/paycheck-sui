/**
 * Verdict rules. Pure: takes plain data, fetches nothing.
 *
 * Core rule: linked is NOT unsafe. An exchange or a payroll wallet funds many
 * wallets. Links alone never give "do not pay". Only a stored bad-outcome
 * memory (for this wallet, for its group, or for its funder or gas sponsor)
 * turns an answer red. Memory is the reason for the red answer.
 *
 * Rules, first match wins:
 *  1. bad-outcome memory for this wallet                  -> do not pay  OUTCOME_BAD_SELF
 *  2. bad-outcome memory for its group, funder or sponsor -> do not pay  GROUP_BAD_OUTCOME
 *  3. money sent back to its own funder (direct)          -> caution     ROUND_TRIP_TO_FUNDER
 *  4. real links, no bad history                          -> pay         LINKED_NO_BAD_HISTORY
 *  5. no links, no history                                -> pay         NO_LINKS_NO_BAD_HISTORY
 *  Input missing or unusable                              -> caution     INVALID_INPUT / DATA_UNAVAILABLE
 * A hub (classifyHub says "shared service, weak link") and a known exchange are
 * weak links: shown as evidence, never counted as a link, never used to match
 * a group id. A hub that has its own bad-outcome memory (address equals the hub)
 * still turns red through rule 2.
 * A "paid fine" memory is cited but never makes an answer greener than the rules.
 * Memories with origin or namespace k2-test never condition a verdict.
 */

export const VERDICTS = { PAY: 'pay', CAUTION: 'caution', DO_NOT_PAY: 'do not pay' };
export const FRESH_MS = 24 * 60 * 60 * 1000;

const HUB = 'shared service, weak link';
const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : '');
const BAD = new Set(['bad', 'went bad', 'went_bad', 'wentbad']);
const GOOD = new Set(['good', 'paid fine', 'paid_fine', 'paidfine']);
const outcomeOf = (m) => lc(String(m?.body?.outcome ?? '')).trim();
const idOf = (m) => m?.blobId || m?.id || null;
const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(a);

function usable(memories) {
  return (Array.isArray(memories) ? memories : []).filter(
    (m) => m && idOf(m) && m.origin !== 'k2-test' && m.namespace !== 'k2-test',
  );
}

function sortLinks(a, hubs) {
  const links = [];
  const weak = [];
  const f = a.firstFunder;
  const fHub = hubs?.funder?.verdict === HUB;
  const sHub = hubs?.sponsor?.verdict === HUB;
  const sf = a.sharedFunder;
  if (f?.funder) {
    if (f.isExchange || sf?.excluded === 'known_exchange') {
      weak.push({ type: 'funder', address: f.funder, note: 'known exchange, weak link' });
    } else if (sf?.excluded === 'exchange_like_fan_out' || fHub) {
      const h = hubs?.funder;
      weak.push({ type: 'funder', address: f.funder, note: `shared service, weak link${h?.countText ? ` (${h.countText} wallets, ${h.hours} h)` : ''}` });
    } else if (sf?.groupSize > 0) {
      links.push({ type: 'shared_funder', address: f.funder, wallets: sf.groupSize, siblings: (sf.siblings ?? []).map((s) => s.address), digests: (sf.siblings ?? []).map((s) => s.digest).filter(Boolean) });
    }
  }
  const g = a.gasSponsor;
  if (g?.sponsor) {
    if (g.isExchange) {
      weak.push({ type: 'gas_sponsor', address: g.sponsor, note: 'known exchange or platform sponsor, weak link' });
    } else if (sHub) {
      const h = hubs?.sponsor;
      weak.push({ type: 'gas_sponsor', address: g.sponsor, note: `shared service, weak link${h?.countText ? ` (${h.countText} wallets, ${h.hours} h)` : ''}` });
    } else {
      links.push({ type: 'gas_sponsor', address: g.sponsor, digest: g.digest });
    }
  }
  if (a.timing?.count > 0) {
    links.push({ type: 'correlated_funding', wallets: a.timing.count, digests: (a.timing.matches ?? []).map((m) => m.digest).filter(Boolean) });
  }
  return { links, weak };
}

function decide({ wallet, analysis, memories, groupId, hubs }) {
  const w = lc(wallet);
  const mems = usable(memories);
  const { links, weak } = sortLinks(analysis, hubs);
  const funder = lc(analysis.firstFunder?.funder);
  const sponsor = lc(analysis.gasSponsor?.sponsor);
  const linkedAddrs = new Set(links.filter((l) => l.address).map((l) => lc(l.address)));
  const hubAddrs = new Set(weak.filter((l) => l.address).map((l) => lc(l.address)));
  // A group id only counts when it comes from a real (non-weak) link.
  const useGroup = links.length > 0 && Boolean(groupId);

  const bad = mems.filter((m) => m.kind === 'outcome' && BAD.has(outcomeOf(m)));
  const good = mems.filter((m) => m.kind === 'outcome' && GOOD.has(outcomeOf(m)));

  const self = bad.filter((m) => lc(m.address) === w);
  const viaGroup = bad.filter((m) => {
    if (lc(m.address) === w) return false;
    if (useGroup && m.group === groupId) return true;
    const a = lc(m.address);
    // the memory is about this wallet's funder or sponsor itself (true for a hub too)
    if (a && (a === funder || a === sponsor) && (linkedAddrs.has(a) || hubAddrs.has(a))) return true;
    const bf = lc(m.body?.funder);
    const bs = lc(m.body?.gasSponsor ?? m.body?.sponsor);
    if (bf && bf === funder && linkedAddrs.has(bf)) return true;
    if (bs && bs === sponsor && linkedAddrs.has(bs)) return true;
    return false;
  });
  const goodHere = good.filter((m) => lc(m.address) === w || (useGroup && m.group === groupId));

  const evidence = [];
  for (const l of links) evidence.push({ kind: 'link', ...l });
  for (const l of weak) evidence.push({ kind: 'weak_link', ...l });
  if (analysis.roundTrip?.circular) evidence.push({ kind: 'round_trip', funder: analysis.roundTrip.matchedFunder, digest: analysis.roundTrip.digest });
  else if (analysis.roundTrip?.secondHopCircular) evidence.push({ kind: 'round_trip_second_hop', note: 'weaker signal, not counted' });

  const memEv = (m) => ({ kind: 'memory', memoryId: idOf(m), memoryKind: m.kind, outcome: outcomeOf(m) || null, address: m.address, group: m.group, origin: m.origin });

  if (self.length) {
    return { verdict: VERDICTS.DO_NOT_PAY, code: 'OUTCOME_BAD_SELF', reason: 'An earlier payment to this exact address went bad (stored memory).', evidence: [...evidence, ...self.map(memEv)], cited: [...self, ...goodHere], decisive: self };
  }
  if (viaGroup.length) {
    return { verdict: VERDICTS.DO_NOT_PAY, code: 'GROUP_BAD_OUTCOME', reason: 'This wallet is linked to a group, funder or gas sponsor where a payment went bad (stored memory).', evidence: [...evidence, ...viaGroup.map(memEv)], cited: [...viaGroup, ...goodHere], decisive: viaGroup };
  }
  for (const m of goodHere) evidence.push(memEv(m));
  const directRound = analysis.roundTrip?.circular && !analysis.firstFunder?.isExchange && !hubAddrs.has(funder);
  if (directRound) {
    return { verdict: VERDICTS.CAUTION, code: 'ROUND_TRIP_TO_FUNDER', reason: 'This wallet sent money back to the wallet that funded it. Not proof of harm; no bad history is stored.', evidence, cited: goodHere, decisive: [] };
  }
  if (links.length) {
    return { verdict: VERDICTS.PAY, code: 'LINKED_NO_BAD_HISTORY', reason: 'Linked to other wallets, but no bad outcome is stored for it or its group. Being linked is not unsafe.', evidence, cited: goodHere, decisive: [] };
  }
  return { verdict: VERDICTS.PAY, code: 'NO_LINKS_NO_BAD_HISTORY', reason: weak.length ? 'Only weak links (exchange or shared service) and no bad history stored.' : 'No links found and no bad history stored.', evidence, cited: goodHere, decisive: [] };
}

/**
 * Calls a fresh stored verdict memory lets us skip (the trace we did not repeat).
 * A verdict memory counts when it is for this wallet, not a test, newer than 24 h,
 * and carries body.tatumCalls. The newest one is used.
 */
export function memorySavedCalls({ wallet, memories, now = Date.now(), maxAgeMs = FRESH_MS }) {
  const w = lc(wallet);
  const fresh = usable(memories)
    .filter((m) => m.kind === 'verdict' && lc(m.address) === w && Number(m.body?.tatumCalls) > 0)
    .map((m) => ({ m, t: Date.parse(m.writtenAt ?? '') }))
    .filter((x) => Number.isFinite(x.t) && now - x.t >= 0 && now - x.t <= maxAgeMs)
    .sort((a, b) => b.t - a.t);
  if (!fresh.length) return { saved: 0, memoryId: null };
  return { saved: Math.floor(Number(fresh[0].m.body.tatumCalls)), memoryId: idOf(fresh[0].m) };
}

/**
 * Build the machine-readable answer:
 * {verdict, code, reason, evidence[], memoryIds[], retryable, nextAction}
 * plus changedByMemory, changedByIds, memorySavedCalls, memorySavedFrom.
 * Input: {wallet, analysis (from analyze()), memories (recalled), groupId,
 *         hubs {funder, sponsor} (classifyHub results), memoryOn = true, now}
 * memoryOn false (memory switch off): recalled memories are ignored, memoryIds is empty.
 */
export function buildVerdict(input = {}) {
  const { wallet, analysis, groupId = null, hubs = {}, memoryOn = true, now = Date.now() } = input;
  const base = { evidence: [], memoryIds: [], changedByMemory: false, changedByIds: [], memorySavedCalls: 0, memorySavedFrom: null };
  if (!isAddress(wallet)) {
    return { ...base, verdict: VERDICTS.CAUTION, code: 'INVALID_INPUT', reason: 'That is not a Sui address (expected 0x followed by hex).', retryable: false, nextAction: 'Send a valid Sui address.' };
  }
  if (!analysis || typeof analysis !== 'object') {
    return { ...base, verdict: VERDICTS.CAUTION, code: 'DATA_UNAVAILABLE', reason: 'No on-chain data could be read for this wallet, so no judgement was made.', retryable: true, nextAction: 'Try again shortly.' };
  }
  const memories = memoryOn ? input.memories : [];
  const full = decide({ wallet, analysis, memories, groupId, hubs });
  const off = memoryOn ? decide({ wallet, analysis, memories: [], groupId, hubs }) : full;
  const changed = full.verdict !== off.verdict;
  const memoryIds = [...new Set(full.cited.map(idOf).filter(Boolean))];
  const changedByIds = changed ? [...new Set(full.decisive.map(idOf).filter(Boolean))] : [];
  const saved = memoryOn ? memorySavedCalls({ wallet, memories, now }) : { saved: 0, memoryId: null };
  const nextAction = full.verdict === VERDICTS.DO_NOT_PAY
    ? 'Do not sign this payment. Review the cited memory.'
    : full.verdict === VERDICTS.CAUTION
      ? 'Pay only a small amount or verify the payee another way.'
      : 'Safe to proceed on current evidence. Report the outcome after paying.';
  return {
    verdict: full.verdict,
    code: full.code,
    reason: full.reason,
    evidence: full.evidence,
    memoryIds,
    retryable: false,
    nextAction,
    changedByMemory: changed,
    changedByIds,
    memorySavedCalls: saved.saved,
    memorySavedFrom: saved.memoryId,
  };
}
