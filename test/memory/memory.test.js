import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory, buildText, parseHeader, parseMemory, idempotencyKey } from '../../src/memory/index.js';

// Fake SDK shaped like the real answers (RememberResult, RecallResult, RestoreResult, MemoriesResult).
function fakeSdk({ failTimes = 0, delay = 0 } = {}) {
  const store = [];
  const calls = { remember: 0, keys: [] };
  let fails = failTimes;
  const factory = () => ({
    async rememberAndWait(text, namespace, opts) {
      calls.remember++; calls.keys.push(opts.idempotencyKey);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (fails-- > 0) throw new Error('relayer 503');
      if (!store.some((s) => s.key === opts.idempotencyKey)) store.push({ key: opts.idempotencyKey, text, namespace, blob_id: 'blob' + store.length, id: 'id' + store.length });
      const s = store.find((x) => x.key === opts.idempotencyKey);
      return { id: s.id, blob_id: s.blob_id, owner: '0xo', namespace };
    },
    // Meaning search is fuzzy: returns every row in the namespace, so the exact filter has to do the work.
    async recall({ limit, namespace }) {
      const rows = store.filter((s) => s.namespace === namespace).slice(0, limit).map((s) => ({ blob_id: s.blob_id, text: s.text, distance: 0.5, created_at: '2026-11-07T10:00:00Z' }));
      return { results: rows, total: rows.length };
    },
    async restore(namespace) { return { restored: store.length, skipped: 0, failed: 0, total: store.length, namespace, owner: '0xo' }; },
    async listMemories({ namespace }) { return { memories: store.filter((s) => s.namespace === namespace).map((s) => ({ memory_id: s.id })), next_cursor: null, has_more: false }; },
    destroy() {},
  });
  return { factory, store, calls };
}

const A = '0x' + 'a'.repeat(64);
const B = '0x' + 'b'.repeat(64);
const base = { namespace: 'live', kind: 'verdict', origin: 'check', body: {} };

test('header round trip with origin', () => {
  const t = buildText({ kind: 'verdict', address: A, group: 'g-12345678', origin: 'prescan' }, { v: 'pay' });
  assert.equal(t.split('\n')[0], `PAYCHECK v1 kind=verdict address=${A} group=g-12345678 origin=prescan`);
  assert.deepEqual(parseMemory(t), { kind: 'verdict', address: A, group: 'g-12345678', origin: 'prescan', body: { v: 'pay' } });
  assert.equal(parseHeader('hello'), null);
  assert.throws(() => buildText({ kind: 'nope', origin: 'check' }));
  assert.throws(() => buildText({ kind: 'verdict', origin: 'nope' }));
});

test('write uses the text hash as idempotency key and the same text is written once', async () => {
  const f = fakeSdk();
  const m = createMemory({ sdkFactory: f.factory });
  const mem = { ...base, address: A, group: 'g-1', body: { v: 1 } };
  const r = await m.write(mem);
  await m.write(mem);
  assert.equal(r.state, 'stored');
  assert.equal(f.calls.remember, 1);
  assert.equal(f.calls.keys[0], idempotencyKey(buildText(mem, mem.body)));
});

test('recall keeps only exact address or group matches, ignoring fuzzy neighbours', async () => {
  const f = fakeSdk();
  const m = createMemory({ sdkFactory: f.factory });
  await m.write({ ...base, address: A, group: 'g-1' });
  await m.write({ ...base, kind: 'outcome', address: B, group: 'g-1' });
  await m.write({ ...base, address: B, group: 'g-2' });
  assert.equal((await m.recall({ namespace: 'live', address: A })).length, 1);
  assert.equal((await m.recall({ namespace: 'live', group: 'g-1' })).length, 2);
  assert.equal((await m.recall({ namespace: 'live', group: 'g-1', kind: 'outcome' }))[0].address, B);
  assert.equal((await m.recall({ namespace: 'live', address: '0x' + 'c'.repeat(64) })).length, 0);
  await assert.rejects(() => m.recall({ namespace: 'live' }));
});

test('queue: enqueue is pending at once, flush waits, failed writes retry then report', async () => {
  const f = fakeSdk({ delay: 20 });
  const m = createMemory({ sdkFactory: f.factory });
  const e = m.enqueue({ ...base, address: A });
  assert.equal(e.state, 'pending');
  assert.equal(m.pending().length, 1);
  await m.flush();
  assert.equal(m.pending().length, 0);
  assert.equal(m.entry(e.key, 'live').state, 'stored');

  const m2 = createMemory({ sdkFactory: fakeSdk({ failTimes: 1 }).factory, retryWaitMs: 1 });
  assert.equal((await m2.write({ ...base, address: A })).state, 'stored');

  const m3 = createMemory({ sdkFactory: fakeSdk({ failTimes: 99 }).factory, retryWaitMs: 1, retries: 1 });
  const r = await m3.write({ ...base, address: A });
  assert.equal(r.state, 'failed');
  assert.match(r.error, /503/);
  assert.equal(m3.failed().length, 1);
});

