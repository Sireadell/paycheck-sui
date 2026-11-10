// The warnings feed: the last 5 shared bad-outcome reports, read only. It never touches an answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createMemory, buildText } from '../src/memory/index.js';

const A = '0x' + 'a'.repeat(64);
const out = (n, outcome, origin, reporter, at, address = A) => ({ blob_id: 'blob-' + n, created_at: at, text: buildText({ kind: 'outcome', address, group: 'g-1', origin }, { outcome, reporter, reportedAt: at, test: false }) });
const walrus = (rows) => () => ({ async recall({ namespace }) { return { results: namespace === 'shared-outcomes' ? rows : [] }; }, async rememberAndWait(t, ns) { return { id: 'i', blob_id: 'blob-new', namespace: ns }; }, destroy() {} });

const rows = [
  out(1, 'bad', 'agent-a', 'agent-a', '2026-11-08T10:00:00Z'),
  out(2, 'good', 'agent-a', 'agent-a', '2026-11-09T10:00:00Z'),
  out(3, 'bad', 'agent-b', 'agent-b', '2026-11-10T09:00:00Z'),
  out(4, 'bad', 'k2-test', 'test-run', '2026-11-10T09:30:00Z'),
  ...[5, 6, 7, 8, 9].map((n) => out(n, 'bad', 'agent-a', 'agent-a', `2026-11-0${n}T08:00:00Z`)),
  { blob_id: 'blob-x', created_at: null, text: 'some other text' },
];

test('memory.recentOutcomes lists only bad reports, newest first, 5 at most, never test ones', async () => {
  const m = createMemory({ sdkFactory: walrus(rows) });
  const l = await m.recentOutcomes({ limit: 5 });
  assert.equal(l.length, 5);
  assert.equal(l[0].memoryId, 'blob-3');
  assert.equal(l[0].reporter, 'agent-b');
  assert.ok(l.every((w) => w.origin !== 'k2-test' && w.memoryId !== 'blob-2'));
  assert.deepEqual(Object.keys(l[0]).sort(), ['memoryId', 'origin', 'reportedAddress', 'reportedAt', 'reporter']);
});

test('a report saved by this server shows at once, once, even if Walrus lists it too', async () => {
  const m = createMemory({ sdkFactory: walrus([]) });
  await m.write({ namespace: 'shared-outcomes', kind: 'outcome', address: A, group: null, origin: 'agent-a', body: { outcome: 'bad', reporter: 'agent-a', reportedAt: '2026-11-10T11:00:00Z' } });
  const l = await m.recentOutcomes();
  assert.equal(l.length, 1);
  assert.equal(l[0].memoryId, 'blob-new');
});

async function serve(memory, extra = {}) {
  const checker = { state: {}, mode: 'live', check: async () => ({ verdict: 'pay' }) };
  const app = createApp({ checker, memory: { health: async () => true, failed: () => [], pending: () => [], counter: () => ({ stored: 0, prescan: 0, test: 0, changed: 0 }), ...memory }, probe: async () => true, dataDir: '/nonexistent', ...extra });
  const srv = app.listen(0);
  return { base: `http://127.0.0.1:${srv.address().port}`, done: () => { app.locals.stop(); srv.close(); } };
}

test('GET /api/warnings answers the list, caches it for a minute, and is read only', async () => {
  let reads = 0;
  const s = await serve({ recentOutcomes: async () => { reads++; return [{ memoryId: 'm1', reporter: 'agent-a', reportedAt: '2026-11-10T09:00:00Z', reportedAddress: A, origin: 'agent-a' }]; } });
  try {
    const a = await (await fetch(s.base + '/api/warnings')).json();
    const b = await (await fetch(s.base + '/api/warnings')).json();
    assert.equal(a.state, 'ok');
    assert.equal(a.warnings[0].memoryId, 'm1');
    assert.equal(a.limit, 5);
    assert.equal(b.warnings.length, 1);
    assert.equal(reads, 1);
    assert.equal((await fetch(s.base + '/api/warnings', { method: 'POST' })).status, 404);
    assert.deepEqual(await (await fetch(s.base + '/api/check?address=x')).json(), { verdict: 'pay' }); // answers are untouched
  } finally { s.done(); }
});

test('if Walrus fails the feed says so, keeps the last good list, and the rest of the server is unaffected', async () => {
  let t = 0;
  let fail = false;
  const s = await serve({ recentOutcomes: async () => { if (fail) throw new Error('down'); return [{ memoryId: 'm1', reporter: 'r', reportedAt: null, reportedAddress: null, origin: 'x' }]; } }, { now: () => t });
  try {
    assert.equal((await (await fetch(s.base + '/api/warnings')).json()).state, 'ok');
    fail = true; t += 61000;
    await fetch(s.base + '/api/warnings'); // starts the refresh
    await new Promise((r) => setTimeout(r, 20));
    const d = await (await fetch(s.base + '/api/warnings')).json();
    assert.equal(d.state, 'stale');
    assert.equal(d.warnings[0].memoryId, 'm1');
    assert.equal((await fetch(s.base + '/health')).status, 200);
  } finally { s.done(); }
});

test('a memory layer with no list method gives an empty, plain answer', async () => {
  const s = await serve({});
  try {
    const d = await (await fetch(s.base + '/api/warnings')).json();
    assert.equal(d.state, 'unavailable');
    assert.deepEqual(d.warnings, []);
  } finally { s.done(); }
});
