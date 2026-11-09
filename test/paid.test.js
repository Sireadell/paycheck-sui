import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createPaidCheck, BASE_MIST } from '../src/paid.js';
import { createApp } from '../server.js';

const PAYEE = `0x${'c'.repeat(64)}`;
const ADDR = `0x${'a'.repeat(64)}`;
const D1 = '2Wx6UC8XTAzcwfTceurmbPcyFtgDS2cUU2V4wpoEQCve';
const D2 = '3Wx6UC8XTAzcwfTceurmbPcyFtgDS2cUU2V4wpoEQCve';
const SUI = '0x2::sui::SUI';
const NOW = Date.parse('2026-11-09T12:00:00Z');

function setup(txs = {}, opts = {}) {
  const tatum = { async transactionByDigest(d) { return txs[d] ?? null; } };
  const checker = { async check(a) { return { address: a, verdict: 'pay', code: 'X' }; } };
  const paid = createPaidCheck({ tatum, checker, payee: PAYEE, now: () => NOW, ...opts });
  return { paid };
}
const tx = (mist, o = {}) => ({
  status: 'SUCCESS',
  sender: `0x${'d'.repeat(64)}`,
  timestamp: '2026-11-09T11:59:00Z',
  balanceChanges: [{ owner: PAYEE, coin: SUI, amount: String(mist) }, { owner: `0x${'d'.repeat(64)}`, coin: SUI, amount: `-${Number(mist) + 1000}` }],
  ...o,
});

test('no payment: 402 with an amount, the payee and an id', async () => {
  const { paid } = setup();
  const r = await paid.handle({ address: ADDR });
  assert.equal(r.status, 402);
  assert.equal(r.body.payment.payee, PAYEE);
  assert.equal(r.body.payment.coin, 'SUI');
  assert.ok(BigInt(r.body.payment.amountMist) > BASE_MIST);
  assert.ok(r.body.payment.id);
});

test('an exact payment returns the check; the same digest is refused the second time', async () => {
  const txs = {};
  const s = setup(txs);
  const ask = (await s.paid.handle({ address: ADDR })).body.payment;
  txs[D1] = tx(ask.amountMist);
  const ok = await s.paid.handle({ address: ADDR, id: ask.id, digest: D1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.verdict, 'pay');
  assert.equal(ok.body.payment.digest, D1);
  assert.equal(await s.paid.count(), 1);
  const second = (await s.paid.handle({ address: ADDR })).body.payment;
  assert.equal((await s.paid.handle({ address: ADDR, id: second.id, digest: D1 })).status, 409);
});

test('refused: wrong amount, wrong recipient, failed transaction, too old, unknown id, other address, unseen digest', async () => {
  const txs = {};
  const s = setup(txs);
  const p = (await s.paid.handle({ address: ADDR })).body.payment;
  const go = (digest, id = p.id, address = ADDR) => s.paid.handle({ address, id, digest });
  txs[D1] = tx(Number(p.amountMist) - 1);
  assert.equal((await go(D1)).status, 402);
  txs[D1] = tx(p.amountMist, { balanceChanges: [{ owner: `0x${'e'.repeat(64)}`, coin: SUI, amount: p.amountMist }] });
  assert.equal((await go(D1)).status, 402);
  txs[D1] = tx(p.amountMist, { status: 'FAILURE' });
  assert.equal((await go(D1)).status, 402);
  txs[D1] = tx(p.amountMist, { timestamp: '2026-11-09T09:00:00Z' });
  const old = await go(D1);
  assert.equal(old.status, 402);
  assert.match(old.body.error, /too old/);
  assert.equal((await go(D1, 'nope')).status, 402);
  assert.equal((await go(D1, p.id, `0x${'9'.repeat(64)}`)).status, 400);
  const unseen = await go(D2);
  assert.equal(unseen.status, 402);
  assert.equal(unseen.body.retryable, true);
  assert.equal(await s.paid.count(), 0);
  txs[D1] = tx(p.amountMist);
  assert.equal((await go(D1)).status, 200);
});

test('an expired id is refused', async () => {
  let t = NOW;
  const txs = {};
  const s = setup(txs, { now: () => t });
  const p = (await s.paid.handle({ address: ADDR })).body.payment;
  txs[D1] = tx(p.amountMist);
  t += 16 * 60 * 1000;
  assert.equal((await s.paid.handle({ address: ADDR, id: p.id, digest: D1 })).status, 402);
});

test('settled digests are remembered across a restart', async () => {
  const dir = await mkdtemp(`${tmpdir()}/paid-`);
  const usedFile = `${dir}/used.json`;
  try {
    const txs = {};
    const a = setup(txs, { usedFile });
    const p = (await a.paid.handle({ address: ADDR })).body.payment;
    txs[D1] = tx(p.amountMist);
    assert.equal((await a.paid.handle({ address: ADDR, id: p.id, digest: D1 })).status, 200);
    const b = setup(txs, { usedFile });
    const q = (await b.paid.handle({ address: ADDR })).body.payment;
    assert.equal((await b.paid.handle({ address: ADDR, id: q.id, digest: D1 })).status, 409);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('route: POST /api/paid/check answers 402 then 200; stats count it; 503 when not configured', async () => {
  const memory = { health: async () => true, failed: () => [], pending: () => [], counter: () => ({ stored: 0, prescan: 0, test: 0, changed: 0 }) };
  const checker = { mode: 'test', state: { lastRecallOk: true }, check: async (a) => ({ address: a, verdict: 'pay' }) };
  const txs = {};
  const { paid } = setup(txs);
  const app = createApp({ checker, memory, paidCheck: paid });
  const off = createApp({ checker, memory });
  const listen = (a) => new Promise((r) => { const s = a.listen(0, '127.0.0.1', () => r(s)); });
  const srv = await listen(app);
  const srv2 = await listen(off);
  const call = (s, body) => fetch(`http://127.0.0.1:${s.address().port}/api/paid/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const r1 = await call(srv, { address: ADDR });
    assert.equal(r1.status, 402);
    const p = (await r1.json()).payment;
    txs[D1] = tx(p.amountMist);
    const r2 = await call(srv, { address: ADDR, id: p.id, digest: D1 });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).payment.digest, D1);
    const stats = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/stats`)).json();
    assert.equal(stats.paidChecks.settled, 1);
    assert.equal((await call(srv2, { address: ADDR })).status, 503);
    assert.equal((await call(srv, {})).status, 400);
  } finally {
    app.locals.stop(); off.locals.stop();
    for (const s of [srv, srv2]) { s.close(); s.closeAllConnections?.(); }
  }
});
