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

test('listing always carries afterCheckpoint', async () => {
  const a = client(() => json(rec('listTransactions').response));
  const page = await a.t.listTransactions(pick.addr);
  assert.match(a.calls[0], new RegExp(`afterCheckpoint:${FLOOR_CHECKPOINT}`));
  assert.ok(page.transactions.length > 0);
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

test('short and mixed-case addresses are padded to 64 hex in the query', async () => {
  const a = client(() => json(rec('balance').response));
  await a.t.balance('0x1');
  await a.t.balance('0xAbC');
  assert.ok(a.calls[0].includes(`address(address:"0x${'0'.repeat(63)}1")`));
  assert.ok(a.calls[1].includes(`address(address:"0x${'0'.repeat(61)}abc")`));
});

test('a timeout is retried at most twice, then fails with a plain message', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; throw new DOMException('timed out', 'TimeoutError'); };
  const t = createTatum({ key: 'k', fetchImpl, limiter: noWait, retryWaitMs: 1 });
  await assert.rejects(t.latestCheckpoint(), /timed out/);
  assert.equal(n, 3);
});

test('a timeout then success returns the answer', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; if (n === 1) throw new DOMException('timed out', 'TimeoutError'); return json(rec('latestCheckpoint').response); };
  const t = createTatum({ key: 'k', fetchImpl, limiter: noWait, retryWaitMs: 1 });
  assert.ok((await t.latestCheckpoint()) > FLOOR_CHECKPOINT);
  assert.equal(n, 2);
});

test('429 is retried at most twice', async () => {
  let n = 0;
  const t = createTatum({ key: 'k', fetchImpl: async () => { n++; return json({}, 429); }, limiter: noWait, retryWaitMs: 1 });
  await assert.rejects(t.latestCheckpoint(), /429/);
  assert.equal(n, 3);
});

test('call log keeps at most 5000 entries', () => {
  callLog.reset();
  for (let i = 0; i < callLog.MAX_ENTRIES + 10; i++) callLog.record('tatum', 'x', 1, true);
  assert.equal(callLog.summarize(0, 'tatum').calls, callLog.MAX_ENTRIES);
  callLog.reset();
});

test('limiter refuses when the waiting line is full', async () => {
  const release = [];
  const acquire = createLimiter({ perSecond: 1, maxQueue: 2, now: () => 0, wait: () => new Promise((r) => release.push(r)) });
  await acquire();
  const a = acquire();
  const b = acquire();
  await assert.rejects(acquire(), /queue is full/);
  release.forEach((r) => r());
  await Promise.all([a, b]);
});
