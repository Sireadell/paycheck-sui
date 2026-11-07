// Benchmark: plain AI vs our checker without memory vs our checker with memory, on the same cases and the same raw transactions.
// Usage: node --env-file=.env scripts/benchmark.js [--cases=<file.json> ...] [--rerun] [--model=<gemini model>]
// Reads only the cached raw answers under data/real-set/raw/cache (NO Tatum or Ankr calls: a case without cached data is skipped and listed).
// Gemini answers are cached under bench/raw (one call per case at most). Memory is trained and read only in the bench-train namespace.
// Progress: bench/progress.json (resumable). Result: bench/results/<name>.json. Split rule: docs/METHOD.md, "Benchmark split rule".
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTatum } from '../src/providers/tatum.js';
import { createChecker } from '../src/check.js';
import { createMemory } from '../src/memory/index.js';
import { ROOT, DIR, CACHE, readJson, writeJson } from './lib/realSetCommon.js';
import { buildCases, buildPrompt, parseAnswer, reportText, sha, tally, lossLists, lc } from './lib/bench.js';

const BENCH = path.join(ROOT, 'bench');
const RAW = path.join(BENCH, 'raw');
const RESULTS = path.join(BENCH, 'results');
const PROGRESS = path.join(BENCH, 'progress.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BATCH = 20;

// ---- cached-only Tatum: same cache key as scripts/lib/realSetCommon.js, but a missing file is an error, never a network call.
export function cachedOnlyTatum(misses) {
  const fetchImpl = async (_url, init) => {
    const key = createHash('sha256').update('tatum' + init.body).digest('hex').slice(0, 40);
    const file = path.join(CACHE, `${key}.json`);
    if (!existsSync(file)) { misses.add(key); const e = new Error('CACHE_MISS: no cached raw answer'); e.code = 'CACHE_MISS'; throw e; }
    return new Response(JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).json), { status: 200 });
  };
  return createTatum({ key: 'cache-only', fetchImpl, limiter: async () => {}, retryWaitMs: 1 });
}

const noMemory = { recall: async () => [], enqueue: () => ({ state: 'none', key: null }), write: async () => ({ state: 'none' }), markChanged() {}, flush: async () => {}, destroy() {} };

const slim = (r, linkAddress) => {
  const links = (r.evidence ?? []).filter((e) => e.kind === 'link').map((e) => ({ type: e.type, address: e.address ?? null }));
  const match = linkAddress ? links.find((l) => lc(l.address) === lc(linkAddress)) : null;
  return { verdict: r.verdict, code: r.code, label: r.label, linkAddress: match?.address ?? links[0]?.address ?? null, links, notes: r.notes ?? [], changedByMemory: Boolean(r.changedByMemory), withoutMemory: r.withoutMemory?.verdict ?? null, memoryIds: r.memoryIds ?? [], memory: r.memory ?? null };
};

// ---- plain AI (Gemini), one cached call per case
async function askGemini({ model, key, prompt, file, stats, cap }) {
  if (existsSync(file)) { const c = JSON.parse(readFileSync(file, 'utf8')); stats.cached++; return c; }
  if (stats.calls >= cap) throw new Error(`Gemini call cap reached (${cap})`);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } });
  stats.calls++;
  let last = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(180000), headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body });
      const json = await res.json().catch(() => ({}));
      if ((res.status === 429 && !/per day/i.test(String(json?.error?.message))) || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) { const e = new Error(`Gemini HTTP ${res.status}: ${String(json?.error?.message ?? '').slice(0, 160)}`); e.fatal = true; throw e; }
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      const text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('');
      const out = { model, promptSha: sha(prompt), savedAt: new Date().toISOString(), text, finishReason: json.candidates?.[0]?.finishReason ?? null, usage: json.usageMetadata ?? null };
      writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
      return out;
    } catch (e) {
      if (e.fatal) throw e;
      last = e;
      await sleep(4000 * 2 ** attempt);
    }
  }
  throw new Error(`Gemini failed after 5 tries: ${String(last?.message || last).slice(0, 120)}`);
}

// ---- plain AI given the same report memory holds for the group (the report about the training member). One cached call per case.
async function askWithReport({ k, g, funderTxs, sponsorTxs, tg, model, geminiKey, templateReport, stats, cap }) {
  const report = k.trainWallet ? reportText({ trainWallet: k.trainWallet, funder: tg?.funder ?? null, sponsor: tg?.sponsor ?? null, outcome: k.trainOutcome }) : reportText({});
  const prompt = buildPrompt(templateReport, { wallet: k.wallet, walletTxs: g.page.transactions, funder: g.funder, funderTxs, sponsor: g.sponsor, sponsorTxs, report });
  // model name is part of the cache key through the folder, and the report column has its own file per case
  const file = path.join(RAW, model, `${k.set}-${k.id}-report.json`);
  const a = await askGemini({ model, key: geminiKey, prompt, file, stats, cap });
  return { ...parseAnswer(a.text), raw: path.relative(ROOT, file).replace(/\\/g, '/'), model: a.model, reportGiven: report };
}

