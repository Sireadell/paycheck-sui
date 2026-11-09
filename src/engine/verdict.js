/**
 * Verdict rules. Pure: takes plain data, fetches nothing. Reader table: docs/VERDICT_RULES.md
 *
 * Core rule: linked is NOT unsafe. An exchange or a payroll wallet funds many
 * wallets. Links alone never give "do not pay". Only a stored bad-outcome
 * memory reached through a real link turns an answer red. Memory is the reason
 * for the red answer.
 *
 * Rules, first match wins:
 *  1. bad-outcome memory for this wallet                              -> do not pay OUTCOME_BAD_SELF
 *  2. bad-outcome memory reached through a real, checked link         -> do not pay GROUP_BAD_OUTCOME
 *     (same group id, a sibling of the same funder, the funder itself,
 *      the gas sponsor itself, or a reported wallet with the same funder or sponsor)
 *  3. bad-outcome memory reached only through a hub (shared service)  -> caution HUB_BAD_OUTCOME
 *  4. bad-outcome memory reached through a link whose hub check was not run -> caution LINK_NOT_CHECKED
 *  5. money sent straight back to its own first funder (not a hub)    -> caution ROUND_TRIP_TO_FUNDER
 *  6. real links, no bad history                                      -> pay LINKED_NO_BAD_HISTORY
 *  7. no links, no history                                            -> pay NO_LINKS_NO_BAD_HISTORY
 *  Input missing or unusable -> caution INVALID_INPUT / DATA_UNAVAILABLE (rule 1 still applies when data is missing)
 *  Shared memory could not be read fully (memoryDegraded) -> a "pay" becomes caution MEMORY_UNAVAILABLE, retryable.
 *  A red answer stays red and another caution keeps its code, with the retry note added.
 * A hub (classifyHub "shared service, weak link") and a known exchange are weak
 * links: shown as evidence, never counted, never used to match a group id. A bad
 * report about a hub turns the hub itself red when it is checked, but only gives
 * caution to the wallets it served (one report must not turn an exchange's customers red).
 * Every evidence row carries basis: fact (read on chain), guess (behaviour rule) or report (stored memory).
 * A "paid fine" memory is cited but never makes an answer greener than the rules.
 * Memories with origin or namespace k2-test never condition a verdict.
 */

import { MIN_FAN_OUT_SPAN_MS } from './exchanges.js';

export const VERDICTS = { PAY: 'pay', CAUTION: 'caution', DO_NOT_PAY: 'do not pay' };
export const FRESH_MS = 24 * 60 * 60 * 1000;

const HUB = 'shared service, weak link';
const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : '');
const BAD = new Set(['bad', 'went bad', 'went_bad', 'wentbad']);
const GOOD = new Set(['good', 'paid fine', 'paid_fine', 'paidfine']);
const outcomeOf = (m) => lc(String(m?.body?.outcome ?? '')).trim();
const idOf = (m) => m?.blobId || m?.id || null;
const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(a);
// A hub stays a hub even when classifyHub was given a bad-memory id; this file handles that memory itself.
const isHub = (h) => h?.verdict === HUB || (h?.reason === 'bad_outcome_memory' && h?.spanMs >= MIN_FAN_OUT_SPAN_MS);
const hubNote = (h) => `shared service, weak link${h?.countText ? ` (${h.countText} wallets, ${h.hours} h)` : ''}`;
const reporterOf = (m) => m.body?.reporter ?? m.body?.agentId ?? m.origin ?? null;

function usable(memories) {
  return (Array.isArray(memories) ? memories : []).filter(
    (m) => m && idOf(m) && m.origin !== 'k2-test' && m.namespace !== 'k2-test',
  );
}

