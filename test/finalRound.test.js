// Final round: every new feature is evidence only. Each test runs the same check with the feature on and off and compares
// the verdict, the reason, the code and the evidence, then checks old saved notes still read and a failed read drops only its row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChecker } from '../src/check.js';
import { createMemory, buildText } from '../src/memory/index.js';
import { createTatum } from '../src/providers/tatum.js';
import { record } from '../src/providers/callLog.js';

const rec = (n) => JSON.parse(readFileSync(new URL(`./recorded/${n}.json`, import.meta.url), 'utf8'));
const pick = rec('pick');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const noWait = async () => {};
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const snapshot = { balances: { pageInfo: { hasNextPage: false }, nodes: [{ coinType: { repr: SUI }, totalBalance: '5000000000', coinMetadata: { symbol: 'SUI', decimals: 9 } }] }, objects: { pageInfo: { hasNextPage: false }, nodes: [] }, defaultNameRecord: null };

// The parts of an answer that must never move.
export const core = (r) => ({ verdict: r.verdict, code: r.code, reason: r.reason, label: r.label, evidence: r.evidence, memoryIds: r.memoryIds, changedByMemory: r.changedByMemory, warnedBy: r.warnedBy });

export function tatumFor({ listFor = () => rec('listTransactions').response, snapshotFails = false, seen = [] } = {}) {
  const fetchImpl = async (_u, init) => {
    const q = JSON.parse(init.body).query;
    seen.push(q);
    if (q.includes('balances(first:20)')) return snapshotFails ? json({}, 500) : json({ data: { address: snapshot } });
    if (q.includes('referenceGasPrice')) return json({ data: { epoch: { referenceGasPrice: '100' } } });
    if (q.includes('transactions(')) return json(listFor(q));
    if (q.includes('asObject')) return json({ data: { address: { balance: { totalBalance: '1000' }, asObject: null } } });
    return json(rec('latestCheckpoint').response);
  };
  return createTatum({ key: 'k', fetchImpl, limiter: noWait, retryWaitMs: 1 });
}

const stored = (rows) => ({
  async recall({ query, limit, namespace }) { return rows.filter((r) => r.namespace === namespace).slice(0, limit).map((r) => ({ blobId: r.blob_id, writtenAt: null, distance: 0.5, ...r.parsed })); },
  enqueue: () => ({ state: 'pending', key: 'k' }), markChanged() {}, write: async () => ({ state: 'stored' }),
});

test('item 1: reading the counters back from Walrus does not change an answer', async () => {
  const rows = [{ namespace: 'live', blob_id: 'p1', text: buildText({ kind: 'verdict', address: pick.addr, group: 'g-1', origin: 'prescan' }, { code: 'X' }) }];
  const make = () => createMemory({ sdkFactory: () => ({
    async listMemories() { return { memories: rows.map((r) => ({ blob_id: r.blob_id })), next_cursor: null, has_more: false }; },
    async recall({ namespace }) { return { results: rows.filter((r) => r.namespace === namespace).map((r) => ({ blob_id: r.blob_id, text: r.text })) }; },
    async rememberAndWait(t, ns) { return { id: 'i', blob_id: 'b', namespace: ns }; }, destroy() {},
  }) });
  const cold = make();
  const warm = make();
  await warm.hydrate();
  const a = await createChecker({ tatum: tatumFor(), memory: cold, mode: 'live', chainFacts: true }).check(pick.addr);
  const b = await createChecker({ tatum: tatumFor(), memory: warm, mode: 'live', chainFacts: true }).check(pick.addr);
  assert.deepEqual(core(a), core(b));
  assert.equal(warm.counter().stored, 2); // the one Walrus already held, plus this check's own saved note
});

test('item 1: a verdict note records which memories changed the answer, and only then (a field added, none renamed)', async () => {
  const writes = [];
  const memory = { ...stored([]), enqueue: (item) => { writes.push(item); return { state: 'pending', key: 'k' }; } };
  const checker = createChecker({ tatum: tatumFor(), memory, mode: 'live' });
  await checker.check(pick.addr);
  const body = writes[0].body;
  assert.equal('changedByIds' in body, false);
  for (const k of ['test', 'verdict', 'code', 'label', 'funder', 'gasSponsor', 'groupId', 'links', 'checkpoint', 'tatumCalls', 'checkedAt']) assert.ok(k in body, k);
});

