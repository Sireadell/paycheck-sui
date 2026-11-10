// The payee check: read the wallet's history, find links, recall memory, give a verdict, queue a verdict memory.
// Reads go through src/providers. The verdict itself comes from src/engine/verdict.js.
// Memory writes go through the background queue, so a check never waits for them (a write takes 15 to 25 s).
//
// Namespace mode:
//   'test' (default for now): every write goes to namespace k2-test, labelled test, counted apart, and
//          recalled test memories are fed to the rules so the whole loop can be shown. Answers carry test: true.
//   'live': verdicts go to namespace live, outcomes to shared-outcomes.
//   'bench': the benchmark. Reads and writes only namespace bench-train, never live. Answers are not marked test.
import { createHash } from 'node:crypto';
import { analyze } from './engine/index.js';
import { classifyHub } from './engine/exchanges.js';
import { funderTouches } from './engine/sharedFunder.js';
import { sponsoredSenders } from './engine/gasSponsor.js';
import { buildVerdict } from './engine/verdict.js';
import { walletProfile, fanOutFacts } from './engine/profile.js';
import { compareTx } from './providers/crosscheck.js';
import { callLog } from './providers/index.js';
import { listHistory, clampMaxTx } from './providers/tatum.js';
import { parseAddress, isSuiAddress, padAddress } from './address.js';

const SUI_SUFFIX = '::sui::SUI';
export const SECOND_HOP_CALLS = 2; // most extra Tatum reads one check may spend on the second hop
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

/** What the chain says this payee is, from one gathered read. Unknown stays unknown (null), never "nothing there". */
export function payeeFacts(g) {
  if (!g?.profile) return null;
  const empty = g.page.transactions.length === 0 && !g.page.hasNextPage && /^0+$/.test(g.profile.balance) && !g.profile.isObject;
  return { kind: g.profile.isPackage ? 'package' : g.profile.isObject ? 'object' : null, noHistory: empty };
}