function sortLinks(a, hubs) {
  const links = [];
  const weak = [];
  const f = a.firstFunder;
  const sf = a.sharedFunder;
  if (f?.funder) {
    if (f.isExchange || sf?.excluded === 'known_exchange') {
      weak.push({ type: 'funder', address: f.funder, digest: f.digest, basis: 'fact', note: 'known exchange (cited label), weak link' });
    } else if (sf?.excluded === 'exchange_like_fan_out' || isHub(hubs?.funder)) {
      weak.push({ type: 'funder', address: f.funder, digest: f.digest, basis: 'guess', note: hubNote(hubs?.funder) });
    } else if (sf?.groupSize > 0) {
      links.push({ type: 'shared_funder', address: f.funder, basis: 'fact', wallets: sf.groupSize, siblings: (sf.siblings ?? []).map((s) => lc(s.address)), digests: [f.digest, ...(sf.siblings ?? []).map((s) => s.digest)].filter(Boolean) });
    }
  }
  const g = a.gasSponsor;
  if (g?.sponsor) {
    if (g.isExchange) {
      weak.push({ type: 'gas_sponsor', address: g.sponsor, digest: g.digest, basis: 'fact', note: 'known exchange or platform sponsor (cited label), weak link' });
    } else if (isHub(hubs?.sponsor)) {
      weak.push({ type: 'gas_sponsor', address: g.sponsor, digest: g.digest, basis: 'guess', note: hubNote(hubs?.sponsor) });
    } else {
      links.push({ type: 'gas_sponsor', address: g.sponsor, digest: g.digest, basis: 'fact', hubChecked: Boolean(hubs?.sponsor) });
    }
  }
  if (a.timing?.count > 0) {
    links.push({ type: 'correlated_funding', basis: 'guess', note: 'different funders, same amount within 10 minutes', wallets: a.timing.count, digests: (a.timing.matches ?? []).map((m) => m.digest).filter(Boolean) });
  }
  return { links, weak };
}

/** How a bad memory reaches this wallet: {tier: strong | hub | unchecked, via}, or {} when it does not. */
function reach(m, ctx) {
  const { useGroup, groupId, siblings, funder, sponsor, funderState, sponsorState } = ctx;
  const a = lc(m.address);
  const bf = lc(m.body?.funder);
  const bs = lc(m.body?.gasSponsor ?? m.body?.sponsor);
  const at = (state, via) => ({ tier: state === 'strong' ? 'strong' : state === 'weak' ? 'hub' : 'unchecked', via });
  if (useGroup && m.group && m.group === groupId) return { tier: 'strong', via: { type: 'group', group: groupId } };
  if (a && siblings.has(a)) return { tier: 'strong', via: { type: 'shared_funder', address: funder, sibling: a } };
  if (a && a === funder) return at(funderState, { type: 'funder_reported', address: funder });
  if (a && a === sponsor) return at(sponsorState, { type: 'gas_sponsor_reported', address: sponsor });
  // A reported wallet that shares our funder or sponsor. Through a hub this says nothing, so it does not reach.
  if (bf && bf === funder && funderState !== 'weak') return at(funderState, { type: 'shared_funder', address: funder });
  if (bs && bs === sponsor && sponsorState !== 'weak') return at(sponsorState, { type: 'gas_sponsor', address: sponsor });
  return {};
}

