import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTatum, FLOOR_CHECKPOINT } from '../../src/providers/tatum.js';
import { createLimiter } from '../../src/providers/rateLimit.js';
import * as callLog from '../../src/providers/callLog.js';

const rec = (n) => JSON.parse(readFileSync(new URL(`../recorded/${n}.json`, import.meta.url), 'utf8'));
const pick = rec('pick');
const noWait = async () => {};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function client(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => { const q = JSON.parse(init.body).query; calls.push(q); return handler(q, calls.length); };
  return { t: createTatum({ key: 'k', fetchImpl, limiter: noWait, retryWaitMs: 1 }), calls };
}

test('latest checkpoint and gas price parse recorded answers', async () => {
  const a = client((q) => json(q.includes('epoch') ? rec('referenceGasPrice').response : rec('latestCheckpoint').response));
  assert.ok((await a.t.latestCheckpoint()) > FLOOR_CHECKPOINT);
  assert.equal(await a.t.referenceGasPrice(), 100);
});

test('balance reads total from recorded answer', async () => {
  const a = client(() => json(rec('balance').response));
  assert.match(await a.t.balance(pick.addr), /^\d+$/);
});

test('transaction by digest returns sender, sponsor and balance changes', async () => {
  const a = client(() => json(rec('transactionByDigest').response));
  const tx = await a.t.transactionByDigest(pick.digest);
  assert.equal(tx.digest, pick.digest);
  assert.match(tx.sender, /^0x/);
  assert.match(tx.gasSponsor, /^0x/);
  assert.ok(tx.balanceChanges.length >= 2);
});

test('listing always carries afterCheckpoint and finds first funder', async () => {
  const a = client(() => json(rec('listTransactions').response));
  const page = await a.t.listTransactions(pick.addr);
  assert.match(a.calls[0], new RegExp(`afterCheckpoint:${FLOOR_CHECKPOINT}`));
  assert.ok(page.transactions.length > 0);
  const f = await a.t.firstFunder(pick.addr);
  assert.ok(f.funder === null ? f.olderThanData : /^0x/.test(f.funder));
});

test('no incoming transfer gives the floor message', async () => {
  const a = client(() => json({ data: { transactions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }));
  const f = await a.t.firstFunder(pick.addr);
  assert.equal(f.funder, null);
  assert.equal(f.olderThanData, true);
  assert.match(f.note, /older than our data/);
});

test('429 is retried once, then succeeds', async () => {
  const a = client((q, n) => (n === 1 ? json({}, 429) : json(rec('latestCheckpoint').response)));
  await a.t.latestCheckpoint();
  assert.equal(a.calls.length, 2);
});

test('call log counts calls by type and failures', async () => {
  const since = callLog.mark();
  const a = client((q, n) => (n === 2 ? json({}, 500) : json(rec('latestCheckpoint').response)));
  await a.t.latestCheckpoint();
  await assert.rejects(a.t.latestCheckpoint());
  const s = callLog.summarize(since, 'tatum');
  assert.equal(s.calls, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.byType.latestCheckpoint, 2);
});

test('bad address and digest are rejected before any call', async () => {
  const a = client(() => json({}));
  await assert.rejects(a.t.balance('0x1" } evil'));
  await assert.rejects(a.t.transactionByDigest('x"y'));
  assert.equal(a.calls.length, 0);
});

test('limiter spaces calls at 2.5 a second', async () => {
  let t = 0; const waits = [];
  const acquire = createLimiter({ perSecond: 2.5, now: () => t, wait: async (ms) => { waits.push(ms); t += ms; } });
  for (let i = 0; i < 4; i++) await acquire();
  assert.deepEqual(waits, [400, 400, 400]);
});
