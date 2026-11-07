// Reading more than 50 transactions: paging through the Tatum client with a fake paged answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTatum, listHistory, clampMaxTx, FLOOR_CHECKPOINT } from '../../src/providers/tatum.js';
import { createChecker } from '../../src/check.js';
import * as callLog from '../../src/providers/callLog.js';

const WALLET = `0x${'a'.repeat(63)}1`;
const OTHER = `0x${'b'.repeat(63)}2`;
const TOTAL = 260; // the fake wallet has 260 transactions
const noWait = async () => {};
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const node = (i) => ({
  digest: `D${String(i).padStart(4, '0')}${'x'.repeat(30)}`,
  sender: { address: OTHER },
  gasInput: { gasSponsor: { address: OTHER } },
  effects: { status: 'SUCCESS', timestamp: new Date(1_800_000_000_000 + i * 1000).toISOString(), checkpoint: { sequenceNumber: FLOOR_CHECKPOINT + i }, balanceChanges: { nodes: [] } },
});

// Serves 260 transactions in pages of up to 50 with cursors "c<offset>".
function pagedFetch(queries) {
  return async (_url, init) => {
    const q = JSON.parse(init.body).query;
    queries.push(q);
    if (!q.includes('transactions(')) return json({ data: { checkpoint: { sequenceNumber: 1 } } });
    const first = Number(/first:(\d+)/.exec(q)[1]);
    const off = Number((/after:"c(\d+)"/.exec(q) ?? [])[1] ?? 0);
    const end = Math.min(off + first, TOTAL);
    const nodes = Array.from({ length: end - off }, (_, k) => node(off + k));
    return json({ data: { transactions: { pageInfo: { hasNextPage: end < TOTAL, endCursor: `c${end}` }, nodes } } });
  };
}
const client = (queries) => createTatum({ key: 'k', fetchImpl: pagedFetch(queries), limiter: noWait, retryWaitMs: 1 });

test('clampMaxTx keeps 50 to 200 in whole pages', () => {
  assert.equal(clampMaxTx(undefined), 50);
  assert.equal(clampMaxTx(10), 50);
  assert.equal(clampMaxTx('abc'), 50);
  assert.equal(clampMaxTx(120), 150);
  assert.equal(clampMaxTx(200), 200);
  assert.equal(clampMaxTx(5000), 200);
});

test('maxTx 50 is exactly one call, as before', async () => {
  const queries = [];
  const r = await listHistory(client(queries), WALLET, { maxTx: 50 });
  assert.equal(queries.length, 1);
  assert.equal(r.transactions.length, 50);
  assert.equal(r.hasNextPage, true);
});

test('maxTx 200 pages four times, every page keeps afterCheckpoint, newer pages follow older', async () => {
  const queries = [];
  const r = await listHistory(client(queries), WALLET, { maxTx: 200 });
  assert.equal(queries.length, 4);
  for (const q of queries) assert.match(q, new RegExp(`afterCheckpoint:${FLOOR_CHECKPOINT}`));
  assert.equal(r.transactions.length, 200);
  assert.equal(r.hasNextPage, true);
  assert.equal(r.pagesRead, 4);
  assert.equal(new Set(r.transactions.map((t) => t.digest)).size, 200);
  assert.equal(r.oldestCheckpoint, FLOOR_CHECKPOINT);
});

test('a short history stops early and reports no more pages', async () => {
  const queries = [];
  const fetchImpl = async (_u, init) => {
    queries.push(JSON.parse(init.body).query);
    return json({ data: { transactions: { pageInfo: { hasNextPage: false, endCursor: 'z' }, nodes: [node(0), node(1)] } } });
  };
  const t = createTatum({ key: 'k', fetchImpl, limiter: noWait, retryWaitMs: 1 });
  const r = await listHistory(t, WALLET, { maxTx: 200 });
  assert.equal(queries.length, 1);
  assert.equal(r.transactions.length, 2);
  assert.equal(r.hasNextPage, false);
});

test('a checker at maxTx 200 makes at most 4 list calls per wallet, funder and sponsor, and counts them', async () => {
  const queries = [];
  const checker = createChecker({ tatum: client(queries), maxTx: 200, memory: { recall: async () => [], enqueue: () => ({ state: 'none' }), markChanged() {} } });
  const since = callLog.mark();
  const r = await checker.check(WALLET, { memoryOn: false });
  const lists = queries.filter((q) => q.includes('transactions(')).length;
  assert.ok(lists >= 4 && lists <= 12, `list calls ${lists}`);
  assert.equal(r.callLog.tatum.byType.listTransactions, lists);
  assert.equal(callLog.summarize(since, 'tatum').byType.listTransactions, lists);
  assert.ok(r.notes.some((n) => n.includes('oldest 200')));
});

test('default checker still reads one page of 50 per wallet', async () => {
  const queries = [];
  const checker = createChecker({ tatum: client(queries), memory: { recall: async () => [], enqueue: () => ({ state: 'none' }), markChanged() {} } });
  const r = await checker.check(WALLET, { memoryOn: false });
  assert.ok(r.notes.some((n) => n.includes('oldest 50')));
  const first = queries.find((q) => q.includes(WALLET));
  assert.match(first, /first:50/);
  assert.doesNotMatch(first, /after:"/);
});
