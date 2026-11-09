// The failures page: every miss and false alarm comes from the saved rows and agrees with the proof page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { loadFailures, renderFailures } from '../src/failures.js';
import { loadProof } from '../src/proof.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const dataDir = join(ROOT, 'data');
const benchDir = join(ROOT, 'bench');
const copy = JSON.parse(readFileSync(join(ROOT, 'web', 'copy.json'), 'utf8'));
const stub = { checker: { state: {}, mode: 'test' }, memory: { health: async () => true, failed: () => [], pending: () => [], counter: () => ({ stored: 0, prescan: 0, test: 0, changed: 0 }) } };

test('failures agree with the proof page recount', async () => {
  const f = await loadFailures({ dataDir, benchDir });
  const p = await loadProof({ dataDir, benchDir });
  assert.deepEqual(f.real.missedGroups.map((g) => g.id), p.real.recount.missed);
  assert.equal(f.real.members - f.real.membersMissed, p.real.recount.membersCaught);
  assert.equal(f.real.alarms.length, p.real.recount.controlsWithCaution);
  assert.deepEqual(f.benchmark.lostIds.slice().sort(), p.benchmark.recount.lostIds.slice().sort());
  assert.equal(f.prescan.of - f.prescan.failed, p.prescan.recalledAndVerified);
  assert.equal(f.prescan.reasons.reduce((s, r) => s + r.count, 0), f.prescan.failed);
});

test('failures page names every lost case with its write-up and no em dashes', async () => {
  const f = await loadFailures({ dataDir, benchDir });
  const html = renderFailures(f, copy);
  for (const id of [...f.real.missedGroups.map((g) => g.id), ...f.real.alarms.map((a) => a.id), ...f.benchmark.lostIds]) assert.ok(html.includes(id), id);
  assert.ok(!html.includes(copy.failures.noText), 'a lost case has no write-up in copy.json');
  assert.ok(!html.includes('—'));
});

test('missing files say so instead of showing zero', async () => {
  const f = await loadFailures({ dataDir: join(ROOT, 'no-such-dir'), benchDir: join(ROOT, 'no-such-dir') });
  assert.equal(f.real, null);
  assert.ok(renderFailures(f, copy).includes(copy.proof.notRunTag));
});

test('/failures and /api/failures are served, and /proof shows curl commands for this host', async () => {
  const app = createApp({ ...stub, dataDir, benchDir });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(`${base}/failures`)).text();
    assert.match(page, /rs-15/);
    const api = await (await fetch(`${base}/api/failures`)).json();
    assert.ok(Array.isArray(api.real.missedGroups));
    const proof = await (await fetch(`${base}/proof`)).text();
    assert.ok(proof.includes(`curl "${base}/api/stats"`));
    assert.ok(proof.includes('href="/failures"'));
  } finally { server.close(); app.locals.stop?.(); }
});
