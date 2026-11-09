import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChecker } from '../src/check.js';
import { parseAddress, padAddress } from '../src/address.js';
import { createApp } from '../server.js';

const FULL = `0x${'ab12'.repeat(16)}`;
const cases = [
  ['empty', '', 'EMPTY_ADDRESS'],
  ['spaces only', '   ', 'EMPTY_ADDRESS'],
  ['just 0x', '0x', 'EMPTY_ADDRESS'],
  ['missing 0x', 'ab12'.repeat(16), 'MISSING_0X'],
  ['typo letter', `0x${'ab12'.repeat(15)}ab1g`, 'NOT_HEX'],
  ['plain word', 'hello', 'NOT_HEX'],
  ['quote and brace', '0x1"}', 'NOT_HEX'],
  ['unicode digits', '0x１２３４', 'NOT_HEX'],
  ['emoji', '0x🙂', 'NOT_HEX'],
  ['65 hex', `0x${'1'.repeat(65)}`, 'TOO_LONG'],
  ['Ethereum 20 bytes', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'ETHEREUM_ADDRESS'],
  ['SuiNS name', 'alice.sui', 'NAME_NOT_SUPPORTED'],
  ['SuiNS at-name', '@alice', 'NAME_NOT_SUPPORTED'],
  ['Solana-style text', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'NOT_HEX'],
];

test('bad addresses are refused with a plain reason and an input code', () => {
  for (const [name, input, code] of cases) {
    const r = parseAddress(input);
    assert.equal(r.ok, false, name);
    assert.equal(r.inputCode, code, name);
    assert.ok(r.reason.length > 10, name);
  }
  assert.equal(parseAddress(undefined).inputCode, 'EMPTY_ADDRESS');
  assert.equal(parseAddress(12345).inputCode, 'EMPTY_ADDRESS');
});

test('good addresses are normalised in one place: lowercase, 0x, padded to 64', () => {
  assert.equal(padAddress('0x2'), `0x${'0'.repeat(63)}2`);
  assert.equal(padAddress(`  0X${FULL.slice(2).toUpperCase()}  `), FULL);
  assert.equal(padAddress(FULL.toUpperCase().replace('0X', '0x')), FULL);
});

test('the checker answers caution INVALID_INPUT with the input code and never pay, and makes no chain call', async () => {
  let calls = 0;
  const tatum = new Proxy({}, { get: () => () => { calls++; throw new Error('should not be called'); } });
  const checker = createChecker({ tatum, memory: { recall: async () => { calls++; return []; }, enqueue: () => { calls++; return {}; }, markChanged() {} }, mode: 'live' });
  for (const [name, input, code] of cases) {
    const r = await checker.check(input);
    assert.equal(r.verdict, 'caution', name);
    assert.equal(r.code, 'INVALID_INPUT', name);
    assert.equal(r.inputCode, code, name);
    assert.equal(r.retryable, false, name);
  }
  assert.equal(calls, 0);
});

test('/api/check answers HTTP 400 for a bad address and 200 for a good one', async () => {
  const checker = createChecker({ tatum: { listTransactions: async () => { throw new Error('x'); }, latestCheckpoint: async () => 1 }, memory: { recall: async () => [], enqueue: () => ({}), markChanged() {}, health: async () => true, failed: () => [], pending: () => [], counter: () => ({}) }, mode: 'live' });
  const app = createApp({ checker, memory: { health: async () => true, failed: () => [], pending: () => [], counter: () => ({}) }, checkLimit: { max: 100, windowMs: 60000 } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const q of ['', 'hello', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'alice.sui']) {
      const res = await fetch(`${base}/api/check?address=${encodeURIComponent(q)}`);
      assert.equal(res.status, 400, q);
      const j = await res.json();
      assert.equal(j.code, 'INVALID_INPUT');
      assert.ok(j.inputCode);
      assert.notEqual(j.verdict, 'pay');
    }
    assert.equal((await fetch(`${base}/api/check?address=${FULL}`)).status, 200);
  } finally { app.locals.stop(); server.close(); server.closeAllConnections?.(); }
});
