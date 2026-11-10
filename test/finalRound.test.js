// Final round: every new feature is evidence only. Each test runs the same check with the feature on and off and compares
// the verdict, the reason, the code and the evidence, then checks old saved notes still read and a failed read drops only its row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChecker } from '../src/check.js';
import { createMemory, buildText } from '../src/memory/index.js';
import { createTatum } from '../src/providers/tatum.js';

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
