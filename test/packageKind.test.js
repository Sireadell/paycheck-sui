import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChecker } from '../src/check.js';
import { createTatum } from '../src/providers/tatum.js';

const rec = (n) => JSON.parse(readFileSync(new URL(`./recorded/${n}.json`, import.meta.url), 'utf8'));
const WALLET = rec('pick').addr;
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const emptyList = { data: { transactions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
const profile = (balance, asObject = null) => ({ data: { address: { balance: { totalBalance: balance }, asObject } } });
const memory = (list = []) => ({ recall: async () => list, enqueue: () => ({ state: 'pending', key: 'k' }), markChanged() {} });

function checkerWith({ list, prof, mem = memory() }) {
  const fetchImpl = async (_u, init) => {
    const q = JSON.parse(init.body).query;
    if (q.includes('asObject')) { if (prof === 'fail') return new Response('x', { status: 500 }); return json(prof); }
    return json(q.includes('transactions(') ? list : rec('latestCheckpoint').response);
  };
  return createChecker({ tatum: createTatum({ key: 'k', fetchImpl, limiter: async () => {}, retryWaitMs: 1 }), memory: mem, mode: 'live' });
}

test('a Sui package is caution PAYEE_NOT_A_WALLET', async () => {
  const r = await checkerWith({ list: emptyList, prof: profile('2400568446767', { version: 61, asMovePackage: { address: '0x2' } }) }).check('0x2');
  assert.equal(r.verdict, 'caution');
  assert.equal(r.code, 'PAYEE_NOT_A_WALLET');
  assert.match(r.reason, /package/);
});

test('a plain object id is caution PAYEE_NOT_A_WALLET too', async () => {
  const r = await checkerWith({ list: emptyList, prof: profile('0', { version: 3, asMovePackage: null }) }).check(`0x${'cd34'.repeat(16)}`);
  assert.equal(r.code, 'PAYEE_NOT_A_WALLET');
  assert.match(r.reason, /object/);
});

test('a stored bad report on a package address still wins: do not pay', async () => {
  const bad = { blobId: 'TEST-FIXTURE-KIND', kind: 'outcome', address: `0x${'0'.repeat(63)}2`, group: null, origin: 'check', writtenAt: new Date().toISOString(), body: { outcome: 'bad', reporter: 'fixture' } };
  const r = await checkerWith({ list: emptyList, prof: profile('1', { version: 1, asMovePackage: { address: '0x2' } }), mem: memory([bad]) }).check('0x2');
  assert.equal(r.verdict, 'do not pay');
});