// ---- memory training
const trainItems = async (checker, cases, log) => {
  const items = [];
  for (const k of cases.filter((c) => c.trainWallet && (c.kind === 'group' || c.split === 'train'))) {
    const g = await checker.gather(k.trainWallet);
    const groups = g.groupIds.length ? g.groupIds : [null];
    for (const group of groups) {
      items.push({ caseId: k.id, namespace: 'bench-train', kind: 'outcome', address: k.trainWallet, group, origin: 'bench-train', body: { outcome: k.trainOutcome, reporter: 'bench-train', funder: g.funder, gasSponsor: g.sponsor } });
    }
  }
  log(`training memories to store: ${items.length}`);
  return items;
};
const itemKey = (m) => `${m.namespace}|${m.address}|${m.group ?? '-'}|${m.body.outcome}`;

export async function run({ cases, memory, tatum, misses, progress, saveProgress, model, geminiKey, template, templateReport, aiCap, log = (...a) => console.error(...a), recallRetries = 3 }) {
  const skipped = [];
  const usable = [];
  const nomemChecker = createChecker({ tatum, ankr: null, memory: noMemory, mode: 'bench' });

  // 1. Pre-read every case from the cache. A case with a cache miss is skipped and listed.
  for (const k of cases) {
    misses.clear();
    try {
      const g = await nomemChecker.gather(k.wallet);
      const funderTxs = g.funder ? (await tatum.listTransactions(g.funder, { first: 50 })).transactions : [];
      const sponsorTxs = g.sponsor ? (await tatum.listTransactions(g.sponsor, { first: 50 })).transactions : [];
      const tg = k.trainWallet ? await nomemChecker.gather(k.trainWallet) : null;
      if (misses.size) throw Object.assign(new Error('CACHE_MISS'), { code: 'CACHE_MISS' });
      usable.push({ k, g, funderTxs, sponsorTxs, tg });
    } catch (e) {
      skipped.push({ id: k.id, reason: e.code === 'CACHE_MISS' ? 'no cached raw data (not fetched)' : `could not be read: ${String(e.message).slice(0, 100)}` });
      log(`skip ${k.id}: ${skipped.at(-1).reason}`);
    }
  }
  const useCases = usable.map((u) => u.k);

  // 2. Train memory (bench-train only), resumable through progress.stored.
  const mem = memory ? createChecker({ tatum, ankr: null, memory, mode: 'bench' }) : null;
  if (memory) {
    progress.stored ??= {};
    const items = (await trainItems(nomemChecker, useCases, log)).filter((m) => !progress.stored[itemKey(m)]);
    log(`not stored yet: ${items.length}`);
    for (let i = 0; i < items.length; i += BATCH) {
      const slice = items.slice(i, i + BATCH);
      for (let attempt = 1; attempt <= 5; attempt++) {
        const left = slice.filter((m) => !progress.stored[itemKey(m)]);
        if (!left.length) break;
        const out = await memory.bulkWrite(left.map(({ caseId, ...m }) => m));
        for (const e of out) {
          const item = left.find((m) => m.address === e.address && (m.group ?? null) === (e.group ?? null));
          if (e.state === 'stored' && item) progress.stored[itemKey(item)] = { blobId: e.blobId, writtenAt: e.writtenAt };
        }
        saveProgress();
        const failed = out.filter((e) => e.state === 'failed');
        log(`bulk write ${Math.min(i + BATCH, items.length)} of ${items.length}: ${out.length - failed.length} stored, ${failed.length} failed`);
        if (!failed.length) break;
        if (attempt === 5) throw new Error(`Bulk write kept failing: ${failed[0].error}`);
        await sleep(2000 * 2 ** (attempt - 1));
      }
    }
  }

  // 3. The three columns.
  const rows = [];
  const aiStats = { calls: 0, cached: 0 };
  for (const { k, g, funderTxs, sponsorTxs, tg } of usable) {
    const row = { case: k, ai: null, aiReport: null, nomem: null, mem: null };
    const nm = await nomemChecker.check(k.wallet, { memoryOn: false, deferWrite: true });
    row.nomem = slim(nm, k.linkAddress);

    if (geminiKey) {
      const prompt = buildPrompt(template, { wallet: k.wallet, walletTxs: g.page.transactions, funder: g.funder, funderTxs, sponsor: g.sponsor, sponsorTxs });
      const file = path.join(RAW, model, `${k.set}-${k.id}.json`);
      const a = await askGemini({ model, key: geminiKey, prompt, file, stats: aiStats, cap: aiCap });
      row.ai = { ...parseAnswer(a.text), raw: path.relative(ROOT, file).replace(/\\/g, '/'), model: a.model };
      if (row.ai.linkAddress == null && row.ai.verdict === 'unparsed') row.ai.note = 'answer could not be read';
      row.aiReport = await askWithReport({ k, g, funderTxs, sponsorTxs, tg, model, geminiKey, templateReport, stats: aiStats, cap: aiCap });
    }

    if (mem && k.split === 'heldout') {
      let r = null;
      for (let attempt = 1; attempt <= recallRetries; attempt++) {
        r = await mem.check(k.wallet, { memoryOn: true, deferWrite: true });
        if (!r.memory?.degraded) break;
        log(`recall problem on ${k.id} (${r.memory.recallError}), attempt ${attempt}`);
        await sleep(3000 * attempt);
      }
      row.mem = slim(r, k.linkAddress);
    }
    rows.push(row);
    log(`${k.id} ${k.kind}: AI ${row.ai?.verdict ?? '-'} | checker ${row.nomem.verdict} | with memory ${row.mem?.verdict ?? '(training case)'}`);
  }
  return { rows, skipped, aiStats };
}

