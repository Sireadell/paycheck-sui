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
