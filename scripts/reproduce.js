// One command to recheck every number on /proof.
//   npm run reproduce            reads the saved results, recounts them row by row, prints the same numbers as /proof and checks they match. No network, no keys.
//   npm run reproduce -- --live  also runs the real set again on Tatum (with Ankr as the second opinion) and compares with the saved run.
// Live mode needs TATUM_API_KEY_MAINNET (and ANKR_API_KEY for the second opinion). The client keeps to 2.5 Tatum requests a second
// (the free plan allows 3) and 4 Ankr requests a second, so a full live run takes a few minutes. It reads the chain only: no memory is read or written.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadProof, renderProof } from '../src/proof.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ofN = (n, d) => `${n} of ${d}`;

/** The numbers /proof shows, as [name, text] pairs. Same wording as the page, so they can be found in its HTML. */
export function proofLines(proof) {
  const r = proof.real.recount;
  const bm = proof.benchmark.recount;
  const lines = [];
  if (r) {
    lines.push(['real groups found', ofN(r.groupsCaught, r.groups)]);
    lines.push(['wallets tied back to their group', ofN(r.membersCaught, r.members)]);
    lines.push(['found by fee payer', ofN(r.caughtBySponsor, r.sponsorGroups)]);
    lines.push(['found by first funder', ofN(r.caughtByFunder, r.funderGroups)]);
    lines.push(['ordinary wallets told "do not pay"', ofN(r.controlsStrict, r.controls)]);
    lines.push(['ordinary wallets told "do not pay" or "caution"', ofN(r.controlsWithCaution, r.controls)]);
    lines.push(['groups missed', r.missed.join(', ')]);
  }
  if (bm) {
    const names = { ai: 'plain AI', aiReport: 'plain AI + report', checker: 'checker', memory: 'checker + memory' };
    for (const [row, field, of] of [['group wallets answered "do not pay"', 'stopped', 'groups'], ['group wallets, right link named', 'linkFound', 'groups'], ['ordinary wallets wrongly told "do not pay"', 'falseAlarmStrict', 'controls'], ['ordinary wallets told "do not pay" or "caution"', 'falseAlarmIncl', 'controls']]) {
      for (const [k, label] of Object.entries(names)) lines.push([`${row}, ${label}`, ofN(bm.columns[k][field], bm.columns[k][of])]);
    }
    lines.push(['loss cases', bm.lostIds.sort().join(', ')]);
  }
  if (proof.prescan) lines.push(['pre-scan recalled and verified', ofN(proof.prescan.recalledAndVerified, proof.prescan.of)]);
  const later = [['stress test', proof.stress, (d) => ofN(d.caught, d.total)], ['cross-agent run', proof.crossAgent, (d) => d.agentA.memoryId], ['refuse then pay', proof.refuseThenPay, () => 'saved run found'], ['paid check', proof.paidCheck, () => 'saved run found']];
  for (const [name, run, show] of later) lines.push([name, run.ran ? show(run.data) : 'not yet run']);
  return lines;
}

/** Compares the recount with the numbers stored in the files, and the recount with the page. Returns a list of differences. */
export function findDifferences(proof, html, copy) {
  const diffs = [];
  const same = (name, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${name}: recounted ${JSON.stringify(a)}, stored ${JSON.stringify(b)}`); };
  const r = proof.real.recount;
  const s = proof.real.recorded;
  if (!r || !s) diffs.push('real set results file missing');
  else {
    same('real groups', r.groups, s.realGroups);
    same('groups caught', r.groupsCaught, s.groupsCaught);
    same('wallets checked', r.members, s.memberWalletsChecked);
    same('wallets caught', r.membersCaught, s.memberWalletsCaught);
    same('caught by fee payer', r.caughtBySponsor, s.caughtBySponsor);
    same('caught by first funder', r.caughtByFunder, s.caughtByFunder);
    same('controls', r.controls, s.controls);
    same('controls with caution', r.controlsWithCaution, s.falseAlarms);
    if (s.strictFalseAlarms !== undefined) same('controls strict', r.controlsStrict, s.strictFalseAlarms);
  }
  const bm = proof.benchmark.recount;
  const h = proof.benchmark.recorded?.heldout;
  if (!bm || !h) diffs.push('benchmark results file missing');
  else {
    same('benchmark plain AI', bm.columns.ai, h.ai);
    same('benchmark plain AI + report', bm.columns.aiReport, h.aiReport);
    same('benchmark checker', bm.columns.checker, h.nomem);
    same('benchmark checker + memory', bm.columns.memory, h.mem);
    same('loss cases on the page', bm.lostIds.slice().sort(), copy.bench.losses.map((l) => l.id).sort());
  }
  if (!proof.prescan) diffs.push('pre-scan verified file missing');
  for (const [name, text] of proofLines(proof)) {
    if (text === 'not yet run' || text === 'saved run found' || !text) continue;
    // Every count printed here must be on the page exactly as printed.
    if (/^\d+ of \d+$/.test(text) && !html.includes(text)) diffs.push(`page does not show ${name}: ${text}`);
  }
  return diffs;
}

export { liveCompare } from './lib/liveCompare.js';

export async function main(argv = process.argv.slice(2), { dataDir = join(ROOT, 'data'), benchDir = join(ROOT, 'bench'), webDir = join(ROOT, 'web'), out = console.log, liveRunner = null } = {}) {
  const copy = JSON.parse(await readFile(join(webDir, 'copy.json'), 'utf8'));
  const proof = await loadProof({ dataDir, benchDir });
  out('Recounted from the saved result files (no network):');
  for (const [name, text] of proofLines(proof)) out(`  ${name}: ${text}`);
  const diffs = findDifferences(proof, renderProof(proof, copy), copy);
  for (const d of diffs) out(`DIFFERENCE ${d}`);
  if (argv.includes('--live')) {
    out('Live run: reading the chain again on Tatum and Ankr (about 2.5 Tatum requests a second, so a few minutes).');
    const run = liveRunner ?? (await import('./lib/reproduceLive.js')).runLive;
    const raw = JSON.parse(await readFile(join(dataDir, 'real-set', 'results.json'), 'utf8'));
    const live = await run({ groups: raw.groups, controls: raw.controls, log: (m) => out(`  ${m}`) });
    out(`Live: groups found ${ofN(live.caught, live.groups)}, ordinary wallets told "do not pay" ${ofN(live.strict, live.controls)}, told "do not pay" or "caution" ${ofN(live.caution, live.controls)}`);
    for (const d of live.diffs) out(`DIFFERENCE live ${d}`);
    diffs.push(...live.diffs.map((d) => `live ${d}`));
  }
  out(`${diffs.length} differences`);
  return diffs.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main());
}
