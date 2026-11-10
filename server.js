// PayCheck API: /api/check, /api/outcome, /api/stats, /health. Contract: docs/API.md
import express from 'express';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createChecker } from './src/check.js';
import { createMemory } from './src/memory/index.js';
import { getTatum, getAnkr, callLog } from './src/providers/index.js';
import { loadConfig } from './src/config.js';
import { loadBenchmark, loadCrossAgent } from './src/api/benchmark.js';
import { loadProof, renderProof } from './src/proof.js';
import { loadFailures, renderFailures } from './src/failures.js';
import { createPaidCheck } from './src/paid.js';
import { createX402Check } from './src/x402.js';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createPayeeServer } from './mcp/server.js';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const PROBE_EVERY_MS = 30000;
const PROBE_TIMEOUT_MS = 5000;
const WARNINGS_FRESH_MS = 60 * 1000;
const WARNINGS_FIRST_WAIT_MS = 8000;

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

// Who is the visitor? Render sits behind Cloudflare, so the last forwarded address is a Cloudflare edge that can change from
// one request to the next. Cloudflare puts the real visitor in cf-connecting-ip (it always sends cf-ray too, so a bare
// cf-connecting-ip header is ignored). Otherwise the address Express works out from one trusted proxy hop is used.
export function visitorKey(req) {
  const cf = req.get('cf-connecting-ip');
  if (cf && req.get('cf-ray')) return String(cf).trim().toLowerCase().slice(0, 64);
  return req.ip;
}

// Constant-time token compare: both sides are hashed first so the length never leaks.
const sameToken = (given, wanted) => {
  const a = createHash('sha256').update(String(given ?? '')).digest();
  const b = createHash('sha256').update(String(wanted ?? '')).digest();
  return timingSafeEqual(a, b);
};