export function createChecker({ tatum, ankr = null, memory, mode = 'test', recallTimeoutMs = 25000, now = () => Date.now(), maxTx = 50, chainFacts = false } = {}) {
  // How many transactions of a wallet, its funder and its gas sponsor are read (50 default, up to 200, 4 calls at most per list).
  const depth = clampMaxTx(maxTx);
  const bench = mode === 'bench';
  const test = mode !== 'live' && !bench;
  const ns = bench
    ? { verdict: 'bench-train', outcome: 'bench-train', recall: ['bench-train'] }
    : {
      verdict: test ? 'k2-test' : 'live',
      outcome: test ? 'k2-test' : 'shared-outcomes',
      recall: test ? ['k2-test'] : ['live', 'shared-outcomes'],
    };
  const origin = bench ? 'bench-train' : test ? 'k2-test' : 'check';
  const state = { lastRecallOk: null, lastRecallError: null };

  // Everything read from the chain for one wallet.
  async function gather(wallet) {
    // The address profile (balance, object or package) is read at the same time as the first page of history.
    const [page, profile] = await Promise.all([
      listHistory(tatum, wallet, { maxTx: depth }),
      Promise.resolve().then(() => tatum.addressProfile?.(wallet)).catch(() => null),
    ]);
    const inputs = engineInputs(wallet, page.transactions);
    const first = inputs.incoming.slice().sort((a, b) => a.timestampMs - b.timestampMs)[0];
    const funder = first?.sender ?? null;
    const sponsorTx = inputs.sent.slice(0, 5).find((t) => t.gasSponsor && t.gasSponsor !== wallet);
    const sponsor = sponsorTx?.gasSponsor ?? null;
    const lists = new Map();
    const listOf = async (a) => {
      if (!lists.has(a)) lists.set(a, listHistory(tatum, a, { maxTx: depth }).catch((e) => ({ error: e, transactions: [], hasNextPage: false })));
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
    // Is the wallet itself a shared service (it paid many different wallets)? Read from the same page, no extra call.
    const selfHub = classifyHub(funderTouches(payoutsOf(wallet, page.transactions)), { capped: page.hasNextPage });
    const groupIds = [...new Set([funder && groupIdOf(funder), sponsor && groupIdOf(sponsor)].filter(Boolean))];
    const sf = analysis.sharedFunder;
    const groupId = sf?.groupSize > 0 && funder ? groupIdOf(funder) : (sponsor && !hubs.sponsor?.verdict?.startsWith('shared') ? groupIdOf(sponsor) : null);
    const notes = [];
    if (page.hasNextPage) notes.push(`Only the oldest ${depth} transactions of this wallet were read.`);
    if (!profile && tatum.addressProfile) notes.push('Whether this address is a wallet, a package or an object could not be read, so that check was skipped.');
    if (fl?.error) notes.push('The funder history could not be read, so the shared service check was skipped.');
    if (sl?.error) notes.push('The gas sponsor history could not be read.');
    return { page, profile: profile ?? null, analysis, hubs, walletProfile: walletProfile(wallet, page, now()), funderPage: fl && !fl.error ? fl : null, selfHub, funder, sponsor, groupId, groupIds, notes, links: { firstDigest: first?.digest ?? null, sponsorDigest: sponsorTx?.digest ?? null } };
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

  // Exact recall asks for the wallet, its funder, its gas sponsor and their group ids. The wallet's own asks need nothing from
  // the chain, so they start at once; the rest start when the funder and sponsor are known. A failure never blocks the answer.
  const asksFor = ({ wallet, funder, sponsor, groupIds = [] }) => {
    const asks = [];
    for (const namespace of ns.recall) {
      if (wallet) asks.push({ namespace, address: wallet });
      if (funder) asks.push({ namespace, address: funder });
      if (sponsor) asks.push({ namespace, address: sponsor });
      for (const g of groupIds) asks.push({ namespace, group: g });
    }
    return asks;
  };
  // Each read gets its own time limit and one more try before it counts as failed.
  const readOnce = (q) => withTimeout(Promise.resolve().then(() => memory.recall(q)), recallTimeoutMs, 'memory recall');
  const readTwice = (q) => readOnce(q).catch(() => readOnce(q));
  const readAsks = (asks) => Promise.allSettled(asks.map((q) => readTwice(q).then((r) => r.map((m) => ({ ...m, namespace: q.namespace })))));
  function collect(settled) {
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

  // Extra evidence from Tatum, shown beside the verdict and never used by the verdict rules: what the wallet and its funder hold,
  // and the network fee now. Off unless chainFacts is on. Every read can fail alone; a failure only leaves that part out.
  let gas = { at: 0, value: null };
  const gasNow = () => {
    if (gas.value && now() - gas.at < 60000) return gas.value;
    const p = Promise.resolve().then(() => tatum.referenceGasPrice()).catch(() => null);
    gas = { at: now(), value: p };
    p.then((v) => { if (v == null && gas.value === p) gas = { at: 0, value: null }; });
    return p;
  };
  async function readChainFacts(wallet, funder) {
    if (typeof tatum.walletSnapshot !== 'function') return null;
    const snap = (a) => (a ? Promise.resolve().then(() => tatum.walletSnapshot(a)).catch(() => null) : Promise.resolve(null));
    const [w, f, referenceGasPrice] = await Promise.all([snap(wallet), snap(funder), gasNow()]);
    if (!w && !f && referenceGasPrice == null) return null;
    return { wallet: w, funder: f ? { address: funder, ...f } : null, referenceGasPrice, note: 'Evidence only. These reads never change the verdict.' };
  }

  // Second hop: who funded the first funder. Found in the funder history that is already read (no call). Then at most
  // SECOND_HOP_CALLS more Tatum reads about that wallet: its first page of history (how many wallets it paid) and its address type
  // and balance. Evidence only: never passed to the verdict rules. Any failure drops only the part that failed.
  async function readSecondHop(wallet, g) {
    try {
      if (!g?.funder || !g.funderPage) return null;
      const first = engineInputs(g.funder, g.funderPage.transactions).incoming.slice().sort((a, b) => a.timestampMs - b.timestampMs)[0];
      const base = { of: g.funder, limit: SECOND_HOP_CALLS };
      if (!first) return { ...base, found: false, callsUsed: 0, note: 'The first funder has no incoming SUI in the history read.' };
      const second = first.sender;
      const hop = { ...base, found: true, address: second, digest: first.digest, fundedAt: Number.isFinite(first.timestampMs) ? new Date(first.timestampMs).toISOString() : null };
      if (second === wallet) return { ...hop, circular: true, callsUsed: 0, note: 'The wallet being checked funded its own first funder.' };
      const [hist, prof] = await Promise.all([
        Promise.resolve().then(() => listHistory(tatum, second, { maxTx: 50 })).catch(() => null),
        Promise.resolve().then(() => tatum.addressProfile?.(second)).catch(() => null),
      ]);
      const reach = hist ? fanOutFacts(classifyHub(funderTouches(payoutsOf(second, hist.transactions)), { capped: hist.hasNextPage })) : null;
      return { ...hop, circular: false, callsUsed: SECOND_HOP_CALLS, reach, profile: prof ? { balance: prof.balance, isObject: prof.isObject, isPackage: prof.isPackage } : null, note: hist || prof ? 'Evidence only. These reads never change the verdict.' : 'Both extra reads failed, so only the address is shown.' };
    } catch { return null; }
  }

  // The checkpoint is only a "data as of" label, so one read is shared for 10 seconds.
  let cp = { at: 0, value: null };
  const checkpointNow = () => {
    if (cp.value && now() - cp.at < 10000) return cp.value;
    const p = Promise.resolve().then(() => tatum.latestCheckpoint()).catch(() => null);
    cp = { at: now(), value: p };
    p.then((v) => { if (v == null && cp.value === p) cp = { at: 0, value: null }; });
    return p;
  };

  // In test mode the labelled test memories are read by the rules (the verdict rules otherwise ignore k2-test).
  const forRules = (memories) => (test ? memories.map((m) => ({ ...m, origin: 'test-run', namespace: 'test-run' })) : memories);

  // Each check counts only its own provider calls, so checks running at the same time never mix their numbers.
  const check = (address, opts = {}) => callLog.withRecorder((own) => runCheck(address, opts, own));

  async function runCheck(address, { memoryOn = true, deferWrite = false, originOverride = null, extraBody = null } = {}, own) {
    const t0 = now();
    const base = { address, memoryOn, test, namespace: ns.verdict };
    const parsed = parseAddress(address);
    if (!parsed.ok) {
      return { ...base, ...buildVerdict({ wallet: address, inputError: parsed }), inputCode: parsed.inputCode, memory: { used: 0, recalled: 0, recallOk: true }, write: { count: 0, state: 'none' }, tookMs: now() - t0 };
    }
    const wallet = parsed.address;
    let g = null;
    let chainError = null;
    // With memory switched off nothing is read from memory: the answer cannot use it, so waiting for it would only be slow.
    const walletRecall = memoryOn ? readAsks(asksFor({ wallet })) : null;
    const checkpointP = checkpointNow();
    try { g = await gather(wallet); } catch (e) { chainError = String(e.message || e).slice(0, 160); }

    // Recall runs for the wallet even if the chain read failed (a stored bad report still counts).
    const secondHopP = chainFacts && g ? readSecondHop(wallet, g) : null;
    const restRecall = memoryOn && g ? readAsks(asksFor({ funder: g.funder, sponsor: g.sponsor, groupIds: g.groupIds })) : null;
    const recalled = memoryOn ? collect([...(await walletRecall), ...(restRecall ? await restRecall : [])]) : { memories: [], ok: true, error: null };
    const [cross, checkpoint, facts, secondHop] = g ? await Promise.all([crossCheck(wallet, g.page, g.links), checkpointP, chainFacts ? readChainFacts(wallet, g.funder) : null, secondHopP]) : [null, null, null, null];

    const verdict = buildVerdict({
      wallet,
      analysis: g?.analysis ?? null,
      memories: forRules(recalled.memories),
      groupId: g?.groupId ?? null,
      hubs: g?.hubs ?? {},
      memoryOn,
      memoryDegraded: !recalled.ok,
      payee: payeeFacts(g),
      now: now(),
    });
    if (verdict.changedByMemory) memory.markChanged(verdict.changedByIds);

    // Queue the verdict memory in the background and return at once.
    const tatumSummary = own('tatum');
    let write = { count: 0, state: 'none' };
    let deferred = null;
    if (g && !['INVALID_INPUT', 'DATA_UNAVAILABLE', 'MEMORY_UNAVAILABLE', 'NO_HISTORY', 'PAYEE_NOT_A_WALLET'].includes(verdict.code)) {
      const group = g.groupIds[0] ?? null;
      const item = {
        namespace: ns.verdict, kind: 'verdict', address: wallet, group, origin: originOverride || origin,
        body: {
          ...(extraBody || {}),
          test, verdict: verdict.verdict, code: verdict.code, label: verdict.label,
          funder: g.funder, gasSponsor: g.sponsor, groupId: g.groupId,
          links: verdict.evidence.filter((x) => x.kind === 'link').length,
          checkpoint, tatumCalls: tatumSummary.calls - (secondHop?.callsUsed ?? 0), checkedAt: new Date(now()).toISOString(),
          // New field: which memories changed this answer, so the count can be read back from Walrus after a restart.
          ...(verdict.changedByMemory ? { changedByIds: verdict.changedByIds } : {}),
        },
      };
      if (deferWrite) {
        // Scripts that write in bulk take the memory and write it themselves.
        deferred = item;
        write = { count: 0, state: 'deferred' };
      } else {
        const e = memory.enqueue(item);
        write = { count: 1, state: e.state, key: e.key, namespace: ns.verdict, note: 'saving in the background, 15 to 25 s' };
      }
    }

    return {
      ...base,
      ...verdict,
      memory: { used: verdict.memoryIds.length, recalled: recalled.memories.length, recallOk: recalled.ok, recallError: recalled.error, degraded: !recalled.ok },
      write,
      walletHub: g?.selfHub?.verdict ?? null,
      // Evidence only, never read by the verdict rules.
      walletProfile: g?.walletProfile ?? null,
      funderFanOut: fanOutFacts(g?.hubs?.funder),
      ...(deferred ? { memoryItem: deferred } : {}),
      dataAsOfCheckpoint: checkpoint,
      crossCheck: cross,
      notes: [...(g?.notes ?? []), ...(chainError ? [`Chain data could not be read (${chainError}).`] : [])],
      ...(facts ? { chainFacts: facts } : {}),
      ...(secondHop ? { secondHopFunder: secondHop } : {}),
      callLog: { tatum: { ...own('tatum'), list: own.list('tatum') }, ankr: own('ankr') },
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
    // A bad outcome also leaves a short profile note (first funder, fee payer, age, transactions read) for other agents to recall.
    // It is saved in the background and never changes the verdict rules (they read outcome notes only). A failure to queue it is ignored.
    let profileNote = null;
    if (outcome === 'bad') {
      try {
        const p = g.walletProfile;
        const e = memory.enqueue({
          namespace: ns.outcome, kind: 'lesson', address: wallet, group: groups[0], origin,
          body: {
            test, about: 'bad outcome', reporter,
            profile: { firstFunder: g.funder, gasSponsor: g.sponsor, ageDays: p?.ageDays ?? null, txsRead: p?.txsRead ?? 0, historyCapped: Boolean(p?.capped), received: p?.received ?? 0, sent: p?.sent ?? 0 },
            savedAt: new Date(now()).toISOString(),
          },
        });
        profileNote = { state: e.state, key: e.key };
      } catch { /* the outcome is already saved; the profile note is extra */ }
    }
    return { address: wallet, outcome, test, namespace: ns.outcome, written, ...(profileNote ? { profileNote } : {}) };
  }

  return { check, reportOutcome, gather, mode: bench ? 'bench' : test ? 'test' : 'live', state };
}
