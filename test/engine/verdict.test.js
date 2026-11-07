import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerdict, memorySavedCalls } from '../../src/engine/verdict.js';
import { classifyHub } from '../../src/engine/exchanges.js';

// Hand-built data, labelled so: no recorded verdict inputs exist yet.
const W = '0x' + 'a1'.repeat(32);
const F = '0x' + 'f1'.repeat(32);
const SP = '0x' + 'b2'.repeat(32);
const SIB = '0x' + 'c3'.repeat(32);
const base = (over = {}) => ({
  wallet: W,
  analysis: { wallet: W, firstFunder: null, gasSponsor: null, sharedFunder: null, roundTrip: { circular: false, secondHopCircular: false }, timing: { count: 0, matches: [] }, ...over },
});
const funderGroup = {
  firstFunder: { funder: F, isExchange: false },
  sharedFunder: { funder: F, groupSize: 2, siblings: [{ address: SIB, digest: 'dSib' }], excluded: null },
};
const hubFunder = { firstFunder: { funder: F, isExchange: false }, sharedFunder: { funder: F, groupSize: 0, siblings: [], excluded: 'exchange_like_fan_out' } };
const hubInfo = { verdict: 'shared service, weak link', countText: '16', hours: 30 };
const badOutcome = (over = {}) => ({ blobId: 'blob-bad-1', kind: 'outcome', origin: 'agent-a', namespace: 'shared-outcomes', address: SIB, group: 'g-1234abcd', body: { outcome: 'bad' }, ...over });

test('hub funder gives pay, no bad history, weak link shown', () => {
  const touches = Array.from({ length: 16 }, (_, i) => ({ wallet: '0x' + String(i).padStart(2, '0').repeat(32), timestampMs: i * 2 * 3_600_000 }));
  const hub = classifyHub(touches);
  assert.equal(hub.verdict, 'shared service, weak link');
  const v = buildVerdict({ ...base(hubFunder), hubs: { funder: hub }, groupId: 'g-1234abcd', memories: [] });
  assert.equal(v.verdict, 'pay');
  assert.equal(v.code, 'NO_LINKS_NO_BAD_HISTORY');
  assert.ok(v.evidence.some((e) => e.kind === 'weak_link'));
  assert.deepEqual(v.memoryIds, []);
});

test('same group, no bad history: linked, no bad history', () => {
  const v = buildVerdict({ ...base(funderGroup), groupId: 'g-1234abcd', memories: [] });
  assert.equal(v.verdict, 'pay');
  assert.equal(v.code, 'LINKED_NO_BAD_HISTORY');
  assert.match(v.reason, /not unsafe/);
});

test('same group plus bad outcome gives do not pay citing that memory id', () => {
  const v = buildVerdict({ ...base(funderGroup), groupId: 'g-1234abcd', memories: [badOutcome()] });
  assert.equal(v.verdict, 'do not pay');
  assert.equal(v.code, 'GROUP_BAD_OUTCOME');
  assert.deepEqual(v.memoryIds, ['blob-bad-1']);
  assert.equal(v.changedByMemory, true);
  assert.deepEqual(v.changedByIds, ['blob-bad-1']);
  const off = buildVerdict({ ...base(funderGroup), groupId: 'g-1234abcd', memories: [badOutcome()], memoryOn: false });
  assert.equal(off.verdict, 'pay');
  assert.deepEqual(off.memoryIds, []);
});

test('bad outcome on this exact address', () => {
  const v = buildVerdict({ ...base(), memories: [badOutcome({ address: W, group: null })] });
  assert.equal(v.verdict, 'do not pay');
  assert.equal(v.code, 'OUTCOME_BAD_SELF');
});

test('a bad group memory does not transfer through a hub-only link', () => {
  const v = buildVerdict({ ...base(hubFunder), hubs: { funder: hubInfo }, groupId: 'g-1234abcd', memories: [badOutcome()] });
  assert.equal(v.verdict, 'pay');
});

test('a hub with its own bad memory is red for itself, only caution for the wallets it served', () => {
  const hubBad = badOutcome({ address: F, group: null });
  const self = buildVerdict({ ...base(), wallet: F, memories: [hubBad] });
  assert.equal(self.verdict, 'do not pay');
  assert.equal(self.code, 'OUTCOME_BAD_SELF');
  const v = buildVerdict({ ...base(hubFunder), hubs: { funder: hubInfo }, memories: [hubBad] });
  assert.equal(v.verdict, 'caution');
  assert.equal(v.code, 'HUB_BAD_OUTCOME');
  assert.deepEqual(v.changedByIds, ['blob-bad-1']);
  // classifyHub given the bad memory id still counts as a hub here (long span)
  const v2 = buildVerdict({ ...base(hubFunder), hubs: { funder: { ...hubInfo, verdict: 'link', reason: 'bad_outcome_memory', spanMs: 30 * 3_600_000 } }, memories: [hubBad] });
  assert.equal(v2.code, 'HUB_BAD_OUTCOME');
});

test('funder itself reported bad, no siblings found: do not pay (direct fact link)', () => {
  const a = { firstFunder: { funder: F, isExchange: false, digest: 'dF' }, sharedFunder: { funder: F, groupSize: 0, siblings: [], excluded: null } };
  const few = { verdict: 'link', reason: 'few_wallets', wallets: 1 };
  const v = buildVerdict({ ...base(a), hubs: { funder: few }, memories: [badOutcome({ address: F, group: null })] });
  assert.equal(v.verdict, 'do not pay');
  assert.equal(v.warnedBy[0].via.type, 'funder_reported');
  // hub check not run on that funder: warning only
  const u = buildVerdict({ ...base(a), memories: [badOutcome({ address: F, group: null })] });
  assert.equal(u.code, 'LINK_NOT_CHECKED');
});