export function summarize(rows) {
  const held = rows.filter((x) => x.case.split === 'heldout');
  const col = (name, set) => tally(set, name);
  const heldout = { ai: col('ai', held), aiReport: col('aiReport', held), nomem: col('nomem', held), mem: col('mem', held) };
  const all = { ai: col('ai', rows), aiReport: col('aiReport', rows), nomem: col('nomem', rows) };
  const memoryChanged = held.filter((x) => x.mem?.changedByMemory).length;
  const changedList = held.filter((x) => x.mem?.changedByMemory).map((x) => ({ id: x.case.id, from: x.mem.withoutMemory, to: x.mem.verdict }));
  const diffFromNoMem = held.filter((x) => x.mem && x.mem.verdict !== x.nomem.verdict).length;
  const recallProblems = held.filter((x) => x.mem?.memory?.degraded).map((x) => x.case.id);
  return { heldoutCases: held.length, heldout, all, memoryChanged, changedList, diffFromNoMem, recallProblems, ...lossLists(held) };
}

const pad = (s, n) => String(s).padEnd(n);
export function printTable(label, s, skipped, model) {
  const h = s.heldout;
  const cell = (c, f) => `${c[f]} of ${f.startsWith('falseAlarm') ? c.controls : c.groups}`;
  const rowsOut = [
    ['Held-out linked groups: link found', ...['ai', 'aiReport', 'nomem', 'mem'].map((k) => cell(h[k], 'linkFound'))],
    ['  answered do not pay', ...['ai', 'aiReport', 'nomem', 'mem'].map((k) => cell(h[k], 'stopped'))],
    ['  answered caution or do not pay', ...['ai', 'aiReport', 'nomem', 'mem'].map((k) => cell(h[k], 'flagged'))],
    ['Held-out controls: false alarm, strict (do not pay)', ...['ai', 'aiReport', 'nomem', 'mem'].map((k) => cell(h[k], 'falseAlarmStrict'))],
    ['  false alarm incl. caution', ...['ai', 'aiReport', 'nomem', 'mem'].map((k) => cell(h[k], 'falseAlarmIncl'))],
  ];
  console.log(`${label}\nHeld-out cases ${s.heldoutCases} (${h.mem.groups} linked groups, ${h.mem.controls} controls). Plain AI: ${model}, temperature 0, one run.`);
  console.log(`${pad('', 52)}${pad('Plain AI', 12)}${pad('AI + report', 13)}${pad('Checker', 12)}Checker + memory`);
  for (const r of rowsOut) console.log(`${pad(r[0], 52)}${pad(r[1], 12)}${pad(r[2], 13)}${pad(r[3], 12)}${r[4]}`);
  console.log(`Verdicts memory changed: ${s.memoryChanged} of ${s.heldoutCases}${s.changedList.length ? ` (${s.changedList.map((c) => `${c.id}: ${c.from} -> ${c.to}`).join(', ')})` : ''}`);
  const a = s.all;
  console.log(`All ${a.ai.groups + a.ai.controls} cases, no memory involved: AI + report link found ${a.aiReport.linkFound} of ${a.aiReport.groups}, strict false alarms ${a.aiReport.falseAlarmStrict} of ${a.aiReport.controls}, with caution ${a.aiReport.falseAlarmIncl}; AI link found ${a.ai.linkFound} of ${a.ai.groups}, strict false alarms ${a.ai.falseAlarmStrict} of ${a.ai.controls}, with caution ${a.ai.falseAlarmIncl}; checker link found ${a.nomem.linkFound} of ${a.nomem.groups}, strict ${a.nomem.falseAlarmStrict}, with caution ${a.nomem.falseAlarmIncl}`);
  console.log(`Cases where plain AI did better than the checker with memory (${s.aiBeat.length}):`);
  for (const x of s.aiBeat) console.log(`  ${x.id} ${x.kind}: AI ${x.ai}, checker ${x.ours} (${x.why})`);
  console.log(`Cases where the checker with memory did not do well (${s.weLost.length}):`);
  for (const x of s.weLost) console.log(`  ${x.id} ${x.kind}: checker ${x.ours} (${x.code}), AI ${x.ai}`);
  if (s.recallProblems.length) console.log(`Memory recall problems: ${s.recallProblems.join(', ')}`);
  if (skipped.length) console.log(`Skipped (no cached data, not fetched): ${skipped.map((x) => x.id).join(', ')}`);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => args.filter((a) => a.startsWith(`--${n}=`)).map((a) => a.slice(n.length + 3));
  const model = opt('model')[0] || process.env.GEMINI_BENCH_MODEL || 'gemini-3.1-flash-lite';
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('GEMINI_API_KEY is missing (set it in .env)');
  mkdirSync(path.join(RAW, model), { recursive: true });
  mkdirSync(RESULTS, { recursive: true });
  const template = readFileSync(path.join(BENCH, 'prompt.txt'), 'utf8');
  const templateReport = readFileSync(path.join(BENCH, 'prompt-report.txt'), 'utf8');

  const sets = [{ name: 'real', label: 'Real set: real mainnet wallets we checked', file: null }];
  for (const f of opt('cases')) sets.push({ name: path.basename(f, '.json'), file: f });
  const misses = new Set();
  const tatum = cachedOnlyTatum(misses);
  const memory = args.includes('--no-memory') ? null : createMemory({ recallLimit: 50 });
  const progress = readJson(PROGRESS, { stored: {} });
  const saveProgress = () => writeJson(PROGRESS, progress);

  for (const set of sets) {
    const spec = set.file ? readJson(path.resolve(set.file)) : { label: set.label, groups: readJson(path.join(DIR, 'groups.json')).groups, controls: readJson(path.join(DIR, 'controls.json')).controls };
    const outFile = path.join(RESULTS, `${set.name}.json`);
    const outFile2 = args.includes('--no-memory') ? path.join(RESULTS, `${set.name}.nomemory-trial.json`) : outFile;
    let out = args.includes('--rerun') ? null : readJson(outFile2);
    if (out && geminiKey && !out.cases.every((x) => x.aiReport)) {
      // Older result without the fourth column: add only that column. No memory is trained or read, no chain data is fetched.
      const cases = buildCases(spec, set.name);
      const r = await run({ cases, memory: null, tatum, misses, progress, saveProgress, model: out.model, geminiKey, template, templateReport, aiCap: cases.length });
      const by = Object.fromEntries(r.rows.map((x) => [x.case.id, x.aiReport]));
      out.cases.forEach((x) => { x.aiReport = by[x.case.id] ?? null; });
      out.summary = { ...summarize(out.cases), ...{} };
      out.aiReportCalls = r.aiStats;
      out.aiReportPrompt = 'bench/prompt-report.txt';
      writeJson(outFile2, out);
    }
    if (!out) {
      const cases = buildCases(spec, set.name);
      const r = await run({ cases, memory, tatum, misses, progress, saveProgress, model, geminiKey, template, templateReport, aiCap: cases.length * 2 });
      const s = summarize(r.rows);
      const groups = r.rows.filter((x) => x.case.kind === 'group');
      out = {
        label: spec.label ?? set.label, set: set.name, ranAt: new Date().toISOString(), model, temperature: 0, aiRuns: 1,
        aiReportPrompt: 'bench/prompt-report.txt', split: 'docs/METHOD.md, Benchmark split rule', memoryNamespace: 'bench-train', skipped: r.skipped, aiCalls: r.aiStats,
        caught: groups.filter((x) => x.nomem.links.some((l) => lc(l.address) === lc(x.case.linkAddress))).length, total: groups.length,
        summary: s, cases: r.rows.map((x) => ({ ...x, case: x.case })),
      };
      writeJson(outFile2, out);
    }
    printTable(`\n${set.name === 'real' ? 'REAL SET' : 'Stress test: synthetic wallets we built'} (${out.label})`, out.summary, out.skipped, out.model);
  }
  memory?.destroy();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => process.exit(0), (e) => { console.error(String(e.message || e)); process.exit(1); });
}
