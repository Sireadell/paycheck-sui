// PayCheck API: /api/check, /api/outcome, /api/stats, /health. Contract: docs/API.md
import express from 'express';
import { pathToFileURL } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createChecker } from './src/check.js';
import { createMemory } from './src/memory/index.js';
import { getTatum, getAnkr, callLog } from './src/providers/index.js';
import { loadConfig } from './src/config.js';

const PROBE_EVERY_MS = 30000;
const PROBE_TIMEOUT_MS = 5000;

const CHECK_LIMIT = { max: 10, windowMs: 60 * 1000 };
const OUTCOME_LIMIT = { max: 20, windowMs: 60 * 60 * 1000 };

// Per-IP counter in memory. Old entries are dropped as the window passes.
function ipLimiter({ max, windowMs }, now) {
  const hits = new Map();
  return (ip) => {
    const t = now();
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    const h = hits.get(ip) ?? { count: 0, resetAt: t + windowMs };
    h.count++;
    hits.set(ip, h);
    return h.count > max ? Math.ceil((h.resetAt - t) / 1000) : 0;
  };
}

// Constant-time token compare: both sides are hashed first so the length never leaks.
const sameToken = (given, wanted) => {
  const a = createHash('sha256').update(String(given ?? '')).digest();
  const b = createHash('sha256').update(String(wanted ?? '')).digest();
  return timingSafeEqual(a, b);
};

export function createApp({ checker, memory, probe = null, outcomeToken = process.env.OUTCOME_TOKEN, checkLimit = CHECK_LIMIT, outcomeLimit = OUTCOME_LIMIT, now = () => Date.now() } = {}) {
  const checkHit = ipLimiter(checkLimit, now);
  const outcomeHit = ipLimiter(outcomeLimit, now);
  const tooMany = (res, wait, what) => res.set('retry-after', String(wait)).status(429).json({ error: `Too many ${what} from your address. Try again in ${wait} seconds.`, retryable: true });
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.set('access-control-allow-origin', '*'); next(); });

  // /health never waits on memory: it reads a flag that a background probe keeps fresh.
  const health = { memoryReachable: null, checkedAt: null };
  const runProbe = async () => {
    try {
      await Promise.race([
        (probe ? probe() : memory.health()),
        new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), PROBE_TIMEOUT_MS)),
      ]);
      health.memoryReachable = true;
    } catch { health.memoryReachable = false; }
    health.checkedAt = new Date().toISOString();
  };
  runProbe();
  const timer = setInterval(runProbe, PROBE_EVERY_MS);
  timer.unref();
  app.locals.stop = () => clearInterval(timer);

  app.get('/health', (_req, res) => {
    const degraded = health.memoryReachable === false || checker.state.lastRecallOk === false || memory.failed().length > 0;
    res.json({ status: 'ok', degraded, memoryReachable: health.memoryReachable, pendingWrites: memory.pending().length, checkedAt: health.checkedAt });
  });

  app.get('/api/check', async (req, res) => {
    const wait = checkHit(req.ip);
    if (wait) return tooMany(res, wait, 'checks');
    try {
      const memoryOn = String(req.query.memory ?? 'on').toLowerCase() !== 'off';
      res.json(await checker.check(String(req.query.address ?? ''), { memoryOn }));
    } catch (e) {
      res.status(500).json({ verdict: 'caution', code: 'DATA_UNAVAILABLE', reason: 'The check failed. Try again shortly.', retryable: true, error: String(e.message || e).slice(0, 160) });
    }
  });

  app.post('/api/outcome', async (req, res) => {
    // No token set on the server means no one can report. A wrong or missing token gets 401.
    const bearer = /^Bearer (.+)$/i.exec(req.get('authorization') ?? '')?.[1];
    const given = req.get('x-outcome-token') ?? bearer;
    if (!outcomeToken || !given || !sameToken(given, outcomeToken)) return res.status(401).json({ error: 'A report token is required.' });
    const wait = outcomeHit(req.ip);
    if (wait) return tooMany(res, wait, 'reports');
    const { address, outcome, reporter } = req.body ?? {};
    try {
      // Waits for the write on purpose: a reporter wants to know it was saved.
      res.json(await checker.reportOutcome(String(address ?? ''), String(outcome ?? ''), { reporter: reporter ? String(reporter).slice(0, 40) : 'api' }));
    } catch (e) {
      res.status(400).json({ error: String(e.message || e).slice(0, 160) });
    }
  });

  app.get('/api/stats', (_req, res) => {
    const c = memory.counter();
    res.json({
      mode: checker.mode,
      memories: {
        live: c.stored - c.prescan,
        prescan: c.prescan,
        test: c.test,
        changedVerdicts: c.changed,
        pendingWrites: memory.pending().length,
        failedWrites: memory.failed().length,
        note: 'Counted since this server started. Test memories are never part of the live or pre-scan numbers.',
      },
      calls: { tatum: callLog.summarize(0, 'tatum'), ankr: callLog.summarize(0, 'ankr') },
    });
  });
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cfg = loadConfig();
  const memory = createMemory();
  const checker = createChecker({ tatum: getTatum(), ankr: cfg.ANKR_API_KEY ? getAnkr() : null, memory, mode: process.env.PAYCHECK_MODE === 'live' ? 'live' : 'test' });
  const port = Number(process.env.PORT) || 3000;
  const app = createApp({ checker, memory });
  app.listen(port, () => console.log(`paycheck listening on ${port}, mode ${checker.mode}`));
}
