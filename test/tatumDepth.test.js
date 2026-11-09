import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChecker } from '../src/check.js';
import { createTatum, normalizeSnapshot, RATE_ENDPOINT } from '../src/providers/tatum.js';
import { createPaidCheck } from '../src/paid.js';
import * as callLog from '../src/providers/callLog.js';

const rec = (n) => JSON.parse(readFileSync(new URL(`./recorded/${n}.json`, import.meta.url), 'utf8'));
const pick = rec('pick');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const noWait = async () => {};
const fakeMemory = () => ({ recall: async () => [], enqueue: () => ({ state: 'pending', key: 'k' }), markChanged() {} });
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

// A shape taken from a live Tatum answer for a funded wallet (10 Nov 2026), trimmed.
const liveShape = {
  balances: { pageInfo: { hasNextPage: false }, nodes: [
    { coinType: { repr: SUI }, totalBalance: '90950972652', coinMetadata: { symbol: 'SUI', decimals: 9 } },
    { coinType: { repr: '0xabc::foo::FOO' }, totalBalance: '5', coinMetadata: { symbol: 'FOO', decimals: 6 } },
  ] },
  objects: { pageInfo: { hasNextPage: true }, nodes: [
    { contents: { type: { repr: `0x2::coin::Coin<${SUI}>` } } },
    { contents: { type: { repr: '0xdef::nft::Hero' } } },
    { contents: { type: { repr: '0xdef::nft::Hero' } } },
  ] },
  defaultNameRecord: { domain: 'someone.sui' },
};

test('a holdings answer becomes plain counts: coins, objects, non-coin objects and the name', () => {
  const s = normalizeSnapshot(liveShape);
  assert.equal(s.coinTypes, 2);
  assert.equal(s.coins[0].symbol, 'SUI');
  assert.equal(s.objects, 3);
  assert.equal(s.objectsMore, true);
  assert.equal(s.otherObjects, 2);
  assert.deepEqual(s.otherKinds, ['Hero']);
  assert.equal(s.name, 'someone.sui');
  const empty = normalizeSnapshot({ balances: { nodes: [] }, objects: { nodes: [] }, defaultNameRecord: null });
  assert.deepEqual([empty.coinTypes, empty.objects, empty.name], [0, 0, null]);
});

test('walletSnapshot sends one query and returns null for an unknown shape', async () => {
  const qs = [];
  const fetchImpl = async (_u, init) => { qs.push(JSON.parse(init.body).query); return json({ data: { address: liveShape } }); };
  const t = createTatum({ key: 'k', fetchImpl, limiter: noWait });
  assert.equal((await t.walletSnapshot(pick.addr)).coinTypes, 2);
  assert.equal(qs.length, 1);
  const t2 = createTatum({ key: 'k', fetchImpl: async () => json({ data: { address: null } }), limiter: noWait });
  assert.equal(await t2.walletSnapshot(pick.addr), null);
});

test('exchangeRate reads the SUI price, counts as a Tatum call and refuses an odd answer', async () => {
  const urls = [];
  const ok = async (u, init) => { urls.push([u, init.headers['x-api-key']]); return json({ value: '0.84', basePair: 'USD', symbol: 'SUI', source: 'CoinGecko', timestamp: 1 }); };
  const t = createTatum({ key: 'k', fetchImpl: ok, limiter: noWait });
  const r = await callLog.withRecorder(async (own) => { const v = await t.exchangeRate('SUI', 'USD'); assert.equal(own('tatum').byType.exchangeRate, 1); return v; });
  assert.equal(r.value, 0.84);
  assert.ok(urls[0][0].startsWith(RATE_ENDPOINT));
  assert.match(urls[0][0], /symbol=SUI&basePair=USD/);
  const bad = createTatum({ key: 'k', fetchImpl: async () => json({ nope: 1 }), limiter: noWait });
  await assert.rejects(bad.exchangeRate('SUI', 'USD'));
  const down = createTatum({ key: 'k', fetchImpl: async () => json({}, 500), limiter: noWait });
  await assert.rejects(down.exchangeRate('SUI', 'USD'));
});