test('item 2: source tags are wording on the page only, every kind of evidence has a plain source, the answer has no new fields', async () => {
  const { sourceTagFor, SOURCE } = await import('../web/tatum-panel.js');
  assert.equal(sourceTagFor({ kind: 'memory' }), 'from a saved report on Walrus Memory');
  assert.equal(sourceTagFor({ kind: 'link', type: 'gas_sponsor' }), 'read from Tatum');
  assert.equal(sourceTagFor({ kind: 'round_trip' }), 'read from Tatum');
  assert.equal(sourceTagFor({ kind: 'weak_link' }), 'worked out by us from Tatum history');
  assert.equal(sourceTagFor({ kind: 'something_new' }), null);
  assert.equal(sourceTagFor(null), null);
  for (const v of Object.values(SOURCE)) assert.ok(!/[—]/.test(v));
  // Nothing in the answer carries a source field: the tags are drawn by the page from the kind of row.
  const r = await createChecker({ tatum: tatumFor(), memory: stored([]), mode: 'live', chainFacts: true }).check(pick.addr);
  assert.ok(r.evidence.every((e) => !('source' in e)));
});

test('item 3: a bad outcome also saves a profile note, a good one does not, and the note changes no answer', async () => {
  const queued = [];
  const written = [];
  const memory = { ...stored([]), write: async (m) => { written.push(m); return { state: 'stored', blobId: 'b' }; }, enqueue: (m) => { queued.push(m); return { state: 'pending', key: 'k-' + queued.length }; } };
  const checker = createChecker({ tatum: tatumFor(), memory, mode: 'live' });
  const good = await checker.reportOutcome(pick.addr, 'good', { reporter: 'agent-a' });
  assert.equal(good.profileNote, undefined);
  assert.equal(queued.length, 0);
  const bad = await checker.reportOutcome(pick.addr, 'bad', { reporter: 'agent-a' });
  assert.equal(bad.profileNote.state, 'pending');
  const n = queued[0];
  assert.equal(n.kind, 'lesson');
  assert.equal(n.namespace, 'shared-outcomes');
  assert.ok(n.address);
  const pr = n.body.profile;
  for (const k of ['firstFunder', 'gasSponsor', 'ageDays', 'txsRead', 'historyCapped', 'received', 'sent']) assert.ok(k in pr, k);
  assert.ok(pr.txsRead > 0);
  // The outcome notes themselves keep their old shape.
  assert.deepEqual(Object.keys(written[written.length - 1].body).sort(), ['funder', 'gasSponsor', 'outcome', 'reportedAt', 'reporter', 'test']);
  // A saved profile note next to the wallet changes nothing in its answer.
  const lessonText = buildText({ kind: n.kind, address: n.address, group: n.group, origin: n.origin }, n.body);
  const withNote = [{ namespace: 'live', blob_id: 'L1', parsed: { kind: 'lesson', address: n.address, group: n.group, origin: 'check', body: n.body } }];
  const a = await createChecker({ tatum: tatumFor(), memory: stored([]), mode: 'live' }).check(pick.addr);
  const b = await createChecker({ tatum: tatumFor(), memory: stored(withNote), mode: 'live' }).check(pick.addr);
  assert.deepEqual(core(a), core(b));
  assert.match(lessonText, /^PAYCHECK v1 kind=lesson /);
});

test('item 3: an old outcome note with no profile still reads back and still stops a payment the same way', async () => {
  const old = [{ namespace: 'shared-outcomes', blob_id: 'O1', parsed: { kind: 'outcome', address: pick.addr, group: null, origin: 'agent-a', body: { outcome: 'bad', reporter: 'agent-a', test: false } } }];
  const r = await createChecker({ tatum: tatumFor(), memory: stored(old), mode: 'live' }).check(pick.addr);
  assert.equal(r.verdict, 'do not pay');
  assert.equal(r.code, 'OUTCOME_BAD_SELF');
});

// ---- item 4: second-hop funder ----
const H = (c) => '0x' + c.repeat(64);
const [W, F, S] = [H('1'), H('2'), H('3')];
const DAY = 86_400_000;
const T0 = Date.parse('2026-06-01T00:00:00Z');
const sui = (owner, amount) => ({ coin: SUI, owner, amount: String(amount) });
const tx = (digest, sender, at, changes, gasSponsor = sender) => ({ digest, sender, gasSponsor, status: 'SUCCESS', checkpoint: 300000000 + Math.floor(at / 60000), timestamp: new Date(at).toISOString(), balanceChanges: changes });
const page = (transactions, hasNextPage = false) => ({ transactions, hasNextPage, cursor: null, oldestCheckpoint: null });

