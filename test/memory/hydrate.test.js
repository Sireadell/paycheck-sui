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
  assert.deepEqual(m.counter(), { changed: 0, stored: 0, prescan: 0, unlabelled: 0, test: 0 });
  const h = await m.hydrate();
  assert.equal(h.state, 'done');
  assert.deepEqual(m.counter(), { changed: 1, stored: 5, prescan: 2, unlabelled: 0, test: 0 });
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
  // 'some other text' is not a PayCheck note, so its label cannot be read: it is counted, as unlabelled.
  assert.deepEqual(m.counter(), { changed: 0, stored: 4, prescan: 0, unlabelled: 1, test: 0 });
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

// More than 100 notes in one namespace: a search returns at most 100, the list comes in pages, and every note is still counted and labelled.
function bigWalrus({ prescan, checks, stray = 0 }) {
  const rows = [];
  for (let i = 0; i < prescan; i++) rows.push({ blob_id: 'p' + i, text: buildText({ kind: 'verdict', address: A, group: 'g-p' + (i % 15), origin: 'prescan' }, { i }) });
  for (let i = 0; i < checks; i++) rows.push({ blob_id: 'c' + i, text: buildText({ kind: 'verdict', address: B, group: 'g-c' + (i % 10), origin: 'check' }, { i }) });
  for (let i = 0; i < stray; i++) rows.push({ blob_id: 's' + i, text: 'not a paycheck note ' + i });
  const calls = { recall: 0, maxReturned: 0, listPages: 0 };
  const sdk = () => ({
    async listMemories({ cursor, namespace }) {
      if (namespace !== 'live') return { memories: [], next_cursor: null, has_more: false };
      calls.listPages++;
      const from = cursor ? Number(cursor) : 0;
      const page = rows.slice(from, from + 100);
      const next = from + 100;
      return { memories: page.map((r) => ({ memory_id: 'm-' + r.blob_id, blob_id: r.blob_id })), next_cursor: String(next), has_more: next < rows.length };
    },
    // Nearest notes first, at most limit. A query word that matches the header narrows it. Unmatched notes are never returned.
    async recall({ namespace, query, limit }) {
      calls.recall++;
      if (namespace !== 'live') return { results: [], total: 0 };
      const words = String(query).replace('PAYCHECK v1 ', '').split(' ').filter((w) => w.includes('='));
      const hits = rows.filter((r) => r.text.startsWith('PAYCHECK') && words.every((w) => r.text.split(String.fromCharCode(10))[0].includes(w))).slice(0, limit);
      calls.maxReturned = Math.max(calls.maxReturned, hits.length);
      return { results: hits, total: hits.length };
    },
    async rememberAndWait() { return { id: 'x', blob_id: 'x' }; },
    destroy() {},
  });
  return { sdk, calls };
}

test('more than 100 notes in one space: every note is counted and labelled, and live + pre-scan add up to the total listed', async () => {
  const w = bigWalrus({ prescan: 150, checks: 120 });
  const m = createMemory({ sdkFactory: w.sdk });
  const h = await m.hydrate({ namespaces: ['live'] });
  assert.equal(h.state, 'done');
  assert.equal(h.namespaces.live.listed, 270);
  assert.ok(w.calls.listPages >= 3, 'the list is paged to the end');
  assert.equal(w.calls.maxReturned, 100, 'no single search returned more than 100');
  const c = m.counter();
  assert.equal(c.prescan, 150);
  assert.equal(c.unlabelled, 0);
  assert.equal(c.stored - c.prescan - c.unlabelled, 120);
  assert.equal(h.namespaces.live.unlabelled, 0);
});

test('a note whose label cannot be read is shown as unlabelled, not guessed', async () => {
  const w = bigWalrus({ prescan: 110, checks: 5, stray: 3 });
  const m = createMemory({ sdkFactory: w.sdk });
  await m.hydrate({ namespaces: ['live'] });
  const c = m.counter();
  assert.equal(c.stored, 118);
  assert.equal(c.prescan, 110);
  assert.equal(c.unlabelled, 3);
  assert.equal(c.stored - c.prescan - c.unlabelled, 5);
});

test('the search count is capped, so a huge space cannot make the read-back run forever', async () => {
  const w = bigWalrus({ prescan: 300, checks: 0 });
  const m = createMemory({ sdkFactory: w.sdk });
  const h = await m.hydrate({ namespaces: ['live'], maxSearches: 5 });
  assert.ok(h.namespaces.live.searches <= 5);
  assert.equal(m.counter().stored, 300);
});
