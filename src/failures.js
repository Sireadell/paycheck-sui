// The failures page: every miss, false alarm and failed recall, recounted from the saved rows on each load.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recountBenchmark } from './proof.js';

const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
const lc = (a) => String(a ?? '').toLowerCase();
const NO_LINKS = 'NO_LINKS_NO_BAD_HISTORY';
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a ?? '');

function realSet(r, depth) {
  if (!r?.groups || !r?.controls) return null;
  const hasLink = (res, addr) => (res?.links ?? []).some((l) => lc(l.address) === lc(addr));
  const missedGroups = r.groups.filter((g) => !hasLink(g.probeResult, g.linkAddress)).map((g) => ({ id: g.id, type: g.type, link: g.linkAddress }));
  const members = r.groups.map((g) => {
    const all = g.memberResults ?? [];
    return { id: g.id, missed: all.filter((m) => !hasLink(m, g.linkAddress)).length, of: all.length };
  });
  const alarms = r.controls
    .filter((c) => c.result?.code !== NO_LINKS || (c.result?.links ?? []).length > 0)
    .map((c) => ({ id: c.id, verdict: c.result?.verdict ?? null, code: c.result?.code ?? null }));
  return {
    depth,
    missedGroups,
    groups: r.groups.length,
    membersMissed: members.reduce((s, m) => s + m.missed, 0),
    members: members.reduce((s, m) => s + m.of, 0),
    membersByGroup: members.filter((m) => m.missed > 0),
    alarms,
    controls: r.controls.length,
  };
}

function prescan(v) {
  if (!v || !Array.isArray(v.failed)) return null;
  const reasons = {};
  for (const f of v.failed) {
    const k = String(f.error ?? 'unknown').trim();
    reasons[k] = (reasons[k] || 0) + 1;
  }
  return { failed: v.failed.length, of: v.of ?? null, reasons: Object.entries(reasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) };
}

/** Every failure the saved files record. Nothing is typed in; text for the benchmark losses is checked against the recount. */
export async function loadFailures({ dataDir, benchDir }) {
  const real = await readJson(join(dataDir, 'real-set', 'results.json'));
  const deep = await readJson(join(dataDir, 'real-set', 'results-tx200.json'));
  const bench = await readJson(join(benchDir, 'results', 'real.json'));
  const verified = await readJson(join(dataDir, 'prescan', 'verified.json'));
  const stress = await readJson(join(benchDir, 'results', 'stress.json'));
  const bm = recountBenchmark(bench);
  return {
    real: realSet(real, 50),
    deep: realSet(deep, 200),
    benchmark: bm ? { cases: bm.cases, lostIds: bm.lostIds } : null,
    prescan: prescan(verified),
    stress: stress && Number.isFinite(stress.caught) && Number.isFinite(stress.total)
      ? { missed: stress.total - stress.caught, total: stress.total, falseAlarms: stress.falseAlarms ?? null, controls: stress.controls ?? null }
      : null,
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (t, vars = {}) => esc(String(t ?? '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k]))));
const ofN = (n, d) => `${n} of ${d}`;

/** The failures page as plain HTML. Wording comes from copy.failures (web/copy.json). */
export function renderFailures(f, copy) {
  const c = copy.failures;
  const out = [];
  const source = (file) => `<p class="source">${esc(c.sourceTag)} <code>${esc(file)}</code></p>`;
  const missing = `<p class="not-run"><strong>${esc(copy.proof.notRunTag)}</strong> ${esc(copy.proof.missingFile)}</p>`;
  const table = (heads, rows) => `<div class="table-wrap"><table class="proof-table"><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const linkName = (type) => (type === 'gas_sponsor' ? c.linkSponsor : c.linkFunder);

  const r = f.real;
  out.push(`<section class="proof-block"><h2>${esc(c.groupsHeading)}</h2>`);
  if (r) {
    out.push(`<p class="big">${esc(ofN(r.missedGroups.length, r.groups))} <span>${esc(c.groupsTail)}</span></p>`);
    const deepIds = new Set((f.deep?.missedGroups ?? []).map((g) => g.id));
    out.push(table(c.groupsHeads, r.missedGroups.map((g) => [
      `<strong>${esc(g.id)}</strong>`,
      fill(c.groupsRow, { link: linkName(g.type), address: short(g.link) }),
      esc(f.deep ? (deepIds.has(g.id) ? c.deepStillMissed : c.deepFound) : c.deepNotRun),
    ])));
    out.push(`<p>${fill(c.membersLine, { missed: ofN(r.membersMissed, r.members), ids: r.membersByGroup.map((m) => `${m.id} (${m.missed} of ${m.of})`).join(', ') })}</p>`);
    out.push(source('data/real-set/results.json, data/real-set/results-tx200.json'));
  } else out.push(missing);
  out.push('</section>');

  out.push(`<section class="proof-block"><h2>${esc(c.alarmsHeading)}</h2>`);
  if (r) {
    out.push(`<p class="big">${esc(ofN(r.alarms.length, r.controls))} <span>${esc(c.alarmsTail)}</span></p>`);
    out.push(table(c.alarmsHeads, r.alarms.map((a) => [`<strong>${esc(a.id)}</strong>`, esc(a.verdict), `<code>${esc(a.code)}</code>`, esc(c.codes[a.code] ?? '')])));
    out.push(`<p>${esc(c.alarmsNote)}</p>`);
    out.push(source('data/real-set/results.json'));
  } else out.push(missing);
  out.push('</section>');

  out.push(`<section class="proof-block"><h2>${esc(c.benchHeading)}</h2>`);
  if (f.benchmark) {
    const texts = new Map(copy.bench.losses.map((l) => [l.id, l.text]));
    out.push(`<p class="big">${esc(ofN(f.benchmark.lostIds.length, f.benchmark.cases))} <span>${esc(c.benchTail)}</span></p>`);
    out.push(table(c.benchHeads, f.benchmark.lostIds.map((id) => [`<strong>${esc(id)}</strong>`, esc(texts.get(id) ?? c.noText)])));
    out.push(source('bench/results/real.json'));
  } else out.push(missing);
  out.push('</section>');

  out.push(`<section class="proof-block"><h2>${esc(c.prescanHeading)}</h2>`);
  if (f.prescan) {
    out.push(`<p class="big">${esc(ofN(f.prescan.failed, f.prescan.of))} <span>${esc(c.prescanTail)}</span></p>`);
    out.push(table(c.prescanHeads, f.prescan.reasons.map((x) => [esc(x.count), esc(x.reason)])));
    out.push(`<p>${esc(c.prescanNote)}</p>`);
    out.push(source('data/prescan/verified.json'));
  } else out.push(missing);
  out.push('</section>');

  out.push(`<section class="proof-block"><h2>${esc(c.stressHeading)}</h2>`);
  if (f.stress) {
    out.push(`<p>${fill(c.stressLine, { missed: ofN(f.stress.missed, f.stress.total), alarms: f.stress.falseAlarms === null ? '?' : ofN(f.stress.falseAlarms, f.stress.controls) })}</p>`);
    out.push(source('bench/results/stress.json'));
  } else out.push(`<p class="not-run"><strong>${esc(copy.proof.notRunTag)}</strong> ${esc(copy.proof.stressNone)}</p>`);
  out.push('</section>');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.pageTitle)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body class="proof-page">
<header class="top"><div class="wrap top-row"><a class="brand" href="/"><strong>${esc(copy.title)}</strong></a><a class="top-link" href="/proof">${esc(copy.proof.navLink)}</a></div></header>
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
