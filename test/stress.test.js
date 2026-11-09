import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStress, estimateMist, buildStress, scoreStress } from '../scripts/lib/stress.js';

const fakeRpc = () => {
  const sent = [];
  return {
    sent,
    async getBalance() { return { totalBalance: '100000000' }; },
    async signAndExecuteTransaction() { sent.push(1); return { digest: `D${sent.length}`, effects: { status: { status: 'success' } } }; },
    async waitForTransaction({ digest }) { return { digest, effects: { status: { status: 'success' } } }; },
  };
};
const fakeMain = () => { const calls = []; return { calls, async payMany(items) { calls.push(items); return { digest: `M${calls.length}` }; } }; };

test('plan: fixed sizes, all three group types, half the controls also spend', () => {
  const p = planStress({ groups: 12, controls: 10 });
  assert.equal(p.groups.length, 12);
  assert.equal(p.controls.length, 10);
  assert.deepEqual([...new Set(p.groups.map((g) => g.type))].sort(), ['funder', 'funder_sponsor', 'round_trip']);
  assert.ok(p.groups.every((g) => g.size >= 3 && g.size <= 6));
  assert.equal(p.controls.filter((c) => c.outgoing).length, 5);
  assert.ok(estimateMist(p) > 0n && estimateMist(p) < 3_500_000_000n);
});

test('build with a mocked chain: one funder per group and control, the key lists every address and no secret', async () => {
  const plan = { groups: [{ id: 'sg-01', type: 'funder', size: 3 }, { id: 'sg-02', type: 'round_trip', size: 3 }], controls: [{ id: 'sc-01', outgoing: false }, { id: 'sc-02', outgoing: true }] };
  const main = fakeMain();
  const key = await buildStress({ main, rpc: fakeRpc(), plan, waitMs: 1 });
  assert.equal(main.calls.length, 1);
  assert.equal(main.calls[0].length, 4);
  assert.equal(key.groups[0].members.length, 3);
  assert.equal(key.groups[1].roundTripDigests.length, 2);
  assert.ok(key.controls[1].outgoingDigest);
  assert.equal(key.controls[0].outgoingDigest, null);
  const all = [...key.groups.flatMap((g) => [g.funder, ...g.members]), ...key.controls.flatMap((c) => [c.address, c.funder])];
  assert.equal(new Set(all).size, all.length);
  assert.ok(!/suiprivkey|secret|private/i.test(JSON.stringify(key)));
  assert.match(key.label, /Synthetic/);
});

test('score: found means a counted link to the key funder; a control is a false alarm unless it is clean', () => {
  const F = `0x${'1'.repeat(64)}`;
  const key = { groups: [{ id: 'g', type: 'funder', funder: F, members: ['0xa', '0xb', '0xc'] }], controls: [{ id: 'c1', address: '0xd' }, { id: 'c2', address: '0xe' }] };
  const results = [
    { address: '0xa', code: 'LINKED_NO_BAD_HISTORY', links: [{ address: F }] },
    { address: '0xB', code: 'LINKED_NO_BAD_HISTORY', links: [{ address: F }] },
    { address: '0xc', code: 'NO_LINKS_NO_BAD_HISTORY', links: [] },
    { address: '0xd', code: 'NO_LINKS_NO_BAD_HISTORY', links: [] },
    { address: '0xe', code: 'ROUND_TRIP_TO_FUNDER', links: [] },
  ];
  const s = scoreStress(key, results);
  assert.deepEqual([s.caught, s.total, s.falseAlarms, s.controls], [2, 3, 1, 2]);
  assert.equal(s.misses[0].address, '0xc');
  assert.equal(s.groupsWithAnyMemberCaught, 1);
});
