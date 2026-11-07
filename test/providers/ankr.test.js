import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAnkr, DEPTH_NOTE } from '../../src/providers/ankr.js';
import { compareTx, crossCheck } from '../../src/providers/crosscheck.js';
import { SUI_COIN } from '../../src/providers/tatum.js';
import * as callLog from '../../src/providers/callLog.js';

const rec = (n) => JSON.parse(readFileSync(new URL(`../recorded/${n}.json`, import.meta.url), 'utf8'));
const noWait = async () => {};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const A = rec('ankr_queryTo').address;

function client(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => { const b = JSON.parse(init.body); calls.push(b); return handler(b, calls.length); };
  return { k: createAnkr({ key: 'k', fetchImpl, limiter: noWait }), calls };
}

test('listing returns Tatum-shaped transactions, oldest first', async () => {
  const a = client((b) => json(b.params[0].filter?.FromAddress ? { result: { data: [], hasNextPage: false, nextCursor: null } } : rec('ankr_queryTo').response));
  const page = await a.k.listTransactions(A, { first: 3 });
  assert.equal(page.transactions.length, 3);
  const t = page.transactions[0];
  for (const f of ['digest', 'sender', 'gasSponsor', 'sponsored', 'status', 'timestamp', 'checkpoint', 'balanceChanges']) assert.ok(f in t, f);
  assert.equal(t.status, 'SUCCESS');
  assert.ok(page.transactions[0].checkpoint <= page.transactions[2].checkpoint);
  assert.equal(page.oldestCheckpoint, page.transactions[0].checkpoint);
  assert.equal(page.reachedDepthLimit, false);
  assert.ok(page.cursor);
});

test('SUI is spelled the same way as Tatum', async () => {
  const a = client(() => json(rec('ankr_txByDigest').response));
  const tx = await a.k.transactionByDigest('GAwqeqEuWQaYFQbuQyqVPLJAtnEJXfT6PisxpeA2DnkC');
  assert.ok(tx.balanceChanges.some((b) => b.coin === SUI_COIN));
  assert.match(tx.gasSponsor, /^0x[0-9a-f]{64}$/);
});

test('empty listing reports a depth limit, not silence', async () => {
  const a = client(() => json({ result: { data: [], hasNextPage: false, nextCursor: null } }));
  const page = await a.k.listTransactions(A);
  assert.equal(page.reachedDepthLimit, true);
  assert.equal(page.oldestCheckpoint, null);
  assert.equal(page.depthNote, DEPTH_NOTE);
});

test('balance and latest checkpoint parse recorded answers', async () => {
  const a = client((b) => json(b.method === 'suix_getBalance' ? rec('ankr_balance').response : rec('ankr_latestCheckpoint').response));
  assert.match(await a.k.balance(A), /^\d+$/);
  assert.ok((await a.k.latestCheckpoint()) > 300000000);
});

test('unknown digest gives null; bad input is refused before any call', async () => {
  const a = client(() => json({ error: { code: -32602, message: 'Could not find the referenced transaction' } }));
  assert.equal(await a.k.transactionByDigest('GAwqeqEuWQaYFQbuQyqVPLJAtnEJXfT6PisxpeA2DnkC'), null);
  await assert.rejects(a.k.balance('nope'), /Not a Sui address/);
  assert.equal(a.calls.length, 1);
});

test('failed calls are logged as failed', async () => {
  callLog.reset();
  const a = client(() => json({}, 500));
  await assert.rejects(a.k.balance(A), /HTTP 500/);
  assert.equal(callLog.summarize(0, 'ankr').failed, 1);
});

test('compareTx agrees on identical links and names the difference otherwise', async () => {
  const a = client(() => json(rec('ankr_txByDigest').response));
  const tx = await a.k.transactionByDigest('GAwqeqEuWQaYFQbuQyqVPLJAtnEJXfT6PisxpeA2DnkC');
  assert.equal(compareTx(tx, { ...tx }, A).agree, true);
  assert.match(compareTx(tx, { ...tx, gasSponsor: '0xabc' }, A).reason, /gas sponsor/);
  assert.equal(compareTx(tx, null, A).agree, false);
});

test('crossCheck counts agreement and flags a shallower Ankr history', async () => {
  const ankrA = client(() => json(rec('ankr_txByDigest').response));
  const tx = await ankrA.k.transactionByDigest('GAwqeqEuWQaYFQbuQyqVPLJAtnEJXfT6PisxpeA2DnkC');
  const tatum = { listTransactions: async () => ({ transactions: [tx, { ...tx, digest: 'other', sender: '0x1' }], oldestCheckpoint: 5 }) };
  const ankr = {
    transactionByDigest: async (d) => (d === tx.digest ? tx : { ...tx, digest: d }),
    listTransactions: async () => ({ transactions: [], oldestCheckpoint: null, reachedDepthLimit: true }),
  };
  const r = await crossCheck({ tatum, ankr, address: A });
  assert.equal(r.checked, 2);
  assert.equal(r.agree, 1);
  assert.equal(r.disagreements.length, 1);
  assert.equal(r.ankrListingEmpty, true);
  assert.ok(r.depthNote);
});
