// Pre-scan of real Sui wallets (pick rule: docs/METHOD.md). Resumable.
// Usage: node --env-file=.env scripts/prescan.js --count=20 [--tatum-cap=60000] [--dir=data/prescan]
// Files: <dir>/progress.json (pick list, checkpoint position, stored ids), <dir>/verdicts.jsonl (one raw verdict per wallet).
// Writes only pre-scan memories to the live namespace, 20 per bulk call. Stops and reports on a rate limit or quota message.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BATCH, extendPicks, tally, isRateOrQuota, withBackoff } from '../src/prescan.js';

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export class StopRun extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function saveProgress(file, p) {
  writeFileSync(`${file}.tmp`, JSON.stringify(p, null, 2));
  renameSync(`${file}.tmp`, file);
}

export async function runPrescan({ count, dir, tatum, checker, memory, tatumCap = 60000, floor, sleep = sleepDefault, backoffMs = 2000, log = console.log, callLog, recallWaitMs = 5000 }) {
  mkdirSync(dir, { recursive: true });
  const progressFile = join(dir, 'progress.json');
  const verdictsFile = join(dir, 'verdicts.jsonl');
  const p = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, 'utf8')) : { startCheckpoint: await tatum.latestCheckpoint(), picks: [], stored: {}, startedAt: new Date().toISOString() };
  p.currentCheckpoint ??= p.startCheckpoint;
  p.stored ??= {};
  const save = () => saveProgress(progressFile, p);
  const tatumCalls = () => callLog.summarize(0, 'tatum').calls;
  const retryOpts = { sleep, baseMs: backoffMs, onRetry: (n, e) => log(`network error, retry ${n} of 5: ${String(e.message).slice(0, 120)}`) };

  let stopped = null;
  try {
    // 1. The pick list (a prefix of any longer list).
    await withBackoff(() => extendPicks(p, count, { checkpointTransactions: (cp) => tatum.checkpointTransactions(cp), floor }), retryOpts);
    save();
    const picks = p.picks.slice(0, count);
    log(`pick list ${picks.length}, start checkpoint ${p.startCheckpoint}, now at ${p.currentCheckpoint}`);

    // 2. Check every pick not yet in verdicts.jsonl, 20 at a time, then write the 20 memories in one bulk call.
    const done = new Map(readJsonl(verdictsFile).map((r) => [r.address, r]));
    const todo = picks.filter((a) => !done.has(a));

    const checkOne = async (address) => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        if (tatumCalls() >= tatumCap) throw new StopRun('cap', `Tatum call cap reached (${tatumCalls()} of ${tatumCap}, the 60% line of the lower credit figure)`);
        const r = await checker.check(address, { deferWrite: true, originOverride: 'prescan', extraBody: { prescan: true } });
        const problem = r.code === 'DATA_UNAVAILABLE' ? ((r.notes ?? []).join(' ') || 'no data') : (r.memory?.degraded ? `memory recall problem: ${r.memory.recallError}` : null);
        if (!problem) return r;
        if (isRateOrQuota(problem)) throw new StopRun('limit', `Provider limit message: ${problem}`);
        log(`check of ${address.slice(0, 12)} not clean (${problem.slice(0, 100)}), attempt ${attempt} of 5`);
        if (attempt === 5) throw new StopRun('network', `Check kept failing: ${problem}`);
        await sleep(backoffMs * 2 ** (attempt - 1));
      }
    };

    const writeBatch = async (rows) => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const left = rows.filter((r) => !p.stored[r.address]);
        if (!left.length) return;
        const out = await memory.bulkWrite(left.map((r) => r.memoryItem));
        for (const e of out) if (e.state === 'stored') p.stored[e.address] = { blobId: e.blobId, id: e.id, writtenAt: e.writtenAt };
        // bulkWrite skips text it already stored in this process (not returned): count those as stored too.
        for (const r of left) if (!p.stored[r.address] && !out.some((e) => e.address === r.address)) p.stored[r.address] = { blobId: null, note: 'stored earlier in this run' };
        save();
        const failed = out.filter((e) => e.state === 'failed');
        if (!failed.length) return;
        const msg = failed.map((f) => f.error).join(' | ');
        if (isRateOrQuota(msg)) throw new StopRun('limit', `Walrus limit message: ${msg.slice(0, 300)}`);
        log(`bulk write: ${failed.length} of ${out.length} failed (${msg.slice(0, 160)}), attempt ${attempt} of 5`);
        if (attempt === 5) throw new StopRun('network', `Bulk write kept failing: ${msg.slice(0, 300)}`);
        await sleep(backoffMs * 2 ** (attempt - 1));
      }
    };

    // Left over from an interrupted run: checked but not stored yet.
    const leftover = [...done.values()].filter((r) => r.memoryItem && !p.stored[r.address] && picks.includes(r.address));
    for (let i = 0; i < leftover.length; i += BATCH) await writeBatch(leftover.slice(i, i + BATCH));

    for (let i = 0; i < todo.length; i += BATCH) {
      const rows = [];
      for (const address of todo.slice(i, i + BATCH)) {
        const r = await checkOne(address);
        const body = r.memoryItem?.body ?? {};
        const row = { address, verdict: r.verdict, code: r.code, label: r.label, walletHub: r.walletHub, reason: r.reason, funder: body.funder ?? null, gasSponsor: body.gasSponsor ?? null, links: body.links ?? 0, tatumCalls: r.callLog?.tatum?.calls ?? 0, checkedAt: new Date().toISOString(), memoryItem: r.memoryItem ?? null };
        appendFileSync(verdictsFile, `${JSON.stringify(row)}\n`);
        done.set(address, row);
        rows.push(row);
      }
      log(`checked ${done.size} of ${picks.length}, tatum calls ${tatumCalls()}, writing ${rows.length} memories`);
      await writeBatch(rows.filter((r) => r.memoryItem));
    }
  } catch (e) {
    if (e instanceof StopRun) stopped = { kind: e.kind, message: e.message };
    else {
      const msg = String(e?.message || e);
      stopped = { kind: isRateOrQuota(msg) ? 'limit' : 'error', message: msg };
    }
  }
  save();

  // 3. Counts, and the exact recall of every stored wallet from the live namespace.
  const picks = p.picks.slice(0, count);
  const rows = readJsonl(verdictsFile).filter((r) => picks.includes(r.address));
  const stored = picks.filter((a) => p.stored[a]);
  let recalled = 0;
  let missing = [];
  if (stored.length) {
    await sleep(recallWaitMs);
    const ask = async (a) => {
      try { return (await memory.recall({ namespace: 'live', address: a })).some((m) => m.origin === 'prescan' && m.kind === 'verdict'); } catch { return false; }
    };
    let queue = stored;
    for (let pass = 0; pass < 2 && queue.length; pass++) {
      const next = [];
      for (let i = 0; i < queue.length; i += 4) {
        const res = await Promise.all(queue.slice(i, i + 4).map(ask));
        res.forEach((ok, j) => { if (ok) recalled++; else next.push(queue[i + j]); });
      }
      queue = next;
      if (queue.length && pass === 0) await sleep(recallWaitMs * 2);
    }
    missing = queue;
  }
  return { progress: p, rows, stored: stored.length, recalled, missing, counts: tally(rows), tatumCalls: tatumCalls(), stopped };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { createChecker } = await import('../src/check.js');
  const { createMemory } = await import('../src/memory/index.js');
  const { getTatum, getAnkr, callLog, FLOOR_CHECKPOINT } = await import('../src/providers/index.js');
  const { loadConfig } = await import('../src/config.js');
  const { createApp } = await import('../server.js');
  const arg = (n, d) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
  const count = Math.min(Number(arg('count', 20)), 200);
  const cfg = loadConfig();
  const memory = createMemory();
  const tatum = getTatum();
  const checker = createChecker({ tatum, ankr: cfg.ANKR_API_KEY ? getAnkr() : null, memory, mode: 'live' });
  const out = await runPrescan({ count, dir: arg('dir', 'data/prescan'), tatum, checker, memory, tatumCap: Number(arg('tatum-cap', 60000)), floor: FLOOR_CHECKPOINT, callLog });

  // /api/stats from a real server that holds this run's memory ledger.
  const app = createApp({ checker, memory });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const stats = await (await fetch(`http://127.0.0.1:${server.address().port}/api/stats`)).json();
  app.locals.stop(); server.close(); server.closeAllConnections?.();

  console.log(`scanned ${out.rows.length}, stored ${out.stored} (origin=prescan), recalled ${out.recalled} of ${out.stored}`);
  if (out.missing.length) console.log(`not recalled: ${out.missing.join(', ')}`);
  console.log('by verdict', JSON.stringify(out.counts.byVerdict));
  console.log('by kind', JSON.stringify(out.counts.byKind));
  console.log('api/stats memories', JSON.stringify(stats.memories));
  console.log(`tatum calls ${out.tatumCalls}`);
  if (out.stopped) console.log(`STOPPED (${out.stopped.kind}): ${out.stopped.message}`);
  memory.destroy();
  process.exit(out.stopped ? 2 : out.recalled === out.stored && out.stored === out.rows.length ? 0 : 1);
}
