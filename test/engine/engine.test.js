import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, groupByGasSponsor, firstFunder, sharedFunder } from '../../src/engine/index.js';
import { amountsMatch } from '../../src/engine/timing.js';

// Offline fixtures: addresses and transfer lists are hand-built in the shape
// the reader returns. Not real chain data; recorded answers can be swapped in
// from test/recorded once they exist.
const A = '0xaaaa000000000000000000000000000000000000000000000000000000000001';
const B = '0xbbbb000000000000000000000000000000000000000000000000000000000002';
const C = '0xcccc000000000000000000000000000000000000000000000000000000000003';
const F = '0xffff000000000000000000000000000000000000000000000000000000000009';
const SP = '0x5555000000000000000000000000000000000000000000000000000000000005';
const T0 = 1_760_000_000_000;

const incomingA = [{ digest: 'dA', sender: F, recipient: A, amount: '1935000000', timestampMs: T0 }];
const payouts = [
  { recipient: A, timestampMs: T0, digest: 'dA' },
  { recipient: B, timestampMs: T0 + 3_600_000, digest: 'dB' },
  { recipient: C, timestampMs: T0 + 7_200_000, digest: 'dC' },
];

test('first funder is the earliest incoming transfer', () => {
  const f = firstFunder(A, [{ ...incomingA[0], timestampMs: T0 + 5, sender: B }, ...incomingA]);
  assert.equal(f.funder, F);
  assert.equal(f.amount, 1935000000n);
});

test('shared funder finds siblings in the window', () => {
  const first = firstFunder(A, incomingA);
  const s = sharedFunder(A, first, payouts);
  assert.equal(s.groupSize, 3);
  assert.deepEqual(s.siblings.map((x) => x.address).sort(), [B, C]);
});

test('exchange funder gives no group', () => {
  const first = firstFunder(A, incomingA, { extraExchanges: [F] });
  const s = sharedFunder(A, first, payouts, { extraExchanges: [F] });
  assert.equal(s.groupSize, 0);
  assert.equal(s.excluded, 'known_exchange');
});

test('fan-out over 25 hours reads as exchange, a one-hour burst does not', () => {
  const many = (spanMs) => Array.from({ length: 20 }, (_, i) => ({ recipient: '0x' + String(i + 1).padStart(64, '0'), timestampMs: T0 + (i * spanMs) / 19, digest: 'x' + i }));
  const first = firstFunder(A, incomingA);
  assert.equal(sharedFunder(A, first, many(30 * 3_600_000)).excluded, 'exchange_like_fan_out');
  assert.equal(sharedFunder(A, first, many(3_600_000)).excluded, null);
});

test('gas sponsor found and grouped', () => {
  const r = analyze(A, { incoming: incomingA, sent: [{ digest: 'sA', sender: A, gasSponsor: SP, timestampMs: T0 + 9 }] });
  assert.equal(r.gasSponsor.sponsor, SP);
  const rB = analyze(B, { sent: [{ digest: 'sB', sender: B, gasSponsor: SP, timestampMs: T0 }] });
  const groups = groupByGasSponsor([{ address: A, sponsor: r.gasSponsor.sponsor }, { address: B, sponsor: rB.gasSponsor.sponsor }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].wallets.length, 2);
  console.log(`group found: gas sponsor ${groups[0].sponsor} links ${groups[0].wallets.length} wallets (digests ${r.gasSponsor.digest}, ${rB.gasSponsor.digest})`);
});

test('unsponsored wallet has no gas sponsor', () => {
  const r = analyze(A, { sent: [{ digest: 's', sender: A, gasSponsor: A }] });
  assert.equal(r.gasSponsor, null);
});

test('round trip direct and second hop', () => {
  const direct = analyze(A, { incoming: incomingA, outbound: [{ recipient: F, digest: 'back' }] });
  assert.equal(direct.roundTrip.circular, true);
  const hop = analyze(A, { incoming: incomingA, outbound: [{ recipient: C, digest: 'x' }], getOutbound: (a) => (a === C ? [{ recipient: F, digest: 'h' }] : []) });
  assert.equal(hop.roundTrip.secondHopCircular, true);
  assert.equal(hop.roundTrip.secondHopIntermediary, C);
  assert.equal(analyze(A, { incoming: incomingA, outbound: [] }).roundTrip.circular, false);
});

test('correlated funding by different funders within 10 minutes', () => {
  const others = [
    { funder: B, amount: '1950000000', timestampMs: T0 + 120_000 },
    { funder: B, amount: '9000000000', timestampMs: T0 + 120_000 },
    { funder: C, amount: '1935000000', timestampMs: T0 + 3_600_000 },
    { funder: F, amount: '1935000000', timestampMs: T0 + 1000 },
  ];
  assert.equal(analyze(A, { incoming: incomingA, otherFundings: others }).timing.count, 1);
  assert.equal(amountsMatch(0, 5), true);
});
