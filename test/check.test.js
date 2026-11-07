import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChecker } from '../src/check.js';
import { createTatum } from '../src/providers/tatum.js';
import { padAddress } from '../src/address.js';

const rec = (n) => JSON.parse(readFileSync(new URL(`./recorded/${n}.json`, import.meta.url), 'utf8'));
const pick = rec('pick');
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const noWait = async () => {};
const emptyList = { data: { transactions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
const fakeMemory = () => ({ recall: async () => [], enqueue: () => ({ state: 'pending', key: 'k' }), markChanged() {} });
const queriedAddress = (q) => (/affectedAddress:"([^"]+)"/.exec(q) ?? [])[1] ?? '';

function checkerWith(listAnswer, { delayMs = 0, queries = [] } = {}) {
  const fetchImpl = async (_url, init) => {
    const q = JSON.parse(init.body).query;
    queries.push(q);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return json(q.includes('transactions(') ? listAnswer : rec('latestCheckpoint').response);
  };
  const tatum = createTatum({ key: 'k', fetchImpl, limiter: noWait, retryWaitMs: 1 });
  return createChecker({ tatum, memory: fakeMemory() });
}

test('padAddress pads 0x1 to 64 hex and lowercases mixed case', () => {
  assert.equal(padAddress('0x1'), `0x${'0'.repeat(63)}1`);
  assert.equal(padAddress('0xAbC'), `0x${'0'.repeat(61)}abc`);
  assert.equal(padAddress(`0x${'ABCDEF'.padEnd(64, 'F')}`), `0x${'abcdef'.padEnd(64, 'f')}`);
  assert.equal(padAddress('nope'), null);
  assert.equal(padAddress('0x'), null);
  assert.equal(padAddress(`0x${'1'.repeat(65)}`), null);
});

test('a short address is accepted and looked up in padded form', async () => {
  const queries = [];
  const r = await checkerWith(emptyList, { queries }).check('0x1', { memoryOn: false });
  assert.notEqual(r.code, 'INVALID_INPUT');
  assert.ok(queries.some((q) => queriedAddress(q) === `0x${'0'.repeat(63)}1`));
});

test('a mixed-case address gives the same lookup and verdict as lowercase', async () => {
  const qa = [];
  const qb = [];
  const mixed = `0x${pick.addr.slice(2).replace(/[a-f]/g, (c, i) => (i % 2 ? c.toUpperCase() : c))}`;
  assert.notEqual(mixed, pick.addr);
  const a = await checkerWith(rec('listTransactions').response, { queries: qa }).check(mixed, { memoryOn: false });
  const b = await checkerWith(rec('listTransactions').response, { queries: qb }).check(pick.addr, { memoryOn: false });
  assert.equal(a.code, b.code);
  assert.deepEqual(qa, qb);
  assert.ok(qa.map(queriedAddress).filter(Boolean).every((x) => x === x.toLowerCase() && x.length === 66));
});

test('checks running at the same time each report only their own Tatum calls', async () => {
  const alone = await checkerWith(rec('listTransactions').response).check(pick.addr, { memoryOn: false });
  const aloneEmpty = await checkerWith(emptyList).check('0x1', { memoryOn: false });
  assert.notEqual(alone.callLog.tatum.calls, aloneEmpty.callLog.tatum.calls);
  const [a, b, c] = await Promise.all([
    checkerWith(rec('listTransactions').response, { delayMs: 15 }).check(pick.addr, { memoryOn: false }),
    checkerWith(emptyList, { delayMs: 5 }).check('0x1', { memoryOn: false }),
    checkerWith(rec('listTransactions').response, { delayMs: 1 }).check(pick.addr, { memoryOn: false }),
  ]);
  assert.equal(a.callLog.tatum.calls, alone.callLog.tatum.calls);
  assert.equal(b.callLog.tatum.calls, aloneEmpty.callLog.tatum.calls);
  assert.equal(c.callLog.tatum.calls, alone.callLog.tatum.calls);
});
