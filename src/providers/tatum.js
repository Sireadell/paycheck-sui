// Tatum Sui GraphQL client. Every read for the checker goes through here.
import { sharedLimiter } from './rateLimit.js';
import { record } from './callLog.js';
import { padAddress } from '../address.js';

export const RATE_ENDPOINT = 'https://api.tatum.io/v4/data/rate/symbol';
export const ENDPOINT = 'https://sui-mainnet.gateway.tatum.io/graphql';
// About 23 Jan 2026. Listings must always carry afterCheckpoint, and nothing older is served.
export const FLOOR_CHECKPOINT = 237661232;
export const SUI_COIN = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

const TX_FIELDS = `digest sender{address} gasInput{gasSponsor{address}}
  effects{ status timestamp checkpoint{sequenceNumber}
    balanceChanges(first:50){ nodes{ amount coinType{repr} owner{address} } } }`;

const MAX_RETRIES = 2;
const isTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

export function createTatum({ key, fetchImpl = fetch, limiter = sharedLimiter, endpoint = ENDPOINT, retryWaitMs = 1000, timeoutMs = 15000 } = {}) {
  if (!key) throw new Error('Missing TATUM_API_KEY_MAINNET');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function gql(type, query) {
    const started = Date.now();
    let ok = false;
    try {
      // Up to 2 retries, only for a 429 or a timeout.
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await limiter();
        let res;
        try {
          res = await fetchImpl(endpoint, {
            method: 'POST',
            signal: AbortSignal.timeout(timeoutMs),
            headers: { 'content-type': 'application/json', 'x-api-key': key },
            body: JSON.stringify({ query }),
          });
        } catch (e) {
          if (isTimeout(e)) {
            if (attempt < MAX_RETRIES) { await sleep(retryWaitMs); continue; }
            throw new Error(`Tatum timed out after ${timeoutMs} ms`);
          }
          throw e;
        }
        if (res.status === 429) {
          if (attempt < MAX_RETRIES) { await sleep(retryWaitMs); continue; }
          throw new Error('Tatum HTTP 429');
        }
        if (!res.ok) throw new Error(`Tatum HTTP ${res.status}`);
        const json = await res.json();
        if (json.errors?.length) throw new Error(`Tatum GraphQL: ${json.errors[0].message}`);
        ok = true;
        return json.data;
      }
      throw new Error('Tatum HTTP 429');
    } finally {
      record('tatum', type, Date.now() - started, ok);
    }
  }

  // Tatum's exchange rate (price in a fiat currency). Not part of the Sui GraphQL door, so it has its own tiny read.
  async function rateRead(symbol, basePair) {
    const started = Date.now();
    let ok = false;
    try {
      await limiter();
      const res = await fetchImpl(`${RATE_ENDPOINT}?symbol=${encodeURIComponent(symbol)}&basePair=${encodeURIComponent(basePair)}`, { signal: AbortSignal.timeout(timeoutMs), headers: { 'x-api-key': key } });
      if (!res.ok) throw new Error(`Tatum HTTP ${res.status}`);
      const j = await res.json();
      const value = Number(j?.value);
      if (!Number.isFinite(value) || value <= 0) throw new Error('Tatum rate has an unexpected shape');
      ok = true;
      return { value, basePair: j.basePair ?? basePair, source: j.source ?? null, timestamp: j.timestamp ?? null };
    } finally {
      record('tatum', 'exchangeRate', Date.now() - started, ok);
    }
  }

  const addr = (a) => {
    const p = padAddress(a);
    if (!p) throw new Error('Not a Sui address');
    return p;
  };

  return {
    exchangeRate: (symbol = 'SUI', basePair = 'USD') => rateRead(symbol, basePair),
    async latestCheckpoint() {
      const d = await gql('latestCheckpoint', '{ checkpoint { sequenceNumber } }');
      return d.checkpoint.sequenceNumber;
    },
    // The first 50 transactions of one checkpoint, in the order Tatum lists them. Used by the pre-scan pick rule.
    async checkpointTransactions(sequenceNumber) {
      const n = Number(sequenceNumber);
      if (!Number.isInteger(n) || n < FLOOR_CHECKPOINT) throw new Error('Checkpoint is below the data floor');
      const d = await gql('checkpointTransactions', `{ checkpoint(sequenceNumber:${n}) { sequenceNumber transactions(first:50) { nodes { digest sender{address} effects{status} } } } }`);
      if (!d.checkpoint) return null;
      return d.checkpoint.transactions.nodes.map((t) => ({ digest: t.digest, sender: t.sender?.address?.toLowerCase() ?? null, status: t.effects?.status ?? null }));
    },
    async referenceGasPrice() {
      const d = await gql('referenceGasPrice', '{ epoch { referenceGasPrice } }');
      return Number(d.epoch.referenceGasPrice);
    },
    async balance(address) {
      const d = await gql('balance', `{ address(address:"${addr(address)}") { balance(coinType:"0x2::sui::SUI") { totalBalance } } }`);
      return d.address?.balance?.totalBalance ?? '0';
    },
    // What this address is on chain, in one call: its SUI balance and whether it is really an object or a package (not a wallet).
    // Returns null when the answer has an unexpected shape, so a caller never reads "unknown" as "nothing there".
    async addressProfile(address) {
      const d = await gql('addressProfile', `{ address(address:"${addr(address)}") { balance(coinType:"0x2::sui::SUI") { totalBalance } asObject { version asMovePackage { address } } } }`);
      if (!d?.address) return null;
      const obj = d.address.asObject;
      return { balance: String(d.address.balance?.totalBalance ?? '0'), isObject: Boolean(obj), isPackage: Boolean(obj?.asMovePackage) };
    },
    // What a wallet holds, in one call: every coin type with its balance, how many objects it owns and of which kinds, and its
    // SuiNS name if it has one. Evidence only. Returns null when the answer has an unexpected shape.
    async walletSnapshot(address) {
      const d = await gql('walletSnapshot', `{ address(address:"${addr(address)}") { balances(first:20){ pageInfo{hasNextPage} nodes{ coinType{repr} totalBalance coinMetadata{symbol decimals} } } objects(first:50){ pageInfo{hasNextPage} nodes{ contents{ type{repr} } } } defaultNameRecord{ domain } } }`);
      return d?.address ? normalizeSnapshot(d.address) : null;
    },
    async transactionByDigest(digest) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(digest || '')) throw new Error('Not a transaction digest');
      const d = await gql('transactionByDigest', `{ transaction(digest:"${digest}") { ${TX_FIELDS} } }`);
      return d.transaction ? normalize(d.transaction) : null;
    },
    // Oldest first. Always filtered by afterCheckpoint. reachedFloor is true when the listing ends at our data floor.
    async listTransactions(address, { first = 50, cursor = null, afterCheckpoint = FLOOR_CHECKPOINT } = {}) {
      const after = cursor ? `, after:"${String(cursor).replace(/[^A-Za-z0-9+/=_-]/g, '')}"` : '';
      const d = await gql('listTransactions', `{ transactions(first:${Math.min(Math.max(first, 1), 50)}${after}, filter:{ affectedAddress:"${addr(address)}", afterCheckpoint:${afterCheckpoint} }) { pageInfo{ hasNextPage endCursor } nodes{ ${TX_FIELDS} } } }`);
      const nodes = d.transactions.nodes.map(normalize);
      return {
        transactions: nodes,
        hasNextPage: d.transactions.pageInfo.hasNextPage,
        cursor: d.transactions.pageInfo.endCursor,
        oldestCheckpoint: nodes.length ? Math.min(...nodes.map((t) => t.checkpoint)) : null,
        afterCheckpoint,
      };
    },
  };
}

