import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createX402Check, encodeHeader, decodeHeader, ASSET, NETWORK, PRICE_MIST } from '../src/x402.js';
import { createApp } from '../server.js';

const PAYEE = '0x' + 'b'.repeat(64);
const TARGET = '0x' + 'a'.repeat(64);
const GAS_DIGEST = '11111111111111111111111111111111';

async function pay({ to = PAYEE, amount = PRICE_MIST, gasOwner = null, kp = Ed25519Keypair.generate() } = {}) {
  const tx = new Transaction();
  tx.setSender(kp.toSuiAddress());
  if (gasOwner) tx.setGasOwner(gasOwner);
  tx.setGasPrice(1000n); tx.setGasBudget(5_000_000n);
  tx.setGasPayment([{ objectId: '0x' + '1'.repeat(64), version: '1', digest: GAS_DIGEST }]);
  const [c] = tx.splitCoins(tx.gas, [amount]);
  tx.transferObjects([c], to);
  const bytes = await tx.build();
  const { signature } = await kp.signTransaction(bytes);
  return { transaction: Buffer.from(bytes).toString('base64'), signature, payer: kp.toSuiAddress() };
}
const header = (payload, accepted = {}) => encodeHeader({ x402Version: 2, accepted: { scheme: 'exact', network: NETWORK, amount: PRICE_MIST.toString(), asset: ASSET, payTo: PAYEE, ...accepted }, payload });

function setup({ dryOk = true, got = PRICE_MIST, executeFails = false, checkFails = false } = {}) {
  const calls = { dry: 0, exec: 0, check: 0 };
  const changes = () => [{ owner: { AddressOwner: PAYEE }, coinType: '0x2::sui::SUI', amount: got.toString() }];
  const rpc = {
    dryRunTransactionBlock: async () => { calls.dry++; return { effects: { status: { status: dryOk ? 'success' : 'failure' } }, balanceChanges: changes() }; },
    executeTransactionBlock: async () => { calls.exec++; if (executeFails) throw new Error('rpc down'); return { digest: 'D' }; },
    waitForTransaction: async () => ({ effects: { status: { status: 'success' } }, balanceChanges: changes() }),
  };
  const checker = { check: async (address) => { calls.check++; if (checkFails && calls.check === 1) throw new Error('boom'); return { address, verdict: 'pay' }; } };
  return { x: createX402Check({ rpc, checker, payee: PAYEE }), calls };
}
const ask = (x, h) => x.handle({ address: TARGET, resourceUrl: 'https://h/api/x402/check', paymentHeader: h });

test('no payment header: 402 with a PAYMENT-REQUIRED header that matches the body', async () => {
  const { x } = setup();
  const r = await ask(x, undefined);
  assert.equal(r.status, 402);
  const req = decodeHeader(r.headers['PAYMENT-REQUIRED']);
  assert.deepEqual(req.accepts[0], { scheme: 'exact', network: 'sui:mainnet', amount: '1000000', asset: '0x2::sui::SUI', payTo: PAYEE, maxTimeoutSeconds: 60, extra: {} });
  assert.equal(req.x402Version, 2);
  assert.deepEqual(r.body.accepts, req.accepts);
});

test('a good signed payment is simulated, sent, and answered with a PAYMENT-RESPONSE receipt', async () => {
  const { x, calls } = setup();
  const p = await pay();
  const r = await ask(x, header(p));
  assert.equal(r.status, 200);
  assert.equal(r.body.verdict, 'pay');
  const receipt = decodeHeader(r.headers['PAYMENT-RESPONSE']);
  assert.equal(receipt.success, true); assert.equal(receipt.payer, p.payer); assert.equal(receipt.network, 'sui:mainnet');
  assert.deepEqual([calls.dry, calls.exec, calls.check], [1, 1, 1]);
  assert.equal(await x.count(), 1);
});

test('the same signed payment cannot buy a second check', async () => {
  const { x, calls } = setup();
  const h = header(await pay());
  assert.equal((await ask(x, h)).status, 200);
  assert.equal((await ask(x, h)).status, 409);
  assert.equal(calls.exec, 1);
});

test('refused before anything is sent: wrong price asked, wrong payee, failing simulation, short payment', async () => {
  for (const [opts, accepted, label] of [[{}, { amount: '5' }, 'wrong amount'], [{}, { payTo: '0x' + 'c'.repeat(64) }, 'wrong payee'], [{ dryOk: false }, {}, 'sim fails'], [{ got: 10n }, {}, 'short']]) {
    const { x, calls } = setup(opts);
    const r = await ask(x, header(await pay(), accepted));
    assert.equal(r.status, 402, label);
    assert.equal(calls.exec, 0, label);
  }
});

test('a signature from a different key, a sponsored gas owner, and junk are refused', async () => {
  const { x, calls } = setup();
  const p = await pay();
  const other = await pay();
  assert.equal((await ask(x, header({ ...p, signature: other.signature }))).status, 402);
  assert.equal((await ask(x, header(await pay({ gasOwner: '0x' + 'd'.repeat(64) })))).status, 402);
  assert.equal((await ask(x, 'not-base64-json')).status, 400);
  assert.equal(calls.exec, 0);
});

test('if the check fails after payment settles, the same header gets the check once without paying again', async () => {
  const { x, calls } = setup({ checkFails: true });
  const h = header(await pay());
  assert.equal((await ask(x, h)).status, 500);
  assert.equal((await ask(x, h)).status, 200);
  assert.equal(calls.exec, 1);
  assert.equal((await ask(x, h)).status, 409);
});

test('GET /api/x402/check over HTTP: 402 first, 503 when switched off', async () => {
  const memory = { health: async () => true, failed: () => [], pending: () => [], counter: () => ({ stored: 0, prescan: 0, test: 0, changed: 0 }) };
  const checker = { mode: 'test', state: { lastRecallOk: true }, check: async (address) => ({ address, verdict: 'pay' }) };
  for (const [x402, want] of [[setup().x, 402], [null, 503]]) {
    const app = createApp({ checker, memory, x402 });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/x402/check?address=${TARGET}`);
      assert.equal(r.status, want);
      if (want === 402) assert.ok(decodeHeader(r.headers.get('payment-required')).accepts[0].payTo === PAYEE);
    } finally { app.locals.stop(); server.close(); server.closeAllConnections?.(); }
  }
});
