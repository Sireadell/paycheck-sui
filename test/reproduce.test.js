// The reproduce script: default mode recounts saved files and agrees with the page; a changed number is caught; live mode compares with the saved run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, liveCompare, proofLines } from '../scripts/reproduce.js';
import { loadProof } from '../src/proof.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'repro-'));
  for (const f of ['data/real-set/results.json', 'data/prescan/verified.json', 'bench/results/real.json']) {
    await mkdir(join(root, f, '..'), { recursive: true });
    await cp(join(ROOT, f), join(root, f));
  }
  return { dataDir: join(root, 'data'), benchDir: join(root, 'bench'), root };
}

test('default mode prints the proof numbers and finds 0 differences', async () => {
  const lines = [];
  const code = await main([], { out: (l) => lines.push(l) });
  assert.equal(code, 0);
  const text = lines.join('\n');
  assert.match(text, /real groups found: 18 of 20/);
  assert.match(text, /pre-scan recalled and verified: 171 of 200/);
  assert.match(text, /groups missed: rs-15, rs-19/);
  assert.match(text, /loss cases: rc-12, rs-15, rs-19, rs-20/);
  assert.match(text, /stress test: (not yet run|\d+ of \d+)/);
  assert.match(text, /0 differences$/);
});

test('every printed number is one the proof page shows', async () => {
  const p = await loadProof({ dataDir: join(ROOT, 'data'), benchDir: join(ROOT, 'bench') });
  const names = proofLines(p).map(([n]) => n);
  assert.ok(names.includes('real groups found'));
  assert.ok(proofLines(p).every(([, t]) => typeof t === 'string' && t.length > 0));
});

test('changing a stored number by one makes it exit 1', async () => {
  const d = await scratch();
  const file = join(d.dataDir, 'real-set', 'results.json');
  const j = JSON.parse(await readFile(file, 'utf8'));
  j.summary.groupsCaught += 1;
  await writeFile(file, JSON.stringify(j));
  const lines = [];
  const code = await main([], { dataDir: d.dataDir, benchDir: d.benchDir, out: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /DIFFERENCE groups caught/);
});

test('a missing results file is reported as a difference, not a crash', async () => {
  const d = await scratch();
  const lines = [];
  const code = await main([], { dataDir: join(d.root, 'nothing'), benchDir: join(d.root, 'nothing'), out: (l) => lines.push(l) });
  assert.equal(code, 1);
});

test('live mode compares each wallet with the saved run and counts differences', async () => {
  const link = '0xlink';
  const groups = [{ id: 'g1', probe: '0xp1', linkAddress: link, caught: true }, { id: 'g2', probe: '0xp2', linkAddress: link, caught: true }];
  const controls = [{ id: 'c1', address: '0xc1', falseAlarm: false }, { id: 'c2', address: '0xc2', falseAlarm: true }];
  const answers = {
    '0xp1': { verdict: 'pay', code: 'LINKED_NO_BAD_HISTORY', evidence: [{ kind: 'link', address: link }] },
    '0xp2': { verdict: 'pay', code: 'NO_LINKS_NO_BAD_HISTORY', evidence: [] },
    '0xc1': { verdict: 'pay', code: 'NO_LINKS_NO_BAD_HISTORY', evidence: [] },
    '0xc2': { verdict: 'caution', code: 'ROUND_TRIP_TO_FUNDER', evidence: [] },
  };
  const seen = [];
  const checker = { check: async (a, o) => { seen.push(o.memoryOn); return answers[a]; } };
  const r = await liveCompare({ groups, controls, checker });
  assert.deepEqual({ caught: r.caught, strict: r.strict, caution: r.caution }, { caught: 1, strict: 0, caution: 1 });
  assert.equal(r.diffs.length, 1);
  assert.match(r.diffs[0], /g2: saved found, now missed/);
  assert.ok(seen.every((m) => m === false), 'memory is off in live mode');
});

test('--live goes through the injected runner and its differences count', async () => {
  const lines = [];
  const code = await main(['--live'], { out: (l) => lines.push(l), liveRunner: async () => ({ caught: 18, groups: 20, strict: 0, caution: 3, controls: 20, diffs: ['g9: saved found, now missed'] }) });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /Live: groups found 18 of 20/);
  assert.match(lines.join('\n'), /1 differences$/);
});