function decide({ wallet, analysis, memories, groupId, hubs }) {
  const w = lc(wallet);
  const mems = usable(memories);
  const { links, weak } = sortLinks(analysis, hubs);
  const funder = lc(analysis.firstFunder?.funder);
  const sponsor = lc(analysis.gasSponsor?.sponsor);
  const weakAddrs = new Set(weak.filter((l) => l.address).map((l) => lc(l.address)));
  const state = (addr, checked) => (!addr ? 'none' : weakAddrs.has(addr) ? 'weak' : checked ? 'strong' : 'unchecked');
  const sponsorLink = links.find((l) => l.type === 'gas_sponsor');
  const ctx = {
    useGroup: links.length > 0 && Boolean(groupId), // a group id only counts with a real link
    groupId,
    siblings: new Set(links.flatMap((l) => l.siblings ?? [])),
    funder,
    sponsor,
    // the funder is checked when its payouts were read (shared funder found) or classifyHub ran on it
    funderState: state(funder, links.some((l) => l.type === 'shared_funder') || Boolean(hubs?.funder)),
    sponsorState: state(sponsor, Boolean(sponsorLink?.hubChecked)),
  };

  const bad = mems.filter((m) => m.kind === 'outcome' && BAD.has(outcomeOf(m)));
  const good = mems.filter((m) => m.kind === 'outcome' && GOOD.has(outcomeOf(m)));
  const self = bad.filter((m) => lc(m.address) === w).map((m) => ({ m, via: { type: 'this_address' } }));
  const reached = bad.filter((m) => lc(m.address) !== w).map((m) => ({ m, ...reach(m, ctx) })).filter((x) => x.tier);
  const tier = (t) => reached.filter((x) => x.tier === t);
  const goodHere = good.filter((m) => lc(m.address) === w || (ctx.useGroup && m.group === groupId));

  const evidence = [];
  for (const l of links) evidence.push({ kind: 'link', ...l });
  for (const l of weak) evidence.push({ kind: 'weak_link', ...l });
  const rt = analysis.roundTrip;
  const directRound = Boolean(rt?.circular && funder && lc(rt.matchedFunder) === funder && !weakAddrs.has(funder));
  if (rt?.circular) evidence.push({ kind: 'round_trip', basis: 'fact', funder: rt.matchedFunder, digest: rt.digest, counted: directRound });
  else if (rt?.secondHopCircular) evidence.push({ kind: 'round_trip_second_hop', basis: 'fact', digest: rt.secondHopDigest ?? null, counted: false, note: 'weaker signal, not counted' });

  const memEv = ({ m, via }) => ({ kind: 'memory', basis: 'report', memoryId: idOf(m), memoryKind: m.kind, outcome: outcomeOf(m) || null, address: m.address ?? null, group: m.group ?? null, origin: m.origin ?? null, namespace: m.namespace ?? null, reporter: reporterOf(m), writtenAt: m.writtenAt ?? null, via: via ?? null });
  const goodEv = goodHere.map((m) => memEv({ m, via: lc(m.address) === w ? { type: 'this_address' } : { type: 'group', group: groupId } }));
  const out = (verdict, code, reason, decisive) => ({ verdict, code, reason, evidence: [...evidence, ...decisive.map(memEv), ...goodEv], cited: [...decisive.map((x) => x.m), ...goodHere], decisive });

  if (self.length) return out(VERDICTS.DO_NOT_PAY, 'OUTCOME_BAD_SELF', 'An earlier payment to this exact address went bad (stored report).', self);
  if (tier('strong').length) return out(VERDICTS.DO_NOT_PAY, 'GROUP_BAD_OUTCOME', 'This wallet has a direct on-chain link (same funder, same gas sponsor or same group) to a wallet where a payment went bad (stored report).', tier('strong'));
  if (tier('hub').length) return out(VERDICTS.CAUTION, 'HUB_BAD_OUTCOME', 'A bad payment is reported for a shared service that also served this wallet. A shared service serves many honest wallets, so this is a warning, not a stop.', tier('hub'));
  if (tier('unchecked').length) return out(VERDICTS.CAUTION, 'LINK_NOT_CHECKED', 'A bad payment is reported through a link we have not yet checked for being a shared service. Warning only until it is checked.', tier('unchecked'));
  if (directRound) return out(VERDICTS.CAUTION, 'ROUND_TRIP_TO_FUNDER', 'This wallet sent money straight back to the wallet that funded it (on-chain fact). That is not proof of harm, and no bad history is stored.', []);
  if (links.length) return out(VERDICTS.PAY, 'LINKED_NO_BAD_HISTORY', 'Linked to other wallets, but no bad outcome is stored for it or its group. Being linked is not unsafe.', []);
  return out(VERDICTS.PAY, 'NO_LINKS_NO_BAD_HISTORY', weak.length ? 'Only weak links (exchange or shared service) and no bad history stored.' : 'No links found and no bad history stored.', []);
}

const LABELS = { LINKED_NO_BAD_HISTORY: 'linked, no bad history', NO_LINKS_NO_BAD_HISTORY: 'no links, no bad history' };
const labelOf = (r) => LABELS[r.code] ?? r.verdict;

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
 * {verdict, code, label, reason, evidence[], memoryIds[], retryable, nextAction}
 * plus changedByMemory, changedByIds, warnedBy[], withoutMemory, memorySavedCalls, memorySavedFrom.
 * warnedBy: the memories that decided a red or caution answer, with reporter, the
 *   reported address, crossAddress (true when the report was about another wallet) and via (the link used).
 * withoutMemory: the same check with memory off, so one call fills the side-by-side view.
 * Input: {wallet, analysis (from analyze()), memories (recalled, with writtenAt), groupId (only from a real link),
 *         hubs {funder, sponsor} (classifyHub results; without hubs.sponsor a gas sponsor link is "not checked"),
 *         memoryOn = true, now}
 * memoryOn false (memory switch off): recalled memories are ignored, memoryIds is empty.
 */
