// The proof page and its data: numbers come from the saved files, unrun steps say so, finished runs fill in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { loadProof, renderProof, recountRealSet, recountBenchmark } from '../src/proof.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const dataDir = join(ROOT, 'data');
const benchDir = join(ROOT, 'bench');
const copy = JSON.parse(await (await import('node:fs/promises')).readFile(join(ROOT, 'web', 'copy.json'), 'utf8'));
const stub = { checker: { state: {}, mode: 'test' }, memory: { health: async () => true, failed: () => [], pending: () => [], counter: () => ({ stored: 0, prescan: 0, test: 0, changed: 0 }) } };

/** A copy of the saved files in a temp folder, so a test can add a results file without touching the repo. */
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'proof-'));
  await mkdir(join(root, 'data', 'real-set'), { recursive: true });
  await mkdir(join(root, 'data', 'prescan'), { recursive: true });
  await mkdir(join(root, 'bench', 'results'), { recursive: true });
  await cp(join(dataDir, 'real-set', 'results.json'), join(root, 'data', 'real-set', 'results.json'));
  await cp(join(dataDir, 'prescan', 'verified.json'), join(root, 'data', 'prescan', 'verified.json'));
  await cp(join(benchDir, 'results', 'real.json'), join(root, 'bench', 'results', 'real.json'));
  return { dataDir: join(root, 'data'), benchDir: join(root, 'bench') };
}

test('recounted numbers equal the numbers stored in the files', async () => {
  const p = await loadProof({ dataDir, benchDir });
  const r = p.real.recount;
  const s = p.real.recorded;
  assert.equal(r.groupsCaught, s.groupsCaught);
  assert.equal(r.groups, s.realGroups);
  assert.equal(r.membersCaught, s.memberWalletsCaught);
  assert.equal(r.controlsWithCaution, s.falseAlarms);
  assert.equal(r.controlsStrict, s.strictFalseAlarms ?? 0);
  assert.deepEqual(r.missed, ['rs-15', 'rs-19']);
  const h = p.benchmark.recorded.heldout;
  const c = p.benchmark.recount.columns;
  assert.deepEqual({ ai: c.ai, aiReport: c.aiReport, checker: c.checker, memory: c.memory }, { ai: h.ai, aiReport: h.aiReport, checker: h.nomem, memory: h.mem });
  assert.deepEqual([...p.benchmark.recount.lostIds].sort(), ['rc-12', 'rs-15', 'rs-19', 'rs-20']);
  assert.equal(p.prescan.recalledAndVerified, 171);
  assert.equal(p.prescan.of, 200);
});

test('recounts return null for missing or broken files', () => {
  assert.equal(recountRealSet(null), null);
  assert.equal(recountBenchmark({}), null);
});

test('/proof shows the four columns, the losses, pre-scan and the notes', async () => {
  const app = createApp({ ...stub, probe: async () => {} });
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/proof`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /18 of 20/);
    assert.match(html, /171 of 200/);
    for (const id of ['rs-15', 'rs-20', 'rc-12', 'rs-19']) assert.ok(html.includes(`<strong>${id}</strong>`), id);
    for (const head of ['Plain AI', 'Plain AI + report', 'Checker', 'Checker + memory']) assert.ok(html.includes(`<th>${head}</th>`), head);
    assert.ok(html.includes('What this is not'));
    assert.ok(html.includes('href="/docs/METHOD.md"'));
    assert.equal((html.match(/Not yet run\./g) ?? []).length, 4);
    assert.ok(!html.includes('—'));
    const api = await (await fetch(`http://127.0.0.1:${server.address().port}/api/proof`)).json();
    assert.equal(api.prescan.recalledAndVerified, 171);
    const doc = await fetch(`http://127.0.0.1:${server.address().port}/docs/METHOD.md`);
    assert.equal(doc.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/docs/..%2Fpackage.json`)).status, 404);
  } finally { app.locals.stop(); server.close(); server.closeAllConnections?.(); }
});

test('unrun steps show "not yet run" and no invented value', async () => {
  const dirs = await scratch();
  const html = renderProof(await loadProof(dirs), copy);
  assert.equal((html.match(/Not yet run\./g) ?? []).length, 4);
  assert.ok(!/\d+ of \d+ found\. These wallets are synthetic/.test(html));
});

test('stress and cross-agent fill in by themselves when their files exist', async () => {
  const dirs = await scratch();
  await writeFile(join(dirs.benchDir, 'results', 'stress.json'), JSON.stringify({ caught: 7, total: 9 }));
  await mkdir(join(dirs.dataDir, 'cross-agent'), { recursive: true });
  await writeFile(join(dirs.dataDir, 'cross-agent', 'latest.json'), JSON.stringify({ agentA: { memoryId: 'MEM-XYZ', address: '0xaaa' }, agentB: { address: '0xbbb' } }));
  const html = renderProof(await loadProof(dirs), copy);
  assert.match(html, /7 of 9 found/);
  assert.match(html, /MEM-XYZ/);
  assert.equal((html.match(/Not yet run\./g) ?? []).length, 2);
});

test('a stress file without numbers is ignored, not shown as zero', async () => {
  const dirs = await scratch();
  await writeFile(join(dirs.benchDir, 'results', 'stress.json'), JSON.stringify({ note: 'half written' }));
  const p = await loadProof(dirs);
  assert.equal(p.stress.ran, false);
});

test('missing results files give an honest message, not a crash', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'proof-empty-'));
  const html = renderProof(await loadProof({ dataDir: empty, benchDir: empty }), copy);
  assert.ok(html.includes("The saved results file couldn&#39;t be read."));
});
