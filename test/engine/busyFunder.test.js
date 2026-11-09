import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerdict } from '../../src/engine/verdict.js';
import { classifyHub } from '../../src/engine/exchanges.js';

// Hand-built data, labelled so. A busy payout wallet paid 20 different wallets within an hour (a "burst" by the hub rule).
const W = '0x' + 'a1'.repeat(32);
const F = '0x' + 'f1'.repeat(32);
const OTHER = '0x' + 'c3'.repeat(32);
const burst = classifyHub(Array.from({ length: 20 }, (_, i) => ({ wallet: '0x' + String(i + 10).repeat(32), timestampMs: i * 60_000 })), { capped: true });
const few = classifyHub(Array.from({ length: 5 }, (_, i) => ({ wallet: '0x' + String(i + 10).repeat(32), timestampMs: i * 60_000 })));
const unlinked = { wallet: W, firstFunder: { funder: F, isExchange: false }, gasSponsor: null, sharedFunder: { funder: F, groupSize: 0, siblings: [], excluded: null }, roundTrip: { circular: false, secondHopCircular: false }, timing: { count: 0, matches: [] } };
const linked = { ...unlinked, sharedFunder: { funder: F, groupSize: 2, siblings: [{ address: '0x' + 'd4'.repeat(32), digest: 'dSib' }], excluded: null } };
// SYNTHETIC report about another wallet that had the same first funder.
const report = { blobId: 'SYNTHETIC-BUSY', kind: 'outcome', origin: 'agent-a', namespace: 'shared-outcomes', address: OTHER, group: 'g-1234abcd', body: { outcome: 'bad', funder: F } };

test('one report about a wallet of a busy funder only warns the other wallets of that funder', () => {
  assert.equal(burst.reason, 'burst');
  const v = buildVerdict({ wallet: W, analysis: unlinked, hubs: { funder: burst }, memories: [report] });
  assert.equal(v.verdict, 'caution');
  assert.equal(v.code, 'BUSY_FUNDER_BAD_OUTCOME');
  assert.match(v.reason, /at least 20 different wallets/);
  assert.deepEqual(v.memoryIds, ['SYNTHETIC-BUSY']);
});

test('a small funder (fewer than 15 wallets) keeps the red answer', () => {
  const v = buildVerdict({ wallet: W, analysis: unlinked, hubs: { funder: few }, memories: [report] });
  assert.equal(v.verdict, 'do not pay');
  assert.equal(v.code, 'GROUP_BAD_OUTCOME');
});

test('a wallet that sits in the funder group (checked link) keeps the red answer, even for a fast run of wallets', () => {
  const v = buildVerdict({ wallet: W, analysis: linked, hubs: { funder: burst }, groupId: 'g-1234abcd', memories: [report] });
  assert.equal(v.verdict, 'do not pay');
  assert.equal(v.code, 'GROUP_BAD_OUTCOME');
});

test('a report about the busy funder itself also only warns its wallets', () => {
  const v = buildVerdict({ wallet: W, analysis: unlinked, hubs: { funder: burst }, memories: [{ ...report, address: F, body: { outcome: 'bad' } }] });
  assert.equal(v.verdict, 'caution');
  assert.equal(v.code, 'BUSY_FUNDER_BAD_OUTCOME');
});

test('a busy funder does not hide a checked gas sponsor link to the reported wallet', () => {
  const SP = '0x' + 'b2'.repeat(32);
  const withSponsor = { ...unlinked, gasSponsor: { sponsor: SP, isExchange: false, digest: 'dSp' } };
  const v = buildVerdict({ wallet: W, analysis: withSponsor, hubs: { funder: burst, sponsor: classifyHub([{ wallet: OTHER, timestampMs: 0 }]) }, memories: [{ ...report, body: { outcome: 'bad', funder: F, gasSponsor: SP } }] });
  assert.equal(v.verdict, 'do not pay');
  assert.equal(v.code, 'GROUP_BAD_OUTCOME');
});
