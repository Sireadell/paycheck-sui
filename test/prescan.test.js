import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickFromCheckpoint, extendPicks, tally, withBackoff, isRateOrQuota, ZERO_ADDRESS } from '../src/prescan.js';
import { runPrescan } from '../scripts/prescan.js';
import { createMemory } from '../src/memory/index.js';
import { createApp } from '../server.js';
import { padAddress } from '../src/address.js';

const addr = (n) => padAddress('0x' + n.toString(16));
const tx = (n, status = 'SUCCESS') => ({ digest: 'd' + n, sender: addr(n), status });
const noSleep = async () => {};

test('pick rule: successful senders in order, no duplicates, no zero address, first 50 only', () => {
  const seen = new Set();
  const txs = [tx(1), tx(2, 'FAILURE'), tx(1), { digest: 'z', sender: ZERO_ADDRESS, status: 'SUCCESS' }, tx(3), ...Array.from({ length: 60 }, (_, i) => tx(100 + i))];
  const got = pickFromCheckpoint(txs, seen);
  assert.deepEqual(got.slice(0, 2), [addr(1), addr(3)]);
  assert.ok(!got.includes(addr(2)));
  assert.equal(got.length, 2 + 45); // 5 listed before the 60, so only 45 of them are inside the first 50
});

test('picks walk down checkpoint by checkpoint and a longer run extends the shorter list', async () => {
  const data = { 10: [tx(1), tx(2), tx(3)], 9: [tx(3), tx(4)], 8: [tx(5), tx(6)] };
  const ct = async (cp) => data[cp];
  const p = { startCheckpoint: 10, currentCheckpoint: 10, picks: [] };
  await extendPicks(p, 2, { checkpointTransactions: ct, floor: 1 });
  assert.deepEqual(p.picks, [addr(1), addr(2)]);
  await extendPicks(p, 5, { checkpointTransactions: ct, floor: 1 });
  assert.deepEqual(p.picks, [addr(1), addr(2), addr(3), addr(4), addr(5)]);
  assert.equal(p.currentCheckpoint, 8);
});

test('the walk stops at the data floor', async () => {
  const p = { startCheckpoint: 5, currentCheckpoint: 5, picks: [] };
  await assert.rejects(extendPicks(p, 3, { checkpointTransactions: async () => [], floor: 4 }), /data floor/);
});

test('tally splits kinds and verdicts', () => {
  const t = tally([
    { verdict: 'pay', code: 'NO_LINKS_NO_BAD_HISTORY', walletHub: null },
    { verdict: 'pay', code: 'LINKED_NO_BAD_HISTORY', walletHub: null },
    { verdict: 'pay', code: 'LINKED_NO_BAD_HISTORY', walletHub: 'shared service, weak link' },
    { verdict: 'caution', code: 'ROUND_TRIP_TO_FUNDER', walletHub: null },
  ]);
  assert.deepEqual(t.byKind, { 'shared service': 1, linked: 1, 'no history': 1, other: 1 });
  assert.deepEqual(t.byVerdict, { pay: 3, caution: 1, 'do not pay': 0 });
});

test('limit messages are recognised, network errors are retried five times then thrown', async () => {
  assert.ok(isRateOrQuota('Tatum HTTP 429'));
  assert.ok(!isRateOrQuota('fetch failed'));
  let n = 0;
  await assert.rejects(withBackoff(async () => { n++; throw new Error('fetch failed'); }, { sleep: noSleep }), /fetch failed/);
  assert.equal(n, 5);
  n = 0;
  await assert.rejects(withBackoff(async () => { n++; throw new Error('Tatum HTTP 429'); }, { sleep: noSleep }), /429/);
  assert.equal(n, 1);
});

