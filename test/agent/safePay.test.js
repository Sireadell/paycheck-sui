import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSafePay, PayCheckRefused } from '../../agent/safePay.js';
import { suiToMist, mistToSui, createSuiPayer, keypairFromSecret } from '../../agent/payer.js';
import { createChecker } from '../../src/check.js';
import { createTatum } from '../../src/providers/tatum.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const ADDR = `0x${'a'.repeat(64)}`;
const GOOD = `0x${'b'.repeat(64)}`;

const fakeMemory = () => {
  const writes = [];
  return { writes, async write(m) { writes.push(m); return { state: 'stored', blobId: `blob-${writes.length}` }; } };
};
const fakePayer = () => {
  const sent = [];
  return { sent, async pay(to, mist) { sent.push({ to, mist }); return { digest: 'DIGEST1', status: 'success', amountMist: mist, gasMist: 1000n }; } };
};
const checkerSaying = (answer) => ({ calls: [], async check(a) { this.calls.push(a); return { memoryIds: [], warnedBy: [], evidence: [], reason: 'because', ...answer }; } });

test('amounts: plain SUI text becomes whole mist and back, nonsense is rejected', () => {
  assert.equal(suiToMist('0.001'), 1_000_000n);
  assert.equal(suiToMist(2), 2_000_000_000n);
  assert.equal(mistToSui(1_500_000n), '0.0015');
  assert.throws(() => suiToMist('-1'));
  assert.throws(() => suiToMist('1e3'));
  assert.throws(() => suiToMist('0'));
});

test('do not pay: throws PAYCHECK_REFUSED with the memory ids, writes a refusal memory, sends nothing', async () => {
  const memory = fakeMemory();
  const payer = fakePayer();
  const checker = checkerSaying({ verdict: 'do not pay', code: 'OUTCOME_BAD_SELF', memoryIds: ['mem-9'] });
  const safePay = createSafePay({ checker, memory, payer, agentId: 'test-agent' });
  await assert.rejects(() => safePay(ADDR, '0.001'), (e) => {
    assert.ok(e instanceof PayCheckRefused);
    assert.equal(e.code, 'PAYCHECK_REFUSED');
    assert.deepEqual(e.memoryIds, ['mem-9']);
    assert.equal(e.refusalMemory.id, 'blob-1');
    return true;
  });
  assert.equal(payer.sent.length, 0);
  assert.equal(memory.writes.length, 1);
  assert.equal(memory.writes[0].kind, 'lesson');
  assert.equal(memory.writes[0].body.event, 'payment_refused');
  assert.deepEqual(memory.writes[0].body.citedMemoryIds, ['mem-9']);
});

test('refusal still happens when the refusal memory cannot be written', async () => {
  const memory = { async write() { throw new Error('walrus down'); } };
  const payer = fakePayer();
  const safePay = createSafePay({ checker: checkerSaying({ verdict: 'do not pay', code: 'X' }), memory, payer });
  await assert.rejects(() => safePay(ADDR, '0.001'), (e) => e.code === 'PAYCHECK_REFUSED' && e.refusalMemory.state === 'failed');
  assert.equal(payer.sent.length, 0);
});

test('pay: signs and sends exactly the asked amount to the padded payee', async () => {
  const payer = fakePayer();
  const safePay = createSafePay({ checker: checkerSaying({ verdict: 'pay', code: 'NO_LINKS_NO_BAD_HISTORY' }), memory: fakeMemory(), payer });
  const r = await safePay('0x' + 'b'.repeat(64), '0.001');
  assert.equal(r.paid, true);
  assert.equal(r.digest, 'DIGEST1');
  assert.deepEqual(payer.sent, [{ to: GOOD, mist: 1_000_000n }]);
});

test('caution stops by default (nothing sent) and goes through only when the caller opts in', async () => {
  const checker = checkerSaying({ verdict: 'caution', code: 'DATA_UNAVAILABLE' });
  const p1 = fakePayer();
  await assert.rejects(() => createSafePay({ checker, memory: fakeMemory(), payer: p1 })(GOOD, '0.001'), (e) => e.code === 'PAYCHECK_CAUTION');
  assert.equal(p1.sent.length, 0);
  const p2 = fakePayer();
  const r = await createSafePay({ checker, memory: fakeMemory(), payer: p2, allowCaution: true })(GOOD, '0.001');
  assert.equal(r.paid, true);
  assert.equal(p2.sent.length, 1);
});