// A small fake Tatum client that records its calls like the real one, so call counts can be checked.
function fakeTatum({ histories, failFor = [], seen = [] }) {
  const call = async (type, address, fn) => {
    seen.push({ type, address });
    const ok = !failFor.includes(`${type}:${address}`);
    record('tatum', type, 1, ok);
    if (!ok) throw new Error('Tatum HTTP 500');
    return fn();
  };
  return {
    seen,
    listTransactions: (a) => call('listTransactions', a, () => page(histories[a] ?? [])),
    addressProfile: (a) => call('addressProfile', a, () => ({ balance: '7000000000', isObject: false, isPackage: false })),
    walletSnapshot: (a) => call('walletSnapshot', a, () => ({ coins: [], coinTypes: 0, objects: 0, otherObjects: 0, name: null })),
    latestCheckpoint: async () => { record('tatum', 'latestCheckpoint', 1, true); return 300000001; },
    referenceGasPrice: async () => { record('tatum', 'referenceGasPrice', 1, true); return 100; },
  };
}
// S funded F, F funded W. S paid 20 other wallets over several days, so it reads as a busy sender.
const sPayouts = Array.from({ length: 20 }, (_, i) => tx('s' + i, S, T0 + i * 0.4 * DAY, [sui(H(String.fromCharCode(97 + (i % 6))) .slice(0, 2) + String(i).padStart(2, '0').repeat(31), 500), sui(S, -500)]));
const histories = {
  [W]: [tx('w1', F, T0 + 5 * DAY, [sui(W, 1000), sui(F, -1000)])],
  [F]: [tx('f1', S, T0 + 2 * DAY, [sui(F, 5000), sui(S, -5000)]), tx('f2', F, T0 + 5 * DAY, [sui(W, 1000), sui(F, -1000)])],
  [S]: sPayouts,
};
const hopChecker = (opts = {}) => {
  const t = fakeTatum({ histories, ...opts });
  return { t, checker: createChecker({ tatum: t, memory: stored([]), mode: 'live', chainFacts: opts.chainFacts ?? true }) };
};

test('item 4: the second hop names who funded the first funder and spends at most 2 extra Tatum calls', async () => {
  const { t, checker } = hopChecker();
  const r = await checker.check(W);
  const h = r.secondHopFunder;
  assert.equal(h.address, S);
  assert.equal(h.of, F);
  assert.equal(h.callsUsed, 2);
  assert.equal(h.limit, 2);
  assert.equal(h.circular, false);
  assert.equal(h.reach.wallets >= 15, true);
  assert.equal(h.profile.balance, '7000000000');
  // The extra reads are exactly: one history page and one address profile of the second funder.
  const extra = t.seen.filter((c) => c.address === S);
  assert.deepEqual(extra.map((c) => c.type).sort(), ['addressProfile', 'listTransactions']);
  assert.equal(r.callLog.tatum.byType.listTransactions, 3);
});

test('item 4: the verdict, reason and evidence are identical with the second hop on and off', async () => {
  const on = await hopChecker({ chainFacts: true }).checker.check(W);
  const off = await hopChecker({ chainFacts: false }).checker.check(W);
  assert.deepEqual(core(on), core(off));
  assert.equal('secondHopFunder' in off, false);
  assert.equal(off.callLog.tatum.calls < on.callLog.tatum.calls, true);
});

test('item 4: the verdict note keeps the same Tatum call count with or without the second hop', async () => {
  const writes = [];
  const mem = { ...stored([]), enqueue: (i) => { writes.push(i); return { state: 'pending', key: 'k' }; } };
  const t = fakeTatum({ histories });
  await createChecker({ tatum: t, memory: mem, mode: 'live', chainFacts: true }).check(W);
  const noHop = fakeTatum({ histories: { ...histories, [F]: [tx('f2', F, T0 + 5 * DAY, [sui(W, 1000), sui(F, -1000)])] } });
  await createChecker({ tatum: noHop, memory: mem, mode: 'live', chainFacts: true }).check(W);
  assert.equal(writes[0].body.tatumCalls, writes[1].body.tatumCalls);
});

test('item 4: if the extra reads fail only that row shrinks and the check still answers', async () => {
  const { checker } = hopChecker({ failFor: [`listTransactions:${S}`, `addressProfile:${S}`] });
  const r = await checker.check(W);
  assert.equal(r.secondHopFunder.address, S);
  assert.equal(r.secondHopFunder.reach, null);
  assert.equal(r.secondHopFunder.profile, null);
  assert.match(r.secondHopFunder.note, /failed/);
  const ref = await hopChecker({ chainFacts: false }).checker.check(W);
  assert.deepEqual(core(r), core(ref));
  assert.ok(r.verdict);
});

test('item 4: no funder of the funder in the history read, or the wallet itself funded its funder, costs no extra calls', async () => {
  const none = hopChecker({ chainFacts: true });
  const a = await createChecker({ tatum: fakeTatum({ histories: { [W]: histories[W], [F]: [histories[F][1]] } }), memory: stored([]), mode: 'live', chainFacts: true }).check(W);
  assert.equal(a.secondHopFunder.found, false);
  assert.equal(a.secondHopFunder.callsUsed, 0);
  const circ = await createChecker({ tatum: fakeTatum({ histories: { [W]: histories[W], [F]: [tx('f1', W, T0 + DAY, [sui(F, 10), sui(W, -10)]), histories[F][1]] } }), memory: stored([]), mode: 'live', chainFacts: true }).check(W);
  assert.equal(circ.secondHopFunder.circular, true);
  assert.equal(circ.secondHopFunder.callsUsed, 0);
  assert.ok(none);
});