/** Coins held, objects owned (coin objects apart from everything else) and the SuiNS name. Pure. */
export function normalizeSnapshot(a) {
  const coins = (a.balances?.nodes || []).map((b) => ({
    coinType: b.coinType?.repr ?? null,
    symbol: b.coinMetadata?.symbol ?? null,
    decimals: b.coinMetadata?.decimals ?? null,
    balance: String(b.totalBalance ?? '0'),
  }));
  const objs = (a.objects?.nodes || []).map((o) => o.contents?.type?.repr ?? '');
  const isCoinObj = (r) => /::coin::Coin</.test(r);
  const other = objs.filter((r) => r && !isCoinObj(r));
  const kinds = [...new Set(other.map((r) => (r.split('::').slice(-1)[0] || r).replace(/<.*$/, '')))].slice(0, 5);
  return {
    coins,
    coinTypes: coins.length,
    coinsMore: Boolean(a.balances?.pageInfo?.hasNextPage),
    objects: objs.length,
    objectsMore: Boolean(a.objects?.pageInfo?.hasNextPage),
    otherObjects: other.length,
    otherKinds: kinds,
    name: a.defaultNameRecord?.domain ?? null,
  };
}

function normalize(t) {
  const sender = t.sender?.address?.toLowerCase() ?? null;
  return {
    digest: t.digest,
    sender,
    gasSponsor: t.gasInput?.gasSponsor?.address?.toLowerCase() ?? sender,
    sponsored: Boolean(t.gasInput?.gasSponsor?.address) && t.gasInput.gasSponsor.address.toLowerCase() !== sender,
    status: t.effects?.status ?? null,
    timestamp: t.effects?.timestamp ?? null,
    checkpoint: t.effects?.checkpoint?.sequenceNumber ?? null,
    balanceChanges: (t.effects?.balanceChanges?.nodes || []).map((b) => ({
      amount: b.amount, coin: b.coinType?.repr, owner: b.owner?.address?.toLowerCase() ?? null,
    })),
  };
}

export const PAGE_SIZE = 50;
export const MAX_TX_LIMIT = 200;

/** Clamp a read depth to 50..200 (a whole number of pages of 50). Anything else falls back to 50. */
export function clampMaxTx(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < PAGE_SIZE) return PAGE_SIZE;
  return Math.min(Math.ceil(v / PAGE_SIZE) * PAGE_SIZE, MAX_TX_LIMIT);
}

/**
 * Oldest first, up to maxTx transactions (50 to 200), paged through client.listTransactions with the same
 * afterCheckpoint every time. maxTx 50 is exactly one call, as before. At most ceil(maxTx / 50) calls, so one read
 * can never run past 4 calls. hasNextPage stays true when more history exists beyond what was read.
 */
export async function listHistory(client, address, { maxTx = PAGE_SIZE, afterCheckpoint } = {}) {
  const limit = clampMaxTx(maxTx);
  const opt = afterCheckpoint === undefined ? {} : { afterCheckpoint };
  let page = await client.listTransactions(address, { first: PAGE_SIZE, ...opt });
  const transactions = [...page.transactions];
  let calls = 1;
  while (page.hasNextPage && page.cursor && transactions.length < limit && calls < limit / PAGE_SIZE) {
    page = await client.listTransactions(address, { first: PAGE_SIZE, cursor: page.cursor, ...opt });
    calls++;
    transactions.push(...page.transactions);
  }
  const kept = transactions.slice(0, limit);
  const more = page.hasNextPage || transactions.length > limit;
  return {
    ...page,
    transactions: kept,
    hasNextPage: more,
    oldestCheckpoint: kept.length ? Math.min(...kept.map((t) => t.checkpoint)) : null,
    pagesRead: calls,
  };
}