test('cross-agent: other wallet with same gas sponsor reported bad gives do not pay, cites the report', () => {
  const a = { gasSponsor: { sponsor: SP, digest: 'dGas', isExchange: false } };
  const few = { verdict: 'link', reason: 'few_wallets', wallets: 3 };
  const report = badOutcome({ address: SIB, group: null, body: { outcome: 'went bad', gasSponsor: SP, reporter: 'agent-a' } });
  const v = buildVerdict({ ...base(a), hubs: { sponsor: few }, memories: [report] });
  assert.equal(v.verdict, 'do not pay');
  assert.deepEqual(v.memoryIds, ['blob-bad-1']);
  assert.equal(v.warnedBy[0].reporter, 'agent-a');
  assert.equal(v.warnedBy[0].crossAddress, true);
  assert.equal(v.warnedBy[0].via.type, 'gas_sponsor');
  assert.equal(v.withoutMemory.verdict, 'pay');
  assert.equal(v.withoutMemory.label, 'linked, no bad history');
  assert.ok(v.evidence.find((e) => e.kind === 'link').basis === 'fact');
  assert.ok(v.evidence.find((e) => e.kind === 'memory').basis === 'report');
  // same report, sponsor not yet hub-checked: warning only
  assert.equal(buildVerdict({ ...base(a), memories: [report] }).code, 'LINK_NOT_CHECKED');
  // a platform sponsor (hub) passes nothing on to its other users
  const hub = buildVerdict({ ...base(a), hubs: { sponsor: hubInfo }, memories: [report] });
  assert.equal(hub.verdict, 'pay');
  assert.equal(hub.evidence.find((e) => e.kind === 'weak_link').basis, 'guess');
});

test('bad report on this address still stops a payment when on-chain data is missing', () => {
  const v = buildVerdict({ wallet: W, analysis: null, memories: [badOutcome({ address: W, group: null })] });
  assert.equal(v.verdict, 'do not pay');
  assert.match(v.reason, /only memory was used/);
});

test('round trip to the funder of the funder is shown but not counted', () => {
  const G = '0x' + 'd4'.repeat(32);
  const v = buildVerdict({ ...base({ firstFunder: { funder: F, isExchange: false }, roundTrip: { circular: true, matchedFunder: G, digest: 'd' } }), memories: [] });
  assert.equal(v.verdict, 'pay');
  assert.equal(v.evidence.find((e) => e.kind === 'round_trip').counted, false);
});

test('shared gas sponsor alone is a link; a bad memory in its group gives do not pay', () => {
  const a = { gasSponsor: { sponsor: SP, digest: 'dGas', isExchange: false } };
  assert.equal(buildVerdict({ ...base(a), memories: [] }).code, 'LINKED_NO_BAD_HISTORY');
  const v = buildVerdict({ ...base(a), groupId: 'g-1234abcd', memories: [badOutcome()] });
  assert.equal(v.verdict, 'do not pay');
});

test('round trip to funder is caution', () => {
  const v = buildVerdict({ ...base({ firstFunder: { funder: F, isExchange: false }, roundTrip: { circular: true, matchedFunder: F, digest: 'dRT' } }), memories: [] });
  assert.equal(v.verdict, 'caution');
  assert.equal(v.code, 'ROUND_TRIP_TO_FUNDER');
});

test('empty memory works, test memories are ignored, paid fine never makes it greener', () => {
  assert.equal(buildVerdict({ ...base(), memories: undefined }).verdict, 'pay');
  const t = buildVerdict({ ...base(funderGroup), groupId: 'g-1234abcd', memories: [badOutcome({ origin: 'k2-test', namespace: 'k2-test' })] });
  assert.equal(t.verdict, 'pay');
  const good = { blobId: 'blob-good', kind: 'outcome', origin: 'agent-a', address: W, body: { outcome: 'paid fine' } };
  const g = buildVerdict({ ...base({ roundTrip: { circular: true, matchedFunder: F, digest: 'd' }, firstFunder: { funder: F, isExchange: false } }), memories: [good] });
  assert.equal(g.verdict, 'caution');
  assert.deepEqual(g.memoryIds, ['blob-good']);
});

test('bad input: invalid address, missing data', () => {
  assert.equal(buildVerdict({}).code, 'INVALID_INPUT');
  assert.equal(buildVerdict({ wallet: 'nope', analysis: {} }).retryable, false);
  const m = buildVerdict({ wallet: W });
  assert.equal(m.code, 'DATA_UNAVAILABLE');
  assert.equal(m.retryable, true);
});

test('memory saved N calls: fresh verdict memory only', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const mk = (iso, over = {}) => ({ blobId: 'blob-v', kind: 'verdict', origin: 'check', address: W, writtenAt: iso, body: { tatumCalls: 7 }, ...over });
  assert.deepEqual(memorySavedCalls({ wallet: W, memories: [mk('2026-11-07T08:00:00Z')], now }), { saved: 7, memoryId: 'blob-v' });
  assert.equal(memorySavedCalls({ wallet: W, memories: [mk('2026-11-05T08:00:00Z')], now }).saved, 0);
  assert.equal(memorySavedCalls({ wallet: W, memories: [mk(null)], now }).saved, 0);
  assert.equal(memorySavedCalls({ wallet: W, memories: [mk('2026-11-07T08:00:00Z', { origin: 'k2-test' })], now }).saved, 0);
  const v = buildVerdict({ ...base(), memories: [mk('2026-11-07T08:00:00Z')], now });
  assert.equal(v.memorySavedCalls, 7);
  assert.equal(v.memorySavedFrom, 'blob-v');
});
