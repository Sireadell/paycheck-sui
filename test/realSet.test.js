// Checks the shape of the real set files and that every listed digest is backed by a saved raw answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const dir = new URL('../data/real-set/', import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, dir), 'utf8'));
const HEX = /^0x[0-9a-f]{64}$/;
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,50}$/;
const EM_DASH = String.fromCharCode(0x2014);

const groupsFile = read('groups.json');
const controlsFile = read('controls.json');
const raw = (digest) => {
  const f = new URL(`raw/proof/${digest}.json`, dir);
  assert.ok(existsSync(f), `raw answer missing for ${digest}`);
  return JSON.parse(readFileSync(f, 'utf8'));
};

test('groups.json: label, 2 or more members each, proof digests, timestamps and a reason', () => {
  assert.match(groupsFile.label, /real mainnet facts we hand-checked/);
  assert.ok(groupsFile.groups.length >= 1);
  const ids = new Set();
  for (const g of groupsFile.groups) {
    assert.ok(!ids.has(g.id)); ids.add(g.id);
    assert.ok(['gas_sponsor', 'shared_funder'].includes(g.type));
    assert.match(g.linkAddress, HEX);
    assert.ok(g.members.length >= 2 && g.members.length <= 6);
    assert.ok(g.members.some((m) => m.address === g.probe), 'probe is a member');
    assert.equal(g.verifiedAll, true);
    assert.ok(typeof g.reason === 'string' && g.reason.length > 20 && !g.reason.includes(EM_DASH));
    for (const m of g.members) {
      assert.match(m.address, HEX);
      assert.match(m.proofDigest, DIGEST);
      assert.ok(Number.isFinite(Date.parse(m.timestamp)));
      assert.ok(Number.isInteger(m.checkpoint));
      assert.equal(m.verified, true);
      assert.match(m.explorer, /^https:\/\/suiscan\.xyz\/mainnet\/tx\//);
    }
  }
});

test('controls.json: label, funder, funding digest and a reason', () => {
  assert.match(controlsFile.label, /real mainnet facts we hand-checked/);
  const seen = new Set();
  for (const c of controlsFile.controls) {
    assert.match(c.address, HEX);
    assert.match(c.funder, HEX);
    assert.match(c.fundingDigest, DIGEST);
    assert.ok(Number.isFinite(Date.parse(c.fundingTimestamp)));
    assert.ok(c.reason.length > 20 && !c.reason.includes(EM_DASH));
    assert.ok(!seen.has(c.address)); seen.add(c.address);
  }
});

test('no address is both a control and a group member or link address', () => {
  const grouped = new Set(groupsFile.groups.flatMap((g) => [g.linkAddress, ...g.members.map((m) => m.address)]));
  for (const c of controlsFile.controls) assert.ok(!grouped.has(c.address) && !grouped.has(c.funder));
});

test('every proof digest has a saved raw answer from the chain that shows the recorded link', () => {
  for (const g of groupsFile.groups) {
    for (const m of g.members) {
      const t = raw(m.proofDigest).tatum.transaction;
      assert.equal(t.digest, m.proofDigest);
      assert.equal(t.effects.status, 'SUCCESS');
      if (g.type === 'gas_sponsor') {
        assert.equal(t.sender.address.toLowerCase(), m.address);
        assert.equal(t.gasInput.gasSponsor.address.toLowerCase(), g.linkAddress);
      } else {
        assert.equal(t.sender.address.toLowerCase(), g.linkAddress);
        assert.ok(t.effects.balanceChanges.nodes.some((b) => b.owner?.address?.toLowerCase() === m.address && BigInt(b.amount) > 0n));
      }
    }
  }
  for (const c of controlsFile.controls) {
    const t = raw(c.fundingDigest).tatum.transaction;
    assert.equal(t.digest, c.fundingDigest);
    assert.equal(t.sender.address.toLowerCase(), c.funder);
    assert.ok(t.effects.balanceChanges.nodes.some((b) => b.owner?.address?.toLowerCase() === c.address && BigInt(b.amount) > 0n));
  }
});

test('results.json, when present, matches the case files and the printed counts', () => {
  const f = new URL('results.json', dir);
  if (!existsSync(f)) return;
  const r = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(r.memory, 'off');
  assert.equal(r.summary.realGroups, groupsFile.groups.length);
  assert.equal(r.summary.controls, controlsFile.controls.length);
  assert.equal(r.summary.groupsCaught, r.groups.filter((x) => x.caught).length);
  assert.equal(r.summary.falseAlarms, r.controls.filter((x) => x.falseAlarm).length);
});
