// RECORDED REAL ANSWERS: these tests run the engine and the verdict rules on real Tatum mainnet answers
// saved in test/recorded (nothing hand-built except the memory objects, which are labelled as such).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTatum } from '../../src/providers/tatum.js';
import { engineInputs, payoutsOf } from '../../src/check.js';
import { analyze } from '../../src/engine/index.js';
import { classifyHub } from '../../src/engine/exchanges.js';
import { funderTouches } from '../../src/engine/sharedFunder.js';
import { buildVerdict } from '../../src/engine/verdict.js';

const rec = (n) => JSON.parse(readFileSync(new URL(`../recorded/${n}.json`, import.meta.url), 'utf8'));
const WALLET = rec('listTransactions').address;
const tatum = createTatum({ key: 'k', limiter: async () => {}, fetchImpl: async () => new Response(JSON.stringify(rec('listTransactions').response)) });

async function realAnalysis() {
  const page = await tatum.listTransactions(WALLET, { first: 50 });
  const inputs = engineInputs(WALLET, page.transactions);
  const analysis = analyze(WALLET, { ...inputs, funderPayouts: [], otherFundings: [] });
  return { page, inputs, analysis };
}

test('recorded real answer: analyze finds the real first funder of a mainnet wallet', async () => {
  const { inputs, analysis } = await realAnalysis();
  assert.ok(inputs.incoming.length > 0, 'recorded listing has incoming SUI');
  assert.equal(analysis.firstFunder.funder, '0x357b6591a9451944e6099fc669123e229e89a5a65a82c3f2fd4efdc56ae314e3');
  console.log(`# recorded real answer: ${inputs.incoming.length} incoming, funder ${analysis.firstFunder.funder.slice(0, 10)}...`);
});

test('recorded real answer: with no memory the wallet gets a pay answer, never red', async () => {
  const { analysis } = await realAnalysis();
  const hubs = { funder: classifyHub(funderTouches([])) };
  const v = buildVerdict({ wallet: WALLET, analysis, memories: [], groupId: null, hubs });
  assert.equal(v.verdict, 'pay');
  assert.deepEqual(v.memoryIds, []);
  assert.equal(v.changedByMemory, false);
});

test('recorded real answer plus a hand-built bad report on the funder: red only through memory, memory off gives the first answer', async () => {
  const { analysis } = await realAnalysis();
  const funder = analysis.firstFunder.funder;
  const hubs = { funder: classifyHub(funderTouches([])) };
  // hand-built memory object, labelled test fixture
  const memories = [{ blobId: 'TEST-FIXTURE-1', kind: 'outcome', address: funder, group: null, origin: 'check', writtenAt: new Date().toISOString(), body: { outcome: 'bad', reporter: 'fixture' } }];
  const on = buildVerdict({ wallet: WALLET, analysis, memories, groupId: null, hubs });
  const off = buildVerdict({ wallet: WALLET, analysis, memories, groupId: null, hubs, memoryOn: false });
  assert.equal(on.verdict, 'do not pay');
  assert.deepEqual(on.changedByIds, ['TEST-FIXTURE-1']);
  assert.equal(off.verdict, 'pay');
  assert.equal(off.verdict, on.withoutMemory.verdict);
});

test('recorded real answer: a wallet that paid its own gas has no gas sponsor link', async () => {
  const { analysis } = await realAnalysis();
  assert.equal(analysis.gasSponsor, null);
});

test('recorded real answer: payoutsOf reads who the funder sent SUI to', async () => {
  const page = await tatum.listTransactions(WALLET, { first: 50 });
  const funder = '0x357b6591a9451944e6099fc669123e229e89a5a65a82c3f2fd4efdc56ae314e3';
  const payouts = payoutsOf(funder, page.transactions);
  assert.ok(Array.isArray(payouts));
  for (const p of payouts) assert.notEqual(p.recipient, funder);
});
