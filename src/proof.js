// The proof page: every number is read from a recorded file and recounted from its rows. Nothing here calls a provider.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tally, lossLists } from '../scripts/lib/bench.js';

const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
const lc = (a) => String(a ?? '').toLowerCase();
const NO_LINKS = 'NO_LINKS_NO_BAD_HISTORY';
const COLUMN_KEYS = { ai: 'ai', aiReport: 'aiReport', nomem: 'checker', mem: 'memory' };

/** Recounts the real set from its stored rows (not from the stored summary). */
export function recountRealSet(r) {
  if (!r?.groups || !r?.controls) return null;
  const hasLink = (res, addr) => (res?.links ?? []).some((l) => lc(l.address) === lc(addr));
  const groups = r.groups.map((g) => ({ ...g, caught: hasLink(g.probeResult, g.linkAddress) }));
  const controls = r.controls.map((c) => ({ ...c, alarm: c.result?.code !== NO_LINKS || (c.result?.links ?? []).length > 0 }));
  const members = r.groups.flatMap((g) => g.memberResults ?? []);
  const membersCaught = r.groups.reduce((s, g) => s + (g.memberResults ?? []).filter((m) => hasLink(m, g.linkAddress)).length, 0);
  return {
    groups: groups.length,
    groupsCaught: groups.filter((g) => g.caught).length,
    missed: groups.filter((g) => !g.caught).map((g) => g.id),
    members: members.length,
    membersCaught,
    sponsorGroups: groups.filter((g) => g.type === 'gas_sponsor').length,
    caughtBySponsor: groups.filter((g) => g.type === 'gas_sponsor' && g.caught).length,
    funderGroups: groups.filter((g) => g.type === 'shared_funder').length,
    caughtByFunder: groups.filter((g) => g.type === 'shared_funder' && g.caught).length,
    controls: controls.length,
    controlsWithCaution: controls.filter((c) => c.alarm).length,
    controlsStrict: controls.filter((c) => c.result?.verdict === 'do not pay').length,
  };
}

/** Recounts the four-column held-out test from the stored cases. */
export function recountBenchmark(b) {
  if (!Array.isArray(b?.cases)) return null;
  const held = b.cases.filter((x) => x.case?.split === 'heldout');
  const columns = {};
  for (const [col, key] of Object.entries(COLUMN_KEYS)) columns[key] = tally(held, col);
  const losses = lossLists(held);
  const lostIds = [...new Set([...losses.weLost, ...losses.aiBeat].map((x) => x.id))];
  return { cases: held.length, columns, lostIds, memoryChanged: held.filter((x) => x.mem?.changedByMemory).length };
}

const optionalRun = async (path, check) => {
  const d = await readJson(path);
  return d && check(d) ? { ran: true, data: d } : { ran: false };
};