export function buildVerdict(input = {}) {
  const { wallet, analysis, groupId = null, hubs = {}, memoryOn = true, memoryDegraded = false, inputError = null, payee = null, now = Date.now() } = input;
  const base = { label: 'caution', evidence: [], memoryIds: [], changedByMemory: false, changedByIds: [], warnedBy: [], withoutMemory: { verdict: VERDICTS.CAUTION, code: null, label: 'caution' }, memorySavedCalls: 0, memorySavedFrom: null };
  if (inputError || !isAddress(wallet)) {
    return { ...base, verdict: VERDICTS.CAUTION, code: 'INVALID_INPUT', reason: inputError?.reason ?? 'That is not a Sui address (expected 0x followed by hex).', retryable: false, nextAction: 'Send a valid Sui address.' };
  }
  const memories = memoryOn ? input.memories : [];
  const noData = !analysis || typeof analysis !== 'object';
  const a = noData ? {} : analysis;
  const full = decide({ wallet, analysis: a, memories, groupId, hubs });
  if (noData && full.code !== 'OUTCOME_BAD_SELF') {
    return { ...base, code: 'DATA_UNAVAILABLE', withoutMemory: { ...base.withoutMemory, code: 'DATA_UNAVAILABLE' }, verdict: VERDICTS.CAUTION, reason: 'No on-chain data could be read for this wallet, so no judgement was made.', retryable: true, nextAction: 'Try again shortly.' };
  }
  const off = memoryOn ? decide({ wallet, analysis: a, memories: [], groupId, hubs }) : full;
  const changed = full.verdict !== off.verdict;
  const memoryIds = [...new Set(full.cited.map(idOf).filter(Boolean))];
  const changedByIds = changed ? [...new Set(full.decisive.map((x) => idOf(x.m)).filter(Boolean))] : [];
  const w = lc(wallet);
  const warnedBy = full.decisive.map(({ m, via }) => ({ memoryId: idOf(m), reporter: reporterOf(m), origin: m.origin ?? null, namespace: m.namespace ?? null, reportedAddress: m.address ?? null, crossAddress: lc(m.address) !== w, via }));
  const saved = memoryOn ? memorySavedCalls({ wallet, memories, now }) : { saved: 0, memoryId: null };
  const nextAction = full.verdict === VERDICTS.DO_NOT_PAY
    ? 'Do not sign this payment. Review the cited memory.'
    : full.verdict === VERDICTS.CAUTION
      ? 'Pay only a small amount or verify the payee another way.'
      : 'Safe to proceed on current evidence. Report the outcome after paying.';
  // A memory read that failed must never look like a clean "pay": nobody could see whether a bad report exists.
  const unread = memoryOn && memoryDegraded;
  // Things a "pay" must never be said about. A stored bad report still wins (it is red); these only turn a green into a caution.
  const noHistory = payee?.noHistory ? { code: 'NO_HISTORY', reason: 'This address has no transactions and no balance on Sui. Brand-new or unused wallets cannot be judged, and a mistyped address looks the same.', retry: false } : null;
  const unreadWhy = unread ? { code: 'MEMORY_UNAVAILABLE', reason: 'The shared memory could not be read fully, so reports of bad payments could not be checked. Try again.', retry: true } : null;
  const unreadNote = unreadWhy?.reason ?? '';
  const why = full.verdict === VERDICTS.PAY ? (noHistory ?? unreadWhy) : null;
  const demote = Boolean(why);
  const reason = noData ? `${full.reason} On-chain data could not be read, so only memory was used.` : full.reason;
  return {
    verdict: demote ? VERDICTS.CAUTION : full.verdict,
    code: demote ? why.code : full.code,
    label: demote ? 'caution' : labelOf(full),
    reason: demote ? (why.code === 'MEMORY_UNAVAILABLE' ? why.reason : `${why.reason}${unread ? ` ${unreadNote}` : ''}`) : unread && full.verdict === VERDICTS.CAUTION ? `${reason} ${unreadNote}` : reason,
    evidence: full.evidence,
    memoryIds,
    retryable: unread && full.verdict !== VERDICTS.DO_NOT_PAY,
    nextAction: demote ? (why.code === 'MEMORY_UNAVAILABLE' ? 'Retry the check in a moment, or pay only a small amount.' : 'Check the address with the payee before paying. Send a small test amount first.') : nextAction,
    changedByMemory: changed,
    changedByIds,
    warnedBy,
    withoutMemory: { verdict: off.verdict, code: off.code, label: labelOf(off) },
    memorySavedCalls: saved.saved,
    memorySavedFrom: saved.memoryId,
  };
}