test('dry run checks but never sends; a bad address and an over-limit amount never reach the check', async () => {
  const checker = checkerSaying({ verdict: 'pay', code: 'NO_LINKS_NO_BAD_HISTORY' });
  const payer = fakePayer();
  const safePay = createSafePay({ checker, memory: fakeMemory(), payer, dryRun: true });
  const r = await safePay(GOOD, '0.001');
  assert.equal(r.paid, false);
  assert.equal(r.dryRun, true);
  assert.equal(payer.sent.length, 0);
  await assert.rejects(() => safePay('nope', '0.001'), /Not a Sui address/);
  await assert.rejects(() => safePay(GOOD, '5'), /above this agent's limit/);
  assert.equal(checker.calls.length, 1);
});

test('end to end with the real checker: a stored bad report on the exact address blocks the payment', async () => {
  const empty = { data: { transactions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
  const fetchImpl = async (_u, init) => new Response(JSON.stringify(JSON.parse(init.body).query.includes('transactions(') ? empty : { data: { checkpoint: { sequenceNumber: 5 } } }), { status: 200 });
  const tatum = createTatum({ key: 'k', fetchImpl, limiter: async () => {}, retryWaitMs: 1 });
  const bad = { blobId: 'bad-memory-1', kind: 'outcome', address: ADDR, group: null, origin: 'check', namespace: 'shared-outcomes', body: { outcome: 'bad', reporter: 'setup' } };
  const memory = { recall: async (q) => (q.address === ADDR ? [bad] : []), enqueue: () => ({ state: 'pending', key: 'k' }), markChanged() {}, async write() { return { state: 'stored', blobId: 'refusal-1' }; } };
  const payer = fakePayer();
  const safePay = createSafePay({ checker: createChecker({ tatum, memory, mode: 'live' }), memory, payer });
  await assert.rejects(() => safePay(ADDR, '0.001'), (e) => e.code === 'PAYCHECK_REFUSED' && e.memoryIds.includes('bad-memory-1') && e.checkCode === 'OUTCOME_BAD_SELF');
  assert.equal(payer.sent.length, 0);
  const ok = await safePay(GOOD, '0.001');
  assert.equal(ok.paid, true);
  assert.equal(payer.sent.length, 1);
});

test('payer: builds one transfer, refuses to go below the reserve, fails loudly if the chain does not report success', async () => {
  const keypair = Ed25519Keypair.generate();
  const sentTx = [];
  const client = (balance, status = 'success') => ({
    getBalance: async () => ({ totalBalance: String(balance) }),
    signAndExecuteTransaction: async (a) => { sentTx.push(a); return { digest: 'D1', effects: { status: { status }, gasUsed: { computationCost: '1000', storageCost: '2000', storageRebate: '500' } } }; },
    waitForTransaction: async () => ({ effects: { status: { status }, gasUsed: { computationCost: '1000', storageCost: '2000', storageRebate: '500' } } }),
  });
  const low = createSuiPayer({ keypair, client: client(2_005_000_000n), reserveMist: 2_000_000_000n });
  await assert.rejects(() => low.pay(GOOD, 1_000_000n), /below its reserve/);
  assert.equal(sentTx.length, 0);
  const ok = createSuiPayer({ keypair, client: client(5_000_000_000n), reserveMist: 2_000_000_000n });
  const r = await ok.pay(GOOD, 1_000_000n);
  assert.equal(r.digest, 'D1');
  assert.equal(r.gasMist, 2500n);
  assert.equal(sentTx.length, 1);
  const failed = createSuiPayer({ keypair, client: client(5_000_000_000n, 'failure') });
  await assert.rejects(() => failed.pay(GOOD, 1_000_000n), /did not succeed/);
  await assert.rejects(() => ok.pay('nope', 1n), /Not a Sui address/);
});

test('signing key: the wallet export format gives the same address, an empty key is rejected', () => {
  const kp = Ed25519Keypair.generate();
  const exported = kp.getSecretKey();
  const raw = Buffer.from(exported ? kp.getSecretKey() : '', 'utf8');
  assert.equal(keypairFromSecret(exported).toSuiAddress(), kp.toSuiAddress());
  assert.ok(raw.length > 0);
  assert.throws(() => keypairFromSecret(''), /No signing key/);
});