export function createApp({ checker, memory, probe = null, outcomeToken = process.env.OUTCOME_TOKEN, checkLimit = CHECK_LIMIT, outcomeLimit = OUTCOME_LIMIT, now = () => Date.now(), webDir = `${ROOT}web`, dataDir = `${ROOT}data`, paidCheck = null, x402 = null, benchDir = `${ROOT}bench`, docsDir = `${ROOT}docs` } = {}) {
  const checkHit = ipLimiter(checkLimit, now);
  const outcomeHit = ipLimiter(outcomeLimit, now);
  const tooMany = (res, wait, what) => res.set('retry-after', String(wait)).status(429).json({ error: `Too many ${what} from your address. Try again in ${wait} seconds.`, retryable: true });
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((_req, res, next) => { res.set('access-control-allow-origin', '*'); res.set('access-control-expose-headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE'); next(); });

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
    const wait = checkHit(visitorKey(req));
    if (wait) return tooMany(res, wait, 'checks');
    try {
      const memoryOn = String(req.query.memory ?? 'on').toLowerCase() !== 'off';
      const out = await checker.check(String(req.query.address ?? ''), { memoryOn });
      // A bad address is the caller's mistake: 400, with the same plain body (verdict caution, code INVALID_INPUT, inputCode).
      res.status(out.code === 'INVALID_INPUT' ? 400 : 200).json(out);
    } catch (e) {
      res.status(500).json({ verdict: 'caution', code: 'DATA_UNAVAILABLE', reason: 'The check failed. Try again shortly.', retryable: true, error: String(e.message || e).slice(0, 160) });
    }
  });

  // Pay per check in SUI. First request answers 402 with an amount and an id; the second carries the transaction digest.
  app.post('/api/paid/check', async (req, res) => {
    if (!paidCheck) return res.status(503).json({ error: 'Paid checks are not switched on for this server.' });
    const wait = checkHit(visitorKey(req));
    if (wait) return tooMany(res, wait, 'checks');
    const b = req.body ?? {};
    try {
      const out = await paidCheck.handle({ address: b.address, id: b.id, digest: b.digest, memoryOn: String(b.memory ?? 'on').toLowerCase() !== 'off' });
      res.status(out.status).json(out.body);
    } catch (e) {
      res.status(500).json({ error: 'The paid check failed. Try again shortly.', retryable: true, detail: String(e.message || e).slice(0, 160) });
    }
  });

  // Hosted agent tool (MCP over HTTP, no session kept). Any MCP client can add https://<this server>/mcp and call check_payee.
  // Each request gets its own small server, so nothing is shared between callers. Same per-visitor limit as /api/check.
  app.post('/mcp', async (req, res) => {
    const wait = checkHit(visitorKey(req));
    if (wait) return tooMany(res, wait, 'checks');
    const server = createPayeeServer({ check: (address) => checker.check(address) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'The tool server failed. Try again shortly.' }, id: null });
    }
  });
  const noStream = (_req, res) => res.set('allow', 'POST').status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST. This tool server keeps no session.' }, id: null });
  app.get('/mcp', noStream);
  app.delete('/mcp', noStream);

  // Pay per check with x402 v2 (exact, sui:mainnet, native SUI). No header: 402 with PAYMENT-REQUIRED. With PAYMENT-SIGNATURE: settle, then answer.
  app.all('/api/x402/check', async (req, res) => {
    if (!x402) return res.status(503).json({ error: 'x402 checks are not switched on for this server.' });
    if (req.method !== 'GET' && req.method !== 'POST') return res.set('allow', 'GET, POST').status(405).json({ error: 'Use GET or POST.' });
    const wait = checkHit(visitorKey(req));
    if (wait) return tooMany(res, wait, 'checks');
    const input = { ...req.query, ...(req.body ?? {}) };
    try {
      const out = await x402.handle({ address: input.address, resourceUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`, paymentHeader: req.get('payment-signature'), memoryOn: String(input.memory ?? 'on').toLowerCase() !== 'off' });
      res.set(out.headers).status(out.status).json(out.body);
    } catch (e) {
      res.status(500).json({ error: 'The x402 check failed. Try again shortly.', retryable: true, detail: String(e.message || e).slice(0, 160) });
    }
  });

  app.post('/api/outcome', async (req, res) => {
    // No token set on the server means no one can report. A wrong or missing token gets 401.
    const bearer = /^Bearer (.+)$/i.exec(req.get('authorization') ?? '')?.[1];
    const given = req.get('x-outcome-token') ?? bearer;
    if (!outcomeToken || !given || !sameToken(given, outcomeToken)) return res.status(401).json({ error: 'A report token is required.' });
    const wait = outcomeHit(visitorKey(req));
    if (wait) return tooMany(res, wait, 'reports');
    const { address, outcome, reporter } = req.body ?? {};
    try {
      // Waits for the write on purpose: a reporter wants to know it was saved.
      res.json(await checker.reportOutcome(String(address ?? ''), String(outcome ?? ''), { reporter: reporter ? String(reporter).slice(0, 40) : 'api' }));
    } catch (e) {
      res.status(400).json({ error: String(e.message || e).slice(0, 160) });
    }
  });

  app.get('/api/stats', async (_req, res) => {
    const c = memory.counter();
    let verified = null;
    try {
      const v = JSON.parse(await readFile(`${dataDir}/prescan/verified.json`, 'utf8'));
      if (Array.isArray(v.verified)) verified = { recalledAndVerified: v.verified.length, of: v.of ?? null, checkedAt: v.checkedAt ?? null, label: 'recalled and verified' };
    } catch { /* no verified file yet */ }
    res.json({
      ...(verified ? { prescanVerified: verified } : {}),
      mode: checker.mode,
      memories: {
        live: c.stored - c.prescan - (c.unlabelled ?? 0),
        prescan: c.prescan,
        unlabelled: c.unlabelled ?? 0,
        test: c.test,
        changedVerdicts: c.changed,
        pendingWrites: memory.pending().length,
        failedWrites: memory.failed().length,
        counting: memory.hydration ? memory.hydration() : null,
        note: 'Live and pre-scan memories are counted from Walrus after every start (the server answers first and the numbers fill in when Walrus replies). Walrus lists every note, and the label of each note (pre-scan or not) is read with repeated searches. "Unlabelled" is the number of listed notes whose label has not been read, so live + pre-scan + unlabelled is the total listed. "Changed an answer" counts memories named in saved verdict notes that record it, so answers from before that note existed are not counted. Test memories are counted since this server started and are never part of the live or pre-scan numbers.',
      },
      paidChecks: { enabled: Boolean(paidCheck), settled: paidCheck ? await paidCheck.count() : 0, route: 'plain SUI on Sui mainnet', note: paidCheck ? 'Paid checks are switched on.' : 'Paid checks are switched off on this server: no receiving address is set, so POST /api/paid/check answers 503.' },
      x402: { enabled: Boolean(x402), settled: x402 ? await x402.count() : 0, scheme: 'exact', network: 'sui:mainnet', asset: '0x2::sui::SUI', version: 2 },
      calls: { tatum: callLog.summarize(0, 'tatum'), ankr: callLog.summarize(0, 'ankr') },
    });
  });

  // The last shared warnings, read only. Kept for a minute so the page never makes Walrus wait on every visitor; a slow or failed
  // read leaves the last good list in place and says so.
  const warnings = { at: null, list: [], state: 'loading', loading: null };
  const refreshWarnings = () => {
    if (!memory.recentOutcomes) { warnings.state = 'unavailable'; return null; }
    if (!warnings.loading) {
      warnings.loading = Promise.resolve().then(() => memory.recentOutcomes({ limit: 5 })).then((l) => { warnings.list = l; warnings.state = 'ok'; warnings.at = now(); }, () => { warnings.state = warnings.at !== null ? 'stale' : 'unavailable'; }).finally(() => { warnings.loading = null; });
    }
    return warnings.loading;
  };
  app.locals.warmWarnings = () => { refreshWarnings(); };
  app.get('/api/warnings', async (_req, res) => {
    if (warnings.at === null || now() - warnings.at > WARNINGS_FRESH_MS) {
      const p = refreshWarnings();
      // The first ever read gets a short wait so the page can fill in; after that the last list is answered at once.
      if (p && warnings.at === null) await Promise.race([p, new Promise((r) => setTimeout(r, WARNINGS_FIRST_WAIT_MS))]);
    }
    res.json({ warnings: warnings.list, state: warnings.state, updatedAt: warnings.at !== null ? new Date(warnings.at).toISOString() : null, source: 'bad-outcome reports in the shared-outcomes space on Walrus Memory', limit: 5 });
  });

  app.get('/api/benchmark', async (_req, res) => res.json(await loadBenchmark({ dataDir, benchDir })));
  app.get('/api/cross-agent', async (_req, res) => {
    const run = await loadCrossAgent(dataDir);
    return run ? res.json(run) : res.status(404).json({ available: false });
  });
  // The proof page: server-rendered from the saved result files, so it works without scripts.
  app.get('/proof', async (_req, res) => {
    try {
      const copy = JSON.parse(await readFile(`${webDir}/copy.json`, 'utf8'));
      const proof = await loadProof({ dataDir, benchDir });
      res.type('html').send(renderProof(proof, copy, { base: `${_req.protocol}://${_req.get('host')}` }).replace('<body>', '<body class="proof-page">'));
    } catch { res.status(500).type('text').send('The proof page could not be built.'); }
  });
  app.get('/api/proof', async (_req, res) => res.json(await loadProof({ dataDir, benchDir })));
  // Every miss, false alarm and failed recall, recounted from the saved rows like the proof page.
  app.get('/failures', async (_req, res) => {
    try {
      const copy = JSON.parse(await readFile(`${webDir}/copy.json`, 'utf8'));
      res.type('html').send(renderFailures(await loadFailures({ dataDir, benchDir }), copy));
    } catch { res.status(500).type('text').send('The failures page could not be built.'); }
  });
  app.get('/api/failures', async (_req, res) => res.json(await loadFailures({ dataDir, benchDir })));
  // Plain-text copies of the method notes for the links on the proof page.
  app.get('/docs/:name', async (req, res) => {
    if (!['METHOD.md', 'VERDICT_RULES.md', 'REPRODUCE.md'].includes(req.params.name)) return res.status(404).type('text').send('Not found');
    try { res.type('text/plain; charset=utf-8').send(await readFile(`${docsDir}/${req.params.name}`, 'utf8')); } catch { res.status(404).type('text').send('Not found'); }
  });
  app.use(express.static(webDir));
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cfg = loadConfig();
  const memory = createMemory();
  const checker = createChecker({ tatum: getTatum(), ankr: cfg.ANKR_API_KEY ? getAnkr() : null, memory, mode: process.env.PAYCHECK_MODE === 'live' ? 'live' : 'test', chainFacts: true });
  const port = Number(process.env.PORT) || 3000;
  const payee = process.env.PAID_CHECK_PAYEE || cfg.SUI_ADDRESS;
  const paidCheck = payee ? createPaidCheck({ tatum: getTatum(), checker, payee, usedFile: `${ROOT}data/paid-check/used.json` }) : null;
  const x402 = payee ? createX402Check({ rpc: new SuiJsonRpcClient({ url: process.env.SUI_RPC_URL || (cfg.ANKR_API_KEY ? 'https://rpc.ankr.com/sui/' + cfg.ANKR_API_KEY : 'https://fullnode.mainnet.sui.io:443'), network: 'mainnet' }), checker, payee, usedFile: `${ROOT}data/x402/used.json` }) : null;
  const app = createApp({ checker, memory, paidCheck, x402 });
  // Read the counters back from Walrus without holding up the server. A slow or failed read only leaves the numbers lower for now.
  memory.hydrate?.().catch(() => {});
  app.locals.warmWarnings();
  app.listen(port, () => console.log(`paycheck listening on ${port}, mode ${checker.mode}`));
}
