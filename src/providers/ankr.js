// Ankr Sui JSON-RPC client. Cross-check only: it re-asks what Tatum was asked and returns the same shapes.
import { createLimiter } from './rateLimit.js';
import { record } from './callLog.js';
import { SUI_COIN } from './tatum.js';
import { padAddress } from '../address.js';

export const ENDPOINT_BASE = 'https://rpc.ankr.com/sui/';
// Recorded depth note (7 Nov 2026): Ankr serves checkpoints back to 1 (13 Apr 2023), but its address
// history index can be shallower than that. An empty listing is never proof that an address was idle.
export const DEPTH_NOTE = 'Ankr checkpoint data reaches back to April 2023, but its address history can start later; an empty Ankr result may mean no data, not no activity.';

const OPTIONS = { showInput: true, showEffects: true, showBalanceChanges: true };
const ankrLimiter = createLimiter({ perSecond: 5 });

export function createAnkr({ key, fetchImpl = fetch, limiter = ankrLimiter, timeoutMs = 15000 } = {}) {
  if (!key) throw new Error('Missing ANKR_API_KEY');
  const url = ENDPOINT_BASE + key;

  async function rpc(type, method, params) {
    const started = Date.now();
    let ok = false;
    try {
      await limiter();
      const res = await fetchImpl(url, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) throw new Error(`Ankr HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`Ankr RPC: ${json.error.message}`);
      ok = true;
      return json.result;
    } finally {
      record('ankr', type, Date.now() - started, ok);
    }
  }

  const addr = (a) => {
    const p = padAddress(a);
    if (!p) throw new Error('Not a Sui address');
    return p;
  };

  return {
    // Newest transaction's checkpoint (Ankr has no latest-checkpoint method).
    async latestCheckpoint() {
      const r = await rpc('latestCheckpoint', 'suix_queryTransactionBlocks', [{ options: {} }, null, 1, true]);
      return r.data.length ? Number(r.data[0].checkpoint) : null;
    },
    async balance(address) {
      const r = await rpc('balance', 'suix_getBalance', [addr(address), '0x2::sui::SUI']);
      return r?.totalBalance ?? '0';
    },
    async transactionByDigest(digest) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(digest || '')) throw new Error('Not a transaction digest');
      try {
        return normalize(await rpc('transactionByDigest', 'sui_getTransactionBlock', [digest, OPTIONS]));
      } catch (e) {
        if (/not found|could not find/i.test(e.message)) return null;
        throw e;
      }
    },
    // Oldest first, sent and received merged. Same return shape as the Tatum listing.
    // reachedDepthLimit is true when nothing came back, which can mean Ankr's history is shallower than the question.
    async listTransactions(address, { first = 50, cursor = null } = {}) {
      const a = addr(address);
      const cur = cursor ? JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8')) : {};
      const limit = Math.min(Math.max(first, 1), 50);
      const empty = { data: [], hasNextPage: false, nextCursor: null };
      const q = (filter, c) => rpc('listTransactions', 'suix_queryTransactionBlocks', [{ filter, options: OPTIONS }, c ?? null, limit, false]);
      const [to, from] = await Promise.all([
        cur.to === null ? empty : q({ ToAddress: a }, cur.to),
        cur.from === null ? empty : q({ FromAddress: a }, cur.from),
      ]);
      const seen = new Map();
      for (const t of [...to.data, ...from.data]) if (!seen.has(t.digest)) seen.set(t.digest, normalize(t));
      const nodes = [...seen.values()].sort((x, y) => x.checkpoint - y.checkpoint).slice(0, limit);
      const hasNextPage = Boolean(to.hasNextPage || from.hasNextPage);
      const next = { to: to.hasNextPage ? to.nextCursor : null, from: from.hasNextPage ? from.nextCursor : null };
      return {
        transactions: nodes,
        hasNextPage,
        cursor: hasNextPage ? Buffer.from(JSON.stringify(next)).toString('base64') : null,
        oldestCheckpoint: nodes.length ? Math.min(...nodes.map((t) => t.checkpoint)) : null,
        reachedDepthLimit: nodes.length === 0,
        depthNote: nodes.length === 0 ? DEPTH_NOTE : null,
      };
    },
  };
}

export function normalize(t) {
  const data = t.transaction?.data;
  const sender = data?.sender?.toLowerCase() ?? null;
  const owner = data?.gasData?.owner?.toLowerCase();
  const status = t.effects?.status?.status;
  return {
    digest: t.digest,
    sender,
    gasSponsor: owner ?? sender,
    sponsored: Boolean(owner) && owner !== sender,
    status: status ? status.toUpperCase() : null,
    timestamp: t.timestampMs ? new Date(Number(t.timestampMs)).toISOString() : null,
    checkpoint: t.checkpoint != null ? Number(t.checkpoint) : null,
    balanceChanges: (t.balanceChanges || []).map((b) => ({
      amount: b.amount, coin: normCoin(b.coinType), owner: b.owner?.AddressOwner?.toLowerCase() ?? null,
    })),
  };
}

// Ankr writes "0x2::sui::SUI"; Tatum writes the full 64-digit form. Use one spelling for SUI.
function normCoin(c) {
  return c === '0x2::sui::SUI' ? SUI_COIN : c;
}
