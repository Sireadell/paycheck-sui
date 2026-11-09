import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChecker } from '../src/check.js';
import { createTatum } from '../src/providers/tatum.js';

const rec = (n) => JSON.parse(readFileSync(new URL(`./recorded/${n}.json`, import.meta.url), 'utf8'));
const WALLET = rec('pick').addr;
const json = (body) => new Response(JSON.stringify(body), { status: 200 });

function setup({ chainDelayMs = 0 } = {}) {
  const log = [];
  const fetchImpl = async (_u, init) => {
    const q = JSON.parse(init.body).query;
    log.push(q.includes('transactions(') ? 'list' : q.includes('asObject') ? 'profile' : 'checkpoint');
    if (chainDelayMs) await new Promise((r) => setTimeout(r, chainDelayMs));
    return json(q.includes('transactions(') ? rec('listTransactions').response : rec('latestCheckpoint').response);
  };
  const memory = { recall: async (q) => { log.push(`recall:${q.address ?? q.group}`); return []; }, enqueue: () => ({ state: 'pending', key: 'k' }), markChanged() {} };
  const tatum = createTatum({ key: 'k', fetchImpl, limiter: async () => {}, retryWaitMs: 1 });
  return { log, checker: createChecker({ tatum, memory, mode: 'live' }) };
}

test('with memory switched off the memory is not read at all', async () => {
  const { log, checker } = setup();
  const r = await checker.check(WALLET, { memoryOn: false });
  assert.equal(log.filter((x) => x.startsWith('recall')).length, 0);
  assert.equal(r.memory.recallOk, true);
  assert.equal(r.memory.recalled, 0);
});

test('the memory read for the wallet starts before the chain history has been read', async () => {
  const { log, checker } = setup({ chainDelayMs: 20 });
  await checker.check(WALLET, { memoryOn: true });
  const firstRecall = log.findIndex((x) => x === `recall:${WALLET}`);
  const firstList = log.findIndex((x) => x === 'list');
  assert.ok(firstRecall >= 0 && firstList >= 0);
  assert.ok(firstRecall < log.lastIndexOf('list'), 'wallet recall is not queued behind the whole chain read');
});

test('the latest checkpoint is read once for checks made within 10 seconds', async () => {
  const { log, checker } = setup();
  await checker.check(WALLET, { memoryOn: false });
  await checker.check(WALLET, { memoryOn: false });
  assert.equal(log.filter((x) => x === 'checkpoint').length, 1);
});
