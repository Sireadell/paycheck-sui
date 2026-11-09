import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChecker } from '../src/check.js';
import { createTatum } from '../src/providers/tatum.js';
import { buildVerdict } from '../src/engine/verdict.js';

const rec = (n) => JSON.parse(readFileSync(new URL(`./recorded/${n}.json`, import.meta.url), 'utf8'));
const WALLET = rec('pick').addr;
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const fetchImpl = async (_u, init) => {
  const q = JSON.parse(init.body).query;
  return json(q.includes('transactions(') ? rec('listTransactions').response : rec('latestCheckpoint').response);
};
const tatum = createTatum({ key: 'k', fetchImpl, limiter: async () => {}, retryWaitMs: 1 });
// A stored bad report on the wallet itself. SYNTHETIC test fixture, never written anywhere.
const BAD = { blobId: 'TEST-FIXTURE-MEM', kind: 'outcome', address: WALLET, group: null, origin: 'check', writtenAt: new Date().toISOString(), body: { outcome: 'bad', reporter: 'fixture' } };
const mem = (recall) => ({ recall, enqueue: () => ({ state: 'pending', key: 'k' }), markChanged() {} });
// Hangs for 300 ms (the checker's own limit in these tests is 20 ms), then fails; the timer keeps the test process alive.
const never = () => new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 300));

test('a memory read that times out on a wallet with a stored bad report is never "pay"', async () => {
  const checker = createChecker({ tatum, memory: mem(never), mode: 'live', recallTimeoutMs: 20 });
  const r = await checker.check(WALLET);
  assert.notEqual(r.verdict, 'pay');
  assert.equal(r.verdict, 'caution');
  assert.equal(r.code, 'MEMORY_UNAVAILABLE');
  assert.equal(r.retryable, true);
  assert.match(r.reason, /shared memory could not be read/i);
  assert.equal(r.memory.recallOk, false);
  assert.equal(r.withoutMemory.verdict, 'pay', 'the without-memory side stays as it was');
});

test('a memory read that fails outright is also caution, not pay', async () => {
  const checker = createChecker({ tatum, memory: mem(async () => { throw new Error('relayer down'); }), mode: 'live' });
  const r = await checker.check(WALLET);
  assert.equal(r.code, 'MEMORY_UNAVAILABLE');
  assert.equal(r.write.state, 'none', 'a verdict that could not use memory is not saved as a memory');
});

test('the memory read is tried twice: a timeout followed by a good answer still finds the bad report', async () => {
  const seen = new Set();
  const recall = (q) => {
    const key = `${q.namespace}|${q.address}|${q.group}`;
    if (!seen.has(key)) { seen.add(key); return never(); }
    return Promise.resolve(q.address === WALLET ? [BAD] : []);
  };
  const checker = createChecker({ tatum, memory: mem(recall), mode: 'live', recallTimeoutMs: 20 });
  const r = await checker.check(WALLET);
  assert.equal(r.verdict, 'do not pay');
  assert.equal(r.code, 'OUTCOME_BAD_SELF');
  assert.equal(r.memory.recallOk, true);
});

test('with memory switched off a failed read does not matter', async () => {
  const checker = createChecker({ tatum, memory: mem(never), mode: 'live', recallTimeoutMs: 20 });
  const r = await checker.check(WALLET, { memoryOn: false });
  assert.notEqual(r.code, 'MEMORY_UNAVAILABLE');
});

test('buildVerdict: degraded memory turns pay into caution, keeps do not pay, keeps other cautions', () => {
  const analysis = { firstFunder: null, sharedFunder: null, gasSponsor: null, roundTrip: null, timing: null };
  const a = buildVerdict({ wallet: WALLET, analysis, memories: [], memoryDegraded: true });
  assert.equal(a.verdict, 'caution');
  assert.equal(a.code, 'MEMORY_UNAVAILABLE');
  const b = buildVerdict({ wallet: WALLET, analysis, memories: [BAD], memoryDegraded: true });
  assert.equal(b.verdict, 'do not pay');
  const c = buildVerdict({ wallet: WALLET, analysis, memories: [], memoryDegraded: false });
  assert.equal(c.verdict, 'pay');
});
