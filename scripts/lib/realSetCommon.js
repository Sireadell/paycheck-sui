// Shared helpers for the real set scripts: paths, a caching fetch with backoff, provider clients, history reading.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createTatum, FLOOR_CHECKPOINT, ENDPOINT } from '../../src/providers/tatum.js';
import { createAnkr } from '../../src/providers/ankr.js';
import { createLimiter } from '../../src/providers/rateLimit.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIR = path.join(ROOT, 'data', 'real-set');
export const CACHE = path.join(DIR, 'raw', 'cache');
export const PROOF = path.join(DIR, 'raw', 'proof');
export { FLOOR_CHECKPOINT, ENDPOINT };

// The fixed pick rule constants (also written in docs/METHOD.md).
export const RULE = { startCheckpoint: 342_700_000, step: 600, maxSamples: 60000, takePerCheckpoint: 50, block: 12, pages: 4, sponsorPages: 30, maxFunderRecipients: 12, maxMembers: 6, windowMs: 24 * 3600_000, groupTarget: 20, perTypeCap: 12, controlTarget: 20 };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const explorerTx = (d) => `https://suiscan.xyz/mainnet/tx/${d}`;
export const explorerAddr = (a) => `https://suiscan.xyz/mainnet/account/${a}`;
export const readJson = (p, fallback = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
export const writeJson = (p, v) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };

const tatumLimiter = createLimiter({ perSecond: 2.5 });
const ankrLimiter = createLimiter({ perSecond: 4 });
export const netStats = { network: 0, cached: 0 };

// Caches the answer body on disk by hash of the request. Network errors and 429 are retried with backoff, up to 5 times, then it throws.
function cachedFetch(kind, url, limiter) {
  mkdirSync(CACHE, { recursive: true });
  return async (_ignored, init) => {
    const key = createHash('sha256').update(kind + init.body).digest('hex').slice(0, 40);
    const file = path.join(CACHE, `${key}.json`);
    if (existsSync(file)) { netStats.cached++; const c = JSON.parse(readFileSync(file, 'utf8')); return new Response(JSON.stringify(c.json), { status: 200 }); }
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      await limiter();
      try {
        netStats.network++;
        const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(25000), headers: init.headers, body: init.body });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (res.ok && !json.errors && !json.error) {
          writeFileSync(file, JSON.stringify({ kind, body: init.body, json }));
        }
        return new Response(JSON.stringify(json), { status: res.status });
      } catch (e) {
        lastErr = e;
        await sleep(1000 * 2 ** attempt);
      }
    }
    const err = new Error(`network failed after 5 tries: ${String(lastErr?.message || lastErr).slice(0, 100)}`);
    err.code = 'NETWORK_GIVE_UP';
    throw err;
  };
}

export function makeClients({ withAnkr = true } = {}) {
  const tatumKey = process.env.TATUM_API_KEY_MAINNET;
  if (!tatumKey) throw new Error('Missing TATUM_API_KEY_MAINNET');
  const noLimit = async () => {};
  const tatum = createTatum({ key: tatumKey, fetchImpl: cachedFetch('tatum', ENDPOINT, tatumLimiter), limiter: noLimit, retryWaitMs: 1 });
  let ankr = null;
  let ankrRpc = null;
  if (withAnkr && process.env.ANKR_API_KEY) {
    const url = 'https://rpc.ankr.com/sui/' + process.env.ANKR_API_KEY;
    ankr = createAnkr({ key: process.env.ANKR_API_KEY, fetchImpl: cachedFetch('ankr', url, ankrLimiter), limiter: noLimit });
    ankrRpc = async (method, params) => {
      const res = await cachedFetch('ankr', url, ankrLimiter)(url, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return res.json();
    };
  }
  const post = async (query) => {
    const res = await cachedFetch('tatum', ENDPOINT, tatumLimiter)(ENDPOINT, { headers: { 'content-type': 'application/json', 'x-api-key': tatumKey }, body: JSON.stringify({ query }) });
    const json = await res.json();
    if (json.errors?.length) throw new Error(`Tatum GraphQL: ${json.errors[0].message}`);
    return json.data;
  };
  return { tatum, ankr, ankrRpc, post };
}

// Oldest first, up to `pages` pages of 50. complete is true when the whole history from the data floor was read.
export async function listFull(tatum, address, pages = RULE.pages) {
  const txs = [];
  let cursor = null;
  let more = false;
  for (let i = 0; i < pages; i++) {
    const r = await tatum.listTransactions(address, { first: 50, cursor });
    txs.push(...r.transactions);
    more = r.hasNextPage;
    if (!more) break;
    cursor = r.cursor;
  }
  return { txs, complete: !more };
}

export const isSuiCoin = (b) => typeof b.coin === 'string' && b.coin.endsWith('::sui::SUI');
export const tsMs = (t) => Date.parse(t.timestamp ?? '');

/** SUI payouts of a wallet: one row per recipient per successful transaction it sent. */
export function payouts(addr, txs) {
  const out = [];
  for (const t of txs) {
    if (t.status !== 'SUCCESS' || t.sender !== addr) continue;
    for (const b of t.balanceChanges) {
      if (isSuiCoin(b) && b.owner && b.owner !== addr && BigInt(b.amount) > 0n) out.push({ recipient: b.owner, digest: t.digest, timestampMs: tsMs(t), timestamp: t.timestamp, checkpoint: t.checkpoint });
    }
  }
  return out;
}

/** SUI received by `addr` from someone else, in a successful transaction. */
export function incoming(addr, txs) {
  const out = [];
  for (const t of txs) {
    if (t.status !== 'SUCCESS' || t.sender === addr) continue;
    const gain = t.balanceChanges.filter((b) => isSuiCoin(b) && b.owner === addr && BigInt(b.amount) > 0n).reduce((s, b) => s + BigInt(b.amount), 0n);
    if (gain > 0n) out.push({ digest: t.digest, sender: t.sender, timestampMs: tsMs(t), timestamp: t.timestamp, checkpoint: t.checkpoint, amount: gain.toString() });
  }
  return out.sort((a, b) => a.timestampMs - b.timestampMs);
}

export const TX_FIELDS = `digest sender{address} gasInput{gasSponsor{address}}
  effects{ status timestamp checkpoint{sequenceNumber}
    balanceChanges(first:50){ nodes{ amount coinType{repr} owner{address} } } }`;

/** Same shape as the Tatum client's listing rows (sampled checkpoint rows come from the same fields). */
export function normalizeTx(t) {
  const sender = t.sender?.address?.toLowerCase() ?? null;
  return {
    digest: t.digest,
    sender,
    gasSponsor: t.gasInput?.gasSponsor?.address?.toLowerCase() ?? sender,
    sponsored: Boolean(t.gasInput?.gasSponsor?.address) && t.gasInput.gasSponsor.address.toLowerCase() !== sender,
    status: t.effects?.status ?? null,
    timestamp: t.effects?.timestamp ?? null,
    checkpoint: t.effects?.checkpoint?.sequenceNumber ?? null,
    balanceChanges: (t.effects?.balanceChanges?.nodes || []).map((b) => ({ amount: b.amount, coin: b.coinType?.repr, owner: b.owner?.address?.toLowerCase() ?? null })),
  };
}
