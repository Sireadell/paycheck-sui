// Offline checks of the benchmark helpers: the fixed split, the AI prompt and answer parsing, the counts and the loss lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCases, buildPrompt, parseAnswer, tally, lossLists, didWell } from '../scripts/lib/bench.js';

const A = (n) => `0x${String(n).padStart(64, '0')}`;
const spec = {
  groups: [
    { id: 'g1', type: 'shared_funder', linkAddress: A(900), probe: A(2), members: [{ address: A(1) }, { address: A(2) }] },
    { id: 'g2', type: 'gas_sponsor', linkAddress: A(901), probe: A(3), members: [{ address: A(3) }, { address: A(4) }, { address: A(5) }] },
  ],
  controls: [{ id: 'c2', address: A(12) }, { id: 'c1', address: A(11) }, { id: 'c3', address: A(13) }, { id: 'c4', address: A(14) }],
};

test('split: probe held out, first other member trains; controls alternate by id order', () => {
  const cases = buildCases(spec, 'fx');
  const by = Object.fromEntries(cases.map((c) => [c.id, c]));
  assert.equal(by.g1.wallet, A(2)); assert.equal(by.g1.trainWallet, A(1)); assert.equal(by.g1.split, 'heldout'); assert.equal(by.g1.trainOutcome, 'bad');
  assert.equal(by.g2.wallet, A(3)); assert.equal(by.g2.trainWallet, A(4));
  assert.deepEqual(['c1', 'c2', 'c3', 'c4'].map((id) => by[id].split), ['train', 'heldout', 'train', 'heldout']);
  assert.equal(by.c1.trainOutcome, 'good');
  // a held-out wallet is never its own training wallet
  for (const c of cases.filter((x) => x.split === 'heldout')) assert.notEqual(c.trainWallet, c.wallet);
});

test('split does not depend on any outcome: same input, same split, order of members decides', () => {
  assert.deepEqual(buildCases(spec, 'fx'), buildCases(JSON.parse(JSON.stringify(spec)), 'fx'));
});

test('parseAnswer reads the three answers and the link address, and flags unreadable text', () => {
  assert.deepEqual(parseAnswer('{"verdict":"do not pay","linked":true,"link_address":"0xABC","reason":"x"}'), { verdict: 'do not pay', linked: true, linkAddress: '0xabc', reason: 'x' });
  assert.equal(parseAnswer('```json\n{"verdict":"Caution","linked":false,"link_address":null,"reason":"r"}\n```').verdict, 'caution');
  assert.equal(parseAnswer('{"verdict":"pay"}').verdict, 'pay');
  assert.equal(parseAnswer('no idea').verdict, 'unparsed');
  assert.equal(parseAnswer('"verdict": "do not pay", broken').verdict, 'do not pay');
});

test('prompt carries the wallet, funder and sponsor histories and says none when absent', () => {
  const tx = { digest: 'D1', timestamp: 't', sender: A(7), gasSponsor: A(8), status: 'SUCCESS', balanceChanges: [{ owner: A(7), amount: '5', coin: '0x2::sui::SUI' }] };
  const p = buildPrompt('W={{WALLET}}\n{{WALLET_TXS}}\nF={{FUNDER}}\n{{FUNDER_TXS}}\nS={{SPONSOR}}\n{{SPONSOR_TXS}}', { wallet: A(7), walletTxs: [tx], funder: null, funderTxs: [], sponsor: A(8), sponsorTxs: [tx] });
  assert.match(p, /"d":"D1"/);
  assert.match(p, /F=none found\n\(none\)/);
  assert.ok(p.includes(`S=${A(8)}`));
  assert.ok(!p.includes('{{'));
});

const kase = (id, kind, link = null) => ({ id, kind, linkAddress: link, split: 'heldout' });
const col = (verdict, linkAddress = null, code = null) => ({ verdict, linkAddress, code });

test('tally and loss lists count each column the same way', () => {
  const rows = [
    { case: kase('g1', 'group', A(900)), ai: col('pay', A(900)), nomem: col('pay', A(900)), mem: col('do not pay', A(900)) },
    { case: kase('g2', 'group', A(901)), ai: col('caution', A(901)), nomem: col('pay', null), mem: col('pay', null, 'LINKED_NO_BAD_HISTORY') },
    { case: kase('c1', 'control'), ai: col('caution'), nomem: col('pay'), mem: col('pay') },
    { case: kase('c2', 'control'), ai: col('pay'), nomem: col('caution'), mem: col('caution', null, 'ROUND_TRIP_TO_FUNDER') },
  ];
  assert.deepEqual(tally(rows, 'mem'), { groups: 2, linkFound: 1, flagged: 1, stopped: 1, controls: 2, falseAlarmStrict: 0, falseAlarmIncl: 1 });
  assert.deepEqual(tally(rows, 'ai'), { groups: 2, linkFound: 2, flagged: 1, stopped: 0, controls: 2, falseAlarmStrict: 0, falseAlarmIncl: 1 });
  const { aiBeat, weLost } = lossLists(rows);
  assert.deepEqual(aiBeat.map((x) => x.id), ['g2', 'c2']);
  assert.deepEqual(weLost.map((x) => x.id), ['g2', 'c2']);
  assert.equal(didWell(kase('x', 'control'), col('caution')), false);
});
