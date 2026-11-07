// The payee check: read the wallet's history, find links, recall memory, give a verdict, queue a verdict memory.
// Reads go through src/providers. The verdict itself comes from src/engine/verdict.js.
// Memory writes go through the background queue, so a check never waits for them (a write takes 15 to 25 s).
//
// Namespace mode:
//   'test' (default for now): every write goes to namespace k2-test, labelled test, counted apart, and
//          recalled test memories are fed to the rules so the whole loop can be shown. Answers carry test: true.
//   'live': verdicts go to namespace live, outcomes to shared-outcomes.
import { createHash } from 'node:crypto';
import { analyze } from './engine/index.js';
import { classifyHub } from './engine/exchanges.js';
import { funderTouches } from './engine/sharedFunder.js';
import { sponsoredSenders } from './engine/gasSponsor.js';
import { buildVerdict } from './engine/verdict.js';
import { compareTx } from './providers/crosscheck.js';
import { callLog } from './providers/index.js';
import { isSuiAddress, padAddress } from './address.js';

const SUI_SUFFIX = '::sui::SUI';
const isSui = (b) => typeof b.coin === 'string' && b.coin.endsWith(SUI_SUFFIX);
const tsMs = (t) => Date.parse(t.timestamp ?? '');

export const groupIdOf = (address) => `g-${createHash('sha256').update(padAddress(String(address)) ?? String(address).toLowerCase()).digest('hex').slice(0, 8)}`;

/** Turn one provider listing (Tatum shape) into the plain lists the engine reads. Pure. */
export function engineInputs(wallet, txs) {
  const w = (padAddress(wallet) ?? wallet.toLowerCase());
  const ok = txs.filter((t) => t.status === 'SUCCESS');
  const incoming = [];
  const sent = [];
  const outbound = [];
  for (const t of ok) {
    const timestampMs = tsMs(t);
    const gain = t.balanceChanges.filter((b) => isSui(b) && b.owner === w && BigInt(b.amount) > 0n).reduce((s, b) => s + BigInt(b.amount), 0n);
    if (t.sender !== w && gain > 0n) incoming.push({ digest: t.digest, sender: t.sender, recipient: w, amount: gain.toString(), timestampMs });
    if (t.sender === w) {
      sent.push({ digest: t.digest, sender: t.sender, gasSponsor: t.gasSponsor, timestampMs });
      for (const b of t.balanceChanges) {
        if (isSui(b) && b.owner && b.owner !== w && BigInt(b.amount) > 0n) outbound.push({ recipient: b.owner, digest: t.digest, timestampMs });
      }
    }
  }
  return { incoming, sent, outbound };
}

/** The funder's own payouts (who it sent SUI to), from the funder's listing. Pure. */
export function payoutsOf(funder, txs) {
  const f = (padAddress(funder) ?? funder.toLowerCase());
  const out = [];
  for (const t of txs) {
    if (t.status !== 'SUCCESS' || t.sender !== f) continue;
    for (const b of t.balanceChanges) {
      if (isSui(b) && b.owner && b.owner !== f && BigInt(b.amount) > 0n) out.push({ recipient: b.owner, digest: t.digest, timestampMs: tsMs(t) });
    }
  }
  return out;
}

