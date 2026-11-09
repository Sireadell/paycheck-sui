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

test('an address with no transactions and no balance is caution NO_HISTORY, not pay', async () => {
  const r = await checkerWith({ list: emptyList, prof: profile('0') }).check(`0x${'ab12'.repeat(16)}`);
  assert.equal(r.verdict, 'caution');
  assert.equal(r.code, 'NO_HISTORY');
  assert.match(r.reason, /brand-new or unused wallets cannot be judged/i);
  assert.equal(r.write.state, 'none', 'no memory is saved for an address with nothing to judge');
});

test('a short typo-like address with nothing on chain is NO_HISTORY as well', async () => {
  const r = await checkerWith({ list: emptyList, prof: profile('0') }).check('0xabc');
  assert.equal(r.code, 'NO_HISTORY');
});

test('no transactions but a balance is not NO_HISTORY', async () => {
  const r = await checkerWith({ list: emptyList, prof: profile('5000000000') }).check(`0x${'ab12'.repeat(16)}`);
  assert.notEqual(r.code, 'NO_HISTORY');
});

test('a wallet with history is unchanged', async () => {
  const r = await checkerWith({ list: rec('listTransactions').response, prof: profile('40099900000') }).check(WALLET);
  assert.notEqual(r.code, 'NO_HISTORY');
});

test('if the profile cannot be read the answer is as before, with a note', async () => {
  const r = await checkerWith({ list: emptyList, prof: 'fail' }).check(`0x${'ab12'.repeat(16)}`);
  assert.equal(r.code, 'NO_LINKS_NO_BAD_HISTORY');
  assert.ok(r.notes.some((n) => /could not be read/.test(n)));
});

