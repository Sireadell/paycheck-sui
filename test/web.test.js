import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../server.js';
import { createChecker } from '../src/check.js';
import { createTatum } from '../src/providers/tatum.js';

const rec = (n) => JSON.parse(readFileSync(new URL(`./recorded/${n}.json`, import.meta.url), 'utf8'));
const WALLET = rec('pick').addr;
const json = (body) => new Response(JSON.stringify(body), { status: 200 });

// Recorded real Tatum answers, and one hand-built bad report (TEST-FIXTURE-WEB) on the wallet itself.
const fetchImpl = async (_u, init) => {
  const q = JSON.parse(init.body).query;
  return json(q.includes('transactions(') ? rec('listTransactions').response : rec('latestCheckpoint').response);
};
const tatum = createTatum({ key: 'k', fetchImpl, limiter: async () => {}, retryWaitMs: 1 });
const memory = {
  recall: async () => [{ blobId: 'TEST-FIXTURE-WEB', kind: 'outcome', address: WALLET, group: null, origin: 'check', writtenAt: new Date().toISOString(), body: { outcome: 'bad', reporter: 'fixture' } }],
  enqueue: () => ({ state: 'pending', key: 'k' }),
  markChanged() {},
  health: async () => true, failed: () => [], pending: () => [],
  counter: () => ({ stored: 25, prescan: 20, test: 3, changed: 2 }),
};
const checker = createChecker({ tatum, memory, mode: 'test' });

async function serve() {
  const app = createApp({ checker, memory, checkLimit: { max: 100, windowMs: 60000 } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => { app.locals.stop(); server.close(); server.closeAllConnections?.(); } };
}

test('first screen: page, copy file and styles are served', async () => {
  const s = await serve();
  try {
    const html = await (await fetch(`${s.base}/`)).text();
    assert.match(html, /<script src="app.js"/);
    for (const f of ['app.js', 'style.css', 'sample.json']) assert.equal((await fetch(`${s.base}/${f}`)).status, 200, f);
    const copy = await (await fetch(`${s.base}/copy.json`)).json();
    assert.ok(copy.tagline && copy.panel && copy.bench && copy.counters && copy.limits.items.length >= 5);
  } finally { s.close(); }
});

test('first screen: every reader-facing word is in copy.json, with no em dashes', () => {
  const dir = new URL('../web/', import.meta.url);
  const html = readFileSync(new URL('index.html', dir), 'utf8');
  // Static HTML holds no text between tags except inside script and style.
  const body = html.replace(/<title>[\s\S]*?<\/title>|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '');
  assert.equal(body.replace(/\s+/g, ''), '', 'index.html has text outside copy.json');
  for (const f of ['copy.json', 'sample.json', 'app.js', 'index.html', 'style.css']) assert.ok(!readFileSync(new URL(f, dir), 'utf8').includes('—'), `${f} has an em dash`);
});

test('first screen: benchmark numbers come from the real set file, real set first', async () => {
  const s = await serve();
  try {
    const b = await (await fetch(`${s.base}/api/benchmark`)).json();
    const file = JSON.parse(readFileSync(new URL('../data/real-set/results.json', import.meta.url), 'utf8'));
    assert.equal(b.real.caught, file.summary.groupsCaught);
    assert.equal(b.real.groups, file.summary.realGroups);
    assert.match(b.real.label, /real set, verified by script against two providers/);
    assert.equal(b.real.falseAlarmsStrict, 0);
    assert.equal(b.real.falseAlarmsWithCaution, 3);
    assert.ok(b.real.suggested.address.startsWith('0x'));
    if (b.stress) assert.match(b.stress.label, /synthetic/);
  } finally { s.close(); }
});

test('first screen: stats keep live, pre-scan and test on separate lines', async () => {
  const s = await serve();
  try {
    const st = await (await fetch(`${s.base}/api/stats`)).json();
    assert.deepEqual([st.memories.live, st.memories.prescan, st.memories.test, st.memories.changedVerdicts], [5, 20, 3, 2]);
    assert.equal(st.mode, 'test');
  } finally { s.close(); }
});

test('first screen: the cross-agent endpoint is a clean 404 until a real run exists', async () => {
  const s = await serve();
  try {
    const r = await fetch(`${s.base}/api/cross-agent`);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { available: false });
  } finally { s.close(); }
});

test('first screen: memory=on and memory=off give different verdicts for the same address (fixture report)', async () => {
  const s = await serve();
  try {
    const on = await (await fetch(`${s.base}/api/check?address=${WALLET}&memory=on`)).json();
    const off = await (await fetch(`${s.base}/api/check?address=${WALLET}&memory=off`)).json();
    assert.equal(on.verdict, 'do not pay');
    assert.equal(off.verdict, 'pay');
    assert.equal(on.withoutMemory.verdict, 'pay');
    assert.equal(on.changedByMemory, true);
    assert.equal(on.test, true);
  } finally { s.close(); }
});
