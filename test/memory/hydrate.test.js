// Counters survive a restart: the counts are read back from Walrus, the server never waits for it, and nothing about an answer changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory, buildText } from '../../src/memory/index.js';
import { createApp } from '../../server.js';

const A = '0x' + 'a'.repeat(64);
const B = '0x' + 'b'.repeat(64);
const note = (kind, origin, body, address = A) => buildText({ kind, address, group: 'g-1', origin }, body);

// A fake Walrus: rows already stored before this server started.
function fakeWalrus(rows, { gate = null, failList = false } = {}) {
  const calls = { list: 0, recall: 0 };
  const sdk = () => ({
    async listMemories({ namespace }) {
      calls.list++;
      if (gate) await gate;
      if (failList) throw new Error('relayer down');
      return { memories: rows.filter((r) => r.namespace === namespace).map((r) => ({ memory_id: 'm-' + r.blob_id, blob_id: r.blob_id })), next_cursor: null, has_more: false };
    },
    async recall({ namespace, limit }) { calls.recall++; return { results: rows.filter((r) => r.namespace === namespace).slice(0, limit), total: rows.length }; },
    async rememberAndWait(text, namespace) { return { id: 'id-new', blob_id: 'blob-new', owner: '0xo', namespace }; },
    destroy() {},
  });
  return { sdk, calls };
}

const rows = [
  { namespace: 'live', blob_id: 'p1', text: note('verdict', 'prescan', { code: 'X' }) },
  { namespace: 'live', blob_id: 'p2', text: note('verdict', 'prescan', { code: 'X' }, B) },
  { namespace: 'live', blob_id: 'c1', text: note('verdict', 'check', { code: 'GROUP_BAD_OUTCOME', changedByIds: ['mem-bad-1'] }) },
  { namespace: 'live', blob_id: 'c2', text: note('verdict', 'check', { code: 'LINKED_NO_BAD_HISTORY' }) },
  { namespace: 'shared-outcomes', blob_id: 'o1', text: note('outcome', 'agent-a', { outcome: 'bad' }) },
  { namespace: 'k2-test', blob_id: 't1', text: note('verdict', 'k2-test', {}) },
];

test('after a restart the counts are read back from Walrus: live, pre-scan, and answers a memory changed', async () => {
  const w = fakeWalrus(rows);
  const m = createMemory({ sdkFactory: w.sdk });
  assert.deepEqual(m.counter(), { changed: 0, stored: 0, prescan: 0, test: 0 });
  const h = await m.hydrate();
  assert.equal(h.state, 'done');
  assert.deepEqual(m.counter(), { changed: 1, stored: 5, prescan: 2, test: 0 });
  assert.equal(h.namespaces.live.listed, 4);
  assert.equal(h.restoredChanged, 1);
});

test('a memory written this session is not counted twice when Walrus lists it too', async () => {
  const w = fakeWalrus(rows);
  const m = createMemory({ sdkFactory: w.sdk });
  await m.hydrate();
  const before = m.counter().stored;
  // The same blob arrives through a write: still one memory.
  rows.push({ namespace: 'live', blob_id: 'blob-new', text: note('verdict', 'check', {}) });
  try {
    await m.write({ namespace: 'live', kind: 'verdict', address: A, group: 'g-1', origin: 'check', body: { n: 1 } });
    await m.hydrate();
    assert.equal(m.counter().stored, before + 1);
  } finally { rows.pop(); }
});

test('old notes (no changedByIds, odd bodies, other text) read back without error and count once', async () => {
  const odd = [
    { namespace: 'live', blob_id: 'a', text: note('verdict', 'check', { code: 'OLD' }) },
    { namespace: 'live', blob_id: 'b', text: 'PAYCHECK v1 kind=verdict address=- group=- origin=check\nnot json' },
    { namespace: 'live', blob_id: 'c', text: 'some other text' },
    { namespace: 'live', blob_id: 'd', text: note('verdict', 'check', { changedByIds: 'oops' }) },
  ];
  const m = createMemory({ sdkFactory: fakeWalrus(odd).sdk });
  await m.hydrate();
  assert.deepEqual(m.counter(), { changed: 0, stored: 4, prescan: 0, test: 0 });
});

test('Walrus down: hydrate does not throw, says failed, and writes still count', async () => {
  const w = fakeWalrus(rows, { failList: true });
  const sdk = w.sdk;
  const m = createMemory({ sdkFactory: (ns) => { const c = sdk(ns); c.recall = async () => { throw new Error('down'); }; return c; }, recallRetries: 0 });
  const h = await m.hydrate();
  assert.equal(h.state, 'failed');
  await m.write({ namespace: 'live', kind: 'verdict', address: A, group: null, origin: 'check', body: {} });
  assert.equal(m.counter().stored, 1);
});

test('the server answers /api/stats before Walrus has replied, then the numbers fill in', async () => {
  let open;
  const gate = new Promise((r) => { open = r; });
  const w = fakeWalrus(rows, { gate });
  const m = createMemory({ sdkFactory: w.sdk });
  const checker = { state: {}, mode: 'live' };
  const app = createApp({ checker, memory: m, probe: async () => true, dataDir: '/nonexistent' });
  const srv = app.listen(0);
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const hydrating = m.hydrate();
    const early = await (await fetch(base + '/api/stats')).json();
    assert.equal(early.memories.counting.state, 'loading');
    assert.equal(early.memories.live, 0);
    open();
    await hydrating;
    const late = await (await fetch(base + '/api/stats')).json();
    assert.equal(late.memories.counting.state, 'done');
    assert.deepEqual([late.memories.live, late.memories.prescan, late.memories.changedVerdicts], [3, 2, 1]);
    assert.match(late.memories.note, /counted from Walrus/);
  } finally { app.locals.stop(); srv.close(); }
});