test('counter splits live, prescan and test; test never counts as stored', async () => {
  const m = createMemory({ sdkFactory: fakeSdk().factory });
  await m.write({ ...base, address: A });
  await m.write({ ...base, address: B, origin: 'prescan' });
  await m.write({ ...base, namespace: 'k2-test', address: A, origin: 'k2-test' });
  m.markChanged(['id0']);
  m.markChanged('id0');
  assert.deepEqual(m.counter(), { changed: 1, stored: 2, prescan: 1, test: 1 });
});

test('restore rebuilds a fresh instance from what the store holds', async () => {
  const f = fakeSdk();
  const first = createMemory({ sdkFactory: f.factory });
  await first.write({ ...base, address: A, origin: 'prescan' });
  await first.write({ ...base, address: B });
  const second = createMemory({ sdkFactory: f.factory });
  assert.deepEqual(second.counter(), { changed: 0, stored: 0, prescan: 0, test: 0 });
  const r = await second.restore('live');
  assert.equal(r.rebuilt, 2);
  assert.deepEqual(second.counter(), { changed: 0, stored: 2, prescan: 1, test: 0 });
  assert.equal(await second.listCount('live'), 2);
});

test('unknown namespace is refused', () => {
  const m = createMemory({ sdkFactory: fakeSdk().factory });
  assert.throws(() => m.enqueue({ ...base, namespace: 'oops' }));
});

test('bulkWrite stores a batch, skips what is already stored and counts prescan apart', async () => {
  const calls = [];
  const m = createMemory({ sdkFactory: () => ({
    async rememberBulkAndWait(items, opts) {
      calls.push({ n: items.length, key: opts.idempotencyKey });
      return { results: items.map((_, i) => ({ id: 'j' + i, blob_id: 'b' + i, status: 'done', namespace: 'live' })), total: items.length, succeeded: items.length, failed: 0 };
    },
    destroy() {},
  }) });
  const mk = (a) => ({ namespace: 'live', kind: 'verdict', origin: 'prescan', address: '0x' + a.repeat(64), group: null, body: { v: a } });
  const first = await m.bulkWrite([mk('1'), mk('2')]);
  assert.deepEqual(first.map((e) => e.state), ['stored', 'stored']);
  const second = await m.bulkWrite([mk('1'), mk('3')]);
  assert.equal(second.length, 1);
  assert.equal(calls[1].n, 1);
  assert.deepEqual(m.counter(), { changed: 0, stored: 3, prescan: 3, test: 0 });
});

test('bulkWrite marks every item failed when the call throws, and a retry writes them', async () => {
  let boom = true;
  const m = createMemory({ sdkFactory: () => ({
    async rememberBulkAndWait(items) {
      if (boom) throw new Error('relayer 503');
      return { results: items.map(() => ({ id: 'j', blob_id: 'b', status: 'done' })), total: items.length, succeeded: items.length, failed: 0 };
    },
    destroy() {},
  }) });
  const it = { namespace: 'live', kind: 'verdict', origin: 'prescan', address: '0x' + '4'.repeat(64), body: {} };
  assert.equal((await m.bulkWrite([it]))[0].state, 'failed');
  boom = false;
  assert.equal((await m.bulkWrite([it]))[0].state, 'stored');
});

test('recall: at most 2 at once, and a timed-out recall is retried', async () => {
  let active = 0, peak = 0, calls = 0;
  const flaky = new Set();
  const factory = () => ({
    async recall({ query }) {
      calls++; active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      if (query === A && !flaky.has(A)) { flaky.add(A); throw new Error('memory recall timed out after 5000 ms'); }
      return { results: [], total: 0 };
    },
    destroy() {},
  });
  const mem = createMemory({ sdkFactory: factory, recallRetryWaitMs: 1 });
  const addrs = [A, B, '0x' + 'c'.repeat(64), '0x' + 'd'.repeat(64), '0x' + 'e'.repeat(64), '0x' + 'f'.repeat(64)];
  await Promise.all(addrs.map((address) => mem.recall({ namespace: 'live', address })));
  assert.equal(peak, 2);
  assert.equal(calls, 7);
});

test('recall: gives up after 3 retries on timeouts, and does not retry other errors', async () => {
  let calls = 0;
  const mk = (msg) => createMemory({ recallRetryWaitMs: 1, sdkFactory: () => ({ async recall() { calls++; throw new Error(msg); }, destroy() {} }) });
  await assert.rejects(mk('recall timed out').recall({ namespace: 'live', address: A }), /timed out/);
  assert.equal(calls, 4);
  calls = 0;
  await assert.rejects(mk('relayer 500').recall({ namespace: 'live', address: A }), /500/);
  assert.equal(calls, 1);
});

test('recall asks for up to 100 memories by default and finds a wallet stored beyond the first 20', async () => {
  const f = fakeSdk();
  const asked = [];
  const inner = f.factory;
  const factory = (ns) => { const c = inner(ns); const r = c.recall; c.recall = (a) => { asked.push(a.limit); return r(a); }; return c; };
  const m = createMemory({ sdkFactory: factory });
  for (let i = 0; i < 30; i++) await m.write({ ...base, address: '0x' + i.toString(16).padStart(64, '0'), body: { i } });
  const last = '0x' + (29).toString(16).padStart(64, '0');
  const found = await m.recall({ namespace: 'live', address: last });
  assert.equal(found.length, 1);
  assert.equal(asked[0], 100);
});