function checkerWith({ chainFacts, snapshotFails = false, gasFails = false } = {}) {
  const seen = [];
  const fetchImpl = async (_u, init) => {
    const q = JSON.parse(init.body).query;
    seen.push(q);
    if (q.includes('balances(first:20)')) return snapshotFails ? json({}, 500) : json({ data: { address: liveShape } });
    if (q.includes('referenceGasPrice')) return gasFails ? json({}, 500) : json({ data: { epoch: { referenceGasPrice: '100' } } });
    if (q.includes('transactions(')) return json(rec('listTransactions').response);
    if (q.includes('asObject')) return json({ data: { address: { balance: { totalBalance: '1000' }, asObject: null } } });
    return json(rec('latestCheckpoint').response);
  };
  const tatum = createTatum({ key: 'k', fetchImpl, limiter: noWait, retryWaitMs: 1 });
  return { checker: createChecker({ tatum, memory: fakeMemory(), chainFacts }), seen };
}

test('holdings are off by default: same calls as before and no chainFacts in the answer', async () => {
  const { checker, seen } = checkerWith({});
  const r = await checker.check(pick.addr, { memoryOn: false });
  assert.equal(r.chainFacts, undefined);
  assert.ok(!seen.some((q) => q.includes('balances(first:20)') || q.includes('referenceGasPrice')));
});

test('with holdings on, the answer carries holdings and the fee, and the verdict is exactly the same', async () => {
  const off = await checkerWith({}).checker.check(pick.addr, { memoryOn: false });
  const on = await checkerWith({ chainFacts: true }).checker.check(pick.addr, { memoryOn: false });
  assert.equal(on.chainFacts.wallet.coinTypes, 2);
  assert.equal(on.chainFacts.referenceGasPrice, 100);
  for (const k of ['verdict', 'code', 'label', 'reason', 'evidence', 'memoryIds']) assert.deepEqual(on[k], off[k], k);
  assert.ok(on.callLog.tatum.calls > off.callLog.tatum.calls);
  assert.equal(on.callLog.tatum.list.length, on.callLog.tatum.calls);
  assert.ok(on.callLog.tatum.list.every((c) => typeof c.type === 'string' && Number.isFinite(c.ms)));
});

test('if the holdings or the fee cannot be read, the check still answers the same', async () => {
  const base = await checkerWith({}).checker.check(pick.addr, { memoryOn: false });
  const a = await checkerWith({ chainFacts: true, snapshotFails: true }).checker.check(pick.addr, { memoryOn: false });
  assert.equal(a.code, base.code);
  assert.equal(a.chainFacts.wallet, null);
  assert.equal(a.chainFacts.referenceGasPrice, 100);
  const b = await checkerWith({ chainFacts: true, snapshotFails: true, gasFails: true }).checker.check(pick.addr, { memoryOn: false });
  assert.equal(b.code, base.code);
  assert.equal(b.chainFacts, undefined);
});

test('the paid check shows its price in dollars from Tatum, and still asks without it if the rate is down', async () => {
  const PAYEE = `0x${'c'.repeat(64)}`;
  const mk = (tatum) => createPaidCheck({ tatum, checker: { check: async (a) => ({ address: a }) }, payee: PAYEE });
  const r = await mk({ exchangeRate: async () => ({ value: 0.8 }) }).handle({ address: `0x${'a'.repeat(64)}` });
  assert.equal(r.status, 402);
  assert.equal(r.body.payment.rate.suiInUsd, 0.8);
  assert.ok(Math.abs(r.body.payment.approxUsd - Number(r.body.payment.amountSui) * 0.8) < 0.000002);
  const d = await mk({ exchangeRate: async () => { throw new Error('down'); } }).handle({ address: `0x${'a'.repeat(64)}` });
  assert.equal(d.status, 402);
  assert.equal(d.body.payment.approxUsd, undefined);
});