/** Everything the page and the reproduce script show, plus the stored numbers to compare against. */
export async function loadProof({ dataDir, benchDir }) {
  const realRaw = await readJson(join(dataDir, 'real-set', 'results.json'));
  const deepRaw = await readJson(join(dataDir, 'real-set', 'results-tx200.json'));
  const benchRaw = await readJson(join(benchDir, 'results', 'real.json'));
  const verified = await readJson(join(dataDir, 'prescan', 'verified.json'));
  const stress = await optionalRun(join(benchDir, 'results', 'stress.json'), (d) => Number.isFinite(d.caught) && Number.isFinite(d.total));
  const crossAgent = await optionalRun(join(dataDir, 'cross-agent', 'latest.json'), (d) => d.agentA?.memoryId && d.agentB?.address);
  const refuseThenPay = await optionalRun(join(dataDir, 'refuse-then-pay', 'latest.json'), (d) => typeof d === 'object');
  const paidCheck = await optionalRun(join(dataDir, 'paid-check', 'latest.json'), (d) => typeof d === 'object');
  return {
    real: { recount: recountRealSet(realRaw), recorded: realRaw?.summary ?? null, ranAt: realRaw?.ranAt ?? null },
    deep: { recount: recountRealSet(deepRaw), recorded: deepRaw?.summary ?? null },
    benchmark: { recount: recountBenchmark(benchRaw), recorded: benchRaw?.summary ?? null, model: benchRaw?.model ?? null, temperature: benchRaw?.temperature ?? null, ranAt: benchRaw?.ranAt ?? null },
    prescan: verified && Array.isArray(verified.verified)
      ? { recalledAndVerified: verified.verified.length, of: verified.of ?? null, checkedAt: verified.checkedAt ?? null }
      : null,
    stress, crossAgent, refuseThenPay, paidCheck,
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (t, vars = {}) => esc(String(t ?? '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k]))));
const ofN = (n, d) => `${n} of ${d}`;

/** The proof page as plain HTML. Wording comes from copy.proof (web/copy.json). */
export function renderProof(proof, copy) {
  const c = copy.proof;
  const b = copy.bench;
  const notRun = (text) => `<p class="not-run"><strong>${esc(c.notRunTag)}</strong> ${esc(text)}</p>`;
  const inline = (text) => `<span class="not-run"><strong>${esc(c.notRunTag)}</strong> ${esc(text)}</span>`;
  const out = [];
  const rr = proof.real.recount;
  const bm = proof.benchmark.recount;

  out.push(`<section class="proof-block"><h2>${esc(c.realHeading)}</h2>`);
  if (rr) {
    out.push(`<p class="big">${esc(ofN(rr.groupsCaught, rr.groups))} <span>${esc(c.realTail)}</span></p>`);
    out.push(`<p>${fill(c.realDetail, { membersCaught: rr.membersCaught, members: rr.members, sponsor: ofN(rr.caughtBySponsor, rr.sponsorGroups), funder: ofN(rr.caughtByFunder, rr.funderGroups) })}</p>`);
    out.push(`<p>${fill(c.realControls, { strict: ofN(rr.controlsStrict, rr.controls), caution: ofN(rr.controlsWithCaution, rr.controls) })}</p>`);
    out.push(`<p>${fill(c.realMissed, { ids: rr.missed.join(', ') })}</p>`);
    const dr = proof.deep.recount;
    if (dr) out.push(`<p>${fill(c.deepLine, { caught: ofN(dr.groupsCaught, dr.groups), calls: proof.deep.recorded?.tatumCallsPerCheckAvg ?? '?' })}</p>`);
  } else out.push(notRun(c.missingFile));
  out.push('</section>');

  out.push(`<section class="proof-block"><h2>${esc(c.benchHeading)}</h2>`);
  if (bm) {
    out.push(`<p>${fill(b.columnsLead, { groups: bm.columns.memory.groups, controls: bm.columns.memory.controls, model: proof.benchmark.model })}</p>`);
    out.push(`<p>${esc(b.columnsTest)}</p>`);
    out.push(`<div class="table-wrap"><table class="proof-table"><thead><tr><th></th>${Object.values(COLUMN_KEYS).map((k) => `<th>${esc(b.columnHeads[k])}</th>`).join('')}</tr></thead><tbody>`);
    for (const [row, field, of] of [['stopped', 'stopped', 'groups'], ['linkFound', 'linkFound', 'groups'], ['controlsStrict', 'falseAlarmStrict', 'controls'], ['controlsLoose', 'falseAlarmIncl', 'controls']]) {
      out.push(`<tr><th scope="row">${esc(b.columnRows[row])}</th>${Object.values(COLUMN_KEYS).map((k) => `<td>${esc(ofN(bm.columns[k][field], bm.columns[k][of]))}</td>`).join('')}</tr>`);
    }
    out.push('</tbody></table></div>');
    out.push(`<p>${esc(b.columnsHonest)}</p>`);
    out.push(`<h3>${esc(b.lossesHeading)}</h3><ul class="losses">`);
    for (const l of b.losses) out.push(`<li><strong>${esc(l.id)}</strong> ${esc(l.text)}</li>`);
    out.push('</ul>');
  } else out.push(notRun(c.missingFile));
  out.push('</section>');

  out.push(`<section class="proof-block"><h2>${esc(c.prescanHeading)}</h2>`);
  if (proof.prescan) {
    out.push(`<p class="big">${esc(ofN(proof.prescan.recalledAndVerified, proof.prescan.of))} <span>${esc(c.prescanTail)}</span></p>`);
    out.push(`<p>${esc(c.prescanNote)}</p>`);
  } else out.push(notRun(c.missingFile));
  out.push('</section>');

  out.push(`<section class="proof-block"><h2>${esc(c.laterHeading)}</h2><p>${esc(c.laterLead)}</p><dl class="later">`);
  const { stress, crossAgent: x, refuseThenPay: rp, paidCheck: pc } = proof;
  out.push(`<dt>${esc(c.stressName)}</dt><dd>${stress.ran ? fill(c.stressDone, { caught: stress.data.caught, total: stress.data.total }) : inline(c.stressNone)}</dd>`);
  out.push(`<dt>${esc(c.crossName)}</dt><dd>${x.ran ? fill(c.crossDone, { memoryId: x.data.agentA.memoryId, a: x.data.agentA.address, b: x.data.agentB.address }) : inline(c.crossNone)}</dd>`);
  out.push(`<dt>${esc(c.refuseName)}</dt><dd>${rp.ran ? esc(c.refuseDone) : inline(c.refuseNone)}</dd>`);
  out.push(`<dt>${esc(c.paidName)}</dt><dd>${pc.ran ? esc(c.paidDone) : inline(c.paidNone)}</dd>`);
  out.push('</dl></section>');

  out.push(`<section class="proof-block"><h2>${esc(c.methodHeading)}</h2><p>${esc(c.methodLead)} <a href="/docs/METHOD.md">${esc(c.methodLink)}</a>. <a href="/docs/REPRODUCE.md">${esc(c.reproduceLink)}</a></p></section>`);
  out.push(`<section class="proof-block"><h2>${esc(copy.limits.heading)}</h2><ul>${copy.limits.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></section>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.pageTitle)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="top"><div class="wrap top-row"><a class="brand" href="/"><strong>${esc(copy.title)}</strong></a></div></header>
<main><div class="wrap">
<h1>${esc(c.heading)}</h1>
<p>${esc(c.lead)}</p>
${out.join('\n')}
</div></main>
<footer class="wrap"><p>${esc(copy.footer)}</p></footer>
</body>
</html>
`;
}