function withTimeout(p, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms); timer.unref?.(); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function createChecker({ tatum, ankr = null, memory, mode = 'test', recallTimeoutMs = 25000, now = () => Date.now() } = {}) {
  const test = mode !== 'live';
  const ns = {
    verdict: test ? 'k2-test' : 'live',
    outcome: test ? 'k2-test' : 'shared-outcomes',
    recall: test ? ['k2-test'] : ['live', 'shared-outcomes'],
  };
  const origin = test ? 'k2-test' : 'check';
  const state = { lastRecallOk: null, lastRecallError: null };

  // Everything read from the chain for one wallet.
  async function gather(wallet) {
    const page = await tatum.listTransactions(wallet, { first: 50 });
    const inputs = engineInputs(wallet, page.transactions);
    const first = inputs.incoming.slice().sort((a, b) => a.timestampMs - b.timestampMs)[0];
    const funder = first?.sender ?? null;
    const sponsorTx = inputs.sent.slice(0, 5).find((t) => t.gasSponsor && t.gasSponsor !== wallet);
    const sponsor = sponsorTx?.gasSponsor ?? null;
    const lists = new Map();
    const listOf = async (a) => {
      if (!lists.has(a)) lists.set(a, tatum.listTransactions(a, { first: 50 }).catch((e) => ({ error: e, transactions: [], hasNextPage: false })));
      return lists.get(a);
    };
    const [fl, sl] = await Promise.all([funder ? listOf(funder) : null, sponsor ? listOf(sponsor) : null]);
    const funderPayouts = funder && !fl.error ? payoutsOf(funder, fl.transactions) : [];
    const analysis = analyze(wallet, { incoming: inputs.incoming, sent: inputs.sent, outbound: inputs.outbound, funderPayouts, otherFundings: [], funderOfFunder: null });
    const hubs = {};
    if (funder && !fl.error) hubs.funder = classifyHub(funderTouches(funderPayouts), { capped: fl.hasNextPage });
    if (sponsor && !sl.error) {
      const touches = sponsoredSenders(sponsor, sl.transactions.map((t) => ({ sender: t.sender, gasSponsor: t.gasSponsor, timestampMs: tsMs(t) })));
      hubs.sponsor = classifyHub(touches, { capped: sl.hasNextPage });
    }
    const groupIds = [funder && groupIdOf(funder), sponsor && groupIdOf(sponsor)].filter(Boolean);
    const sf = analysis.sharedFunder;
    const groupId = sf?.groupSize > 0 && funder ? groupIdOf(funder) : (sponsor && !hubs.sponsor?.verdict?.startsWith('shared') ? groupIdOf(sponsor) : null);
    const notes = [];
    if (page.hasNextPage) notes.push('Only the oldest 50 transactions of this wallet were read.');
    if (fl?.error) notes.push('The funder history could not be read, so the shared service check was skipped.');
    if (sl?.error) notes.push('The gas sponsor history could not be read.');
    return { page, analysis, hubs, funder, sponsor, groupId, groupIds, notes, links: { firstDigest: first?.digest ?? null, sponsorDigest: sponsorTx?.digest ?? null } };
  }

  // Ankr cross-check of the links that matter (first funding and first sponsored transaction), by digest.
  async function crossCheck(wallet, page, links) {
    if (!ankr) return { used: false, note: 'Ankr is not configured.' };
    const want = [links.firstDigest, links.sponsorDigest].filter(Boolean);
    const unique = [...new Set(want)];
    if (!unique.length) return { used: true, checked: 0, agree: 0, disagreements: [], note: 'No links to cross-check.' };
    try {
      const results = [];
      for (const d of unique) {
        const t = page.transactions.find((x) => x.digest === d);
        results.push({ digest: d, ...compareTx(t, await ankr.transactionByDigest(d), wallet) });
      }
      return { used: true, checked: results.length, agree: results.filter((r) => r.agree).length, disagreements: results.filter((r) => !r.agree) };
    } catch (e) {
      return { used: true, checked: 0, agree: 0, disagreements: [], note: `Ankr could not be reached (${String(e.message || e).slice(0, 80)}).` };
    }
  }

  // Exact recall for the wallet, its funder, its gas sponsor and their group ids. A failure never blocks the answer.
  async function recallAll(wallet, funder, sponsor, groupIds) {
    const asks = [];
    for (const namespace of ns.recall) {
      asks.push({ namespace, address: wallet });
      if (funder) asks.push({ namespace, address: funder });
      if (sponsor) asks.push({ namespace, address: sponsor });
      for (const g of groupIds) asks.push({ namespace, group: g });
    }
    const settled = await Promise.allSettled(asks.map((q) => withTimeout(memory.recall(q).catch(() => memory.recall(q)), recallTimeoutMs, 'memory recall').then((r) => r.map((m) => ({ ...m, namespace: q.namespace })))));
    const failed = settled.filter((s) => s.status === 'rejected');
    state.lastRecallOk = failed.length === 0;
    state.lastRecallError = failed.length ? String(failed[0].reason?.message || failed[0].reason).slice(0, 120) : null;
    const seen = new Set();
    const out = [];
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      for (const m of s.value) {
        const id = m.blobId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(m);
      }
    }
    return { memories: out, ok: failed.length === 0, error: state.lastRecallError };
  }

  // In test mode the labelled test memories are read by the rules (the verdict rules otherwise ignore k2-test).
  const forRules = (memories) => (test ? memories.map((m) => ({ ...m, origin: 'test-run', namespace: 'test-run' })) : memories);

  // Each check counts only its own provider calls, so checks running at the same time never mix their numbers.
  const check = (address, opts = {}) => callLog.withRecorder((own) => runCheck(address, opts, own));

  async function runCheck(address, { memoryOn = true } = {}, own) {
    const t0 = now();
    const base = { address, memoryOn, test, namespace: ns.verdict };
    if (!isSuiAddress(address)) {
      return { ...base, ...buildVerdict({ wallet: address }), memory: { used: 0, recalled: 0, recallOk: true }, write: { count: 0, state: 'none' }, tookMs: now() - t0 };
    }
    const wallet = padAddress(address);
    let g = null;
    let chainError = null;
    try { g = await gather(wallet); } catch (e) { chainError = String(e.message || e).slice(0, 160); }

    // Recall runs for the wallet even if the chain read failed (a stored bad report still counts).
    const recalled = await recallAll(wallet, g?.funder ?? null, g?.sponsor ?? null, g?.groupIds ?? []);
    const [cross, checkpoint] = g ? await Promise.all([
      crossCheck(wallet, g.page, g.links),
      tatum.latestCheckpoint().catch(() => null),
    ]) : [null, null];

    const verdict = buildVerdict({
      wallet,
      analysis: g?.analysis ?? null,
      memories: forRules(recalled.memories),
      groupId: g?.groupId ?? null,
      hubs: g?.hubs ?? {},
      memoryOn,
      now: now(),
    });
    if (verdict.changedByMemory) memory.markChanged(verdict.changedByIds);

    // Queue the verdict memory in the background and return at once.
    const tatumSummary = own('tatum');
    let write = { count: 0, state: 'none' };
    if (g && !['INVALID_INPUT', 'DATA_UNAVAILABLE'].includes(verdict.code)) {
      const group = g.groupIds[0] ?? null;
      const e = memory.enqueue({
        namespace: ns.verdict, kind: 'verdict', address: wallet, group, origin,
        body: {
          test, verdict: verdict.verdict, code: verdict.code, label: verdict.label,
          funder: g.funder, gasSponsor: g.sponsor, groupId: g.groupId,
          links: verdict.evidence.filter((x) => x.kind === 'link').length,
          checkpoint, tatumCalls: tatumSummary.calls, checkedAt: new Date(now()).toISOString(),
        },
      });
      write = { count: 1, state: e.state, key: e.key, namespace: ns.verdict, note: 'saving in the background, 15 to 25 s' };
    }

    return {
      ...base,
      ...verdict,
      memory: { used: verdict.memoryIds.length, recalled: recalled.memories.length, recallOk: recalled.ok, recallError: recalled.error, degraded: !recalled.ok },
      write,
      dataAsOfCheckpoint: checkpoint,
      crossCheck: cross,
      notes: [...(g?.notes ?? []), ...(chainError ? [`Chain data could not be read (${chainError}).`] : [])],
      callLog: { tatum: tatumSummary, ankr: own('ankr') },
      tookMs: now() - t0,
    };
  }

  // Report how a payment went. Waits for its memory write(s). One memory per group id so every linked wallet can find it.
  async function reportOutcome(address, outcome, { reporter = 'cli' } = {}) {
    if (!isSuiAddress(address)) throw new Error('Not a Sui address');
    if (!['bad', 'good'].includes(outcome)) throw new Error('outcome must be bad or good');
    const wallet = padAddress(address);
    const g = await gather(wallet);
    const groups = g.groupIds.length ? g.groupIds : [null];
    const written = [];
    for (const group of groups) {
      const e = await memory.write({
        namespace: ns.outcome, kind: 'outcome', address: wallet, group, origin,
        body: { test, outcome, reporter, funder: g.funder, gasSponsor: g.sponsor, reportedAt: new Date(now()).toISOString() },
      });
      written.push({ group, state: e.state, blobId: e.blobId, error: e.error });
    }
    return { address: wallet, outcome, test, namespace: ns.outcome, written };
  }

  return { check, reportOutcome, gather, mode: test ? 'test' : 'live', state };
}
