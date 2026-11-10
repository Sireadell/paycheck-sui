import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletProfile, fanOutFacts } from '../../src/engine/profile.js';

const W = '0x' + 'a'.repeat(64);
const F = '0x' + 'b'.repeat(64);
const X = '0x' + 'c'.repeat(64);
const SUI = '0x2::sui::SUI';
const MIN = 60_000;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const tx = (digest, sender, at, changes) => ({ digest, sender, status: 'SUCCESS', timestamp: new Date(at).toISOString(), balanceChanges: changes.map(([owner, amount]) => ({ coin: SUI, owner, amount: String(amount) })) });

test('age and activity come from the oldest transaction', () => {
  const page = { transactions: [tx('d1', F, T0, [[W, 1000], [F, -1000]]), tx('d2', W, T0 + 2 * 86_400_000, [[X, 10], [W, -10]])], hasNextPage: false };
  const p = walletProfile(W, page, T0 + 10 * 86_400_000);
  assert.equal(p.ageDays, 10);
  assert.equal(p.received, 1);
  assert.equal(p.sent, 1);
  assert.equal(p.activeDays, 2);
  assert.equal(p.passThrough.count, 0);
});

test('pass-through: nearly everything sent on within 30 minutes', () => {
  const page = { transactions: [tx('in', F, T0, [[W, 1000], [F, -1000]]), tx('out', W, T0 + 5 * MIN, [[X, 960], [W, -960]])], hasNextPage: false };
  const p = walletProfile(W, page, T0 + MIN * 60);
  assert.equal(p.passThrough.count, 1);
  assert.equal(p.passThrough.examples[0].minutes, 5);
});

test('not pass-through: a small payment, or sent on too late', () => {
  const small = { transactions: [tx('in', F, T0, [[W, 1000]]), tx('out', W, T0 + 5 * MIN, [[X, 100], [W, -100]])] };
  assert.equal(walletProfile(W, small, T0).passThrough.count, 0);
  const late = { transactions: [tx('in', F, T0, [[W, 1000]]), tx('out', W, T0 + 90 * MIN, [[X, 990], [W, -990]])] };
  assert.equal(walletProfile(W, late, T0).passThrough.count, 0);
});

test('no history stays unknown, not zero age', () => {
  const p = walletProfile(W, { transactions: [] }, T0);
  assert.equal(p.ageDays, null);
  assert.equal(p.txsRead, 0);
});

test('fan-out facts copy the hub result', () => {
  assert.equal(fanOutFacts(null), null);
  assert.deepEqual(fanOutFacts({ wallets: 41, atLeast: true, hours: 300, countText: 'at least 41', verdict: 'shared service, weak link', reason: 'hub' }), { wallets: 41, atLeast: true, hours: 300, countText: 'at least 41', reading: 'shared service, weak link', reason: 'hub' });
});