// A fake world: checkpoint 100 holds 30 wallets, memory is an in-process store.
function world({ failChecksAfter = Infinity } = {}) {
  const stored = new Map();
  let checks = 0;
  const calls = { n: 0 };
  const tatum = {
    latestCheckpoint: async () => 100,
    checkpointTransactions: async (cp) => { calls.n++; return cp === 100 ? Array.from({ length: 30 }, (_, i) => tx(i + 1)) : []; },
  };
  const memory = createMemory({ sdkFactory: () => ({
    async rememberBulkAndWait(items) {
      const results = items.map((it, i) => { const id = 'b' + stored.size; stored.set(id, it.text); return { id, blob_id: id, status: 'done' }; });
      return { results, total: items.length, succeeded: items.length, failed: 0 };
    },
    async recall({ query }) { return { results: [...stored].filter(([, t]) => t.includes(`address=${query} `)).map(([id, text]) => ({ blob_id: id, text })) }; },
    destroy() {},
  }) });
  const checker = {
    mode: 'live',
    state: { lastRecallOk: true },
    check: async (address, opts) => {
      checks++;
      if (checks > failChecksAfter) return { address, code: 'DATA_UNAVAILABLE', verdict: 'caution', notes: ['Chain data could not be read (Tatum HTTP 429).'], memory: {} };
      return { address, verdict: 'pay', code: 'NO_LINKS_NO_BAD_HISTORY', label: 'no links, no bad history', walletHub: null, reason: 'x', memory: { degraded: false }, callLog: { tatum: { calls: 5 } },
        memoryItem: { namespace: 'live', kind: 'verdict', address, group: null, origin: opts.originOverride, body: { ...opts.extraBody, verdict: 'pay', funder: null, gasSponsor: null, links: 0 } } };
    },
  };
  const callLog = { summarize: () => ({ calls: calls.n }) };
  return { tatum, memory, checker, callLog, stored, get checks() { return checks; } };
}
const run = (w, count, dir, extra = {}) => runPrescan({ count, dir, tatum: w.tatum, checker: w.checker, memory: w.memory, floor: 1, sleep: noSleep, log: () => {}, callLog: w.callLog, ...extra });

test('count 20: 20 checked, 20 stored as prescan, 20 recalled, stats show prescan and no changed verdicts', async () => {
  const w = world();
  const dir = mkdtempSync(join(tmpdir(), 'prescan-'));
  const out = await run(w, 20, dir);
  assert.equal(out.rows.length, 20);
  assert.equal(out.stored, 20);
  assert.equal(out.recalled, 20);
  assert.equal(out.stopped, null);
  assert.equal(readFileSync(join(dir, 'verdicts.jsonl'), 'utf8').trim().split('\n').length, 20);
  const app = createApp({ checker: w.checker, memory: w.memory });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const stats = await (await fetch(`http://127.0.0.1:${server.address().port}/api/stats`)).json();
    assert.equal(stats.memories.prescan, 20);
    assert.equal(stats.memories.live, 0);
    assert.equal(stats.memories.changedVerdicts, 0);
  } finally { app.locals.stop(); server.close(); server.closeAllConnections?.(); }
});

test('a second run with a larger count resumes: the first 20 are kept and only new wallets are checked', async () => {
  const w = world();
  const dir = mkdtempSync(join(tmpdir(), 'prescan-'));
  await run(w, 20, dir);
  const first = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8')).picks.slice();
  const before = w.checks;
  const out = await run(w, 30, dir);
  assert.equal(w.checks - before, 10);
  assert.deepEqual(out.progress.picks.slice(0, 20), first);
  assert.equal(out.rows.length, 30);
  assert.equal(out.stored, 30);
});

test('a limit message stops the run, keeps what was stored and reports the exact message', async () => {
  const w = world({ failChecksAfter: 20 });
  const dir = mkdtempSync(join(tmpdir(), 'prescan-'));
  const out = await run(w, 30, dir);
  assert.equal(out.stopped.kind, 'limit');
  assert.match(out.stopped.message, /429/);
  assert.equal(out.stored, 20);
  assert.ok(existsSync(join(dir, 'progress.json')));
});

test('the Tatum cap stops the run before more checks', async () => {
  const w = world();
  const dir = mkdtempSync(join(tmpdir(), 'prescan-'));
  const out = await run(w, 20, dir, { tatumCap: 1 });
  assert.equal(out.stopped.kind, 'cap');
  assert.equal(w.checks, 0);
});
