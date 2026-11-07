import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPrescan } from '../scripts/verify-prescan.js';

test('verifyPrescan lists the failures with their exact error and keeps order', async () => {
  const memory = { async recall({ address }) {
    if (address === 'b') throw new Error('boom');
    if (address === 'c') return [];
    return [{ origin: 'prescan', kind: 'verdict' }];
  } };
  const r = await verifyPrescan({ addresses: ['a', 'b', 'c', 'd'], memory });
  assert.deepEqual(r.verified, ['a', 'd']);
  assert.equal(r.failed.length, 2);
  assert.equal(r.failed.find((f) => f.address === 'b').error, 'boom');
});
