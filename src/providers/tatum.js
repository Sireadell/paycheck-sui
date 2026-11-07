// Tatum Sui GraphQL client. Every read for the checker goes through here.
import { sharedLimiter } from './rateLimit.js';
import { record } from './callLog.js';

export const ENDPOINT = 'https://sui-mainnet.gateway.tatum.io/graphql';
// About 23 Jan 2026. Listings must always carry afterCheckpoint, and nothing older is served.
export const FLOOR_CHECKPOINT = 237661232;
export const SUI_COIN = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

const TX_FIELDS = `digest sender{address} gasInput{gasSponsor{address}}
  effects{ status timestamp checkpoint{sequenceNumber}
    balanceChanges(first:50){ nodes{ amount coinType{repr} owner{address} } } }`;

export function createTatum({ key, fetchImpl = fetch, limiter = sharedLimiter, endpoint = ENDPOINT, retryWaitMs = 1000, timeoutMs = 15000 } = {}) {
  if (!key) throw new Error('Missing TATUM_API_KEY_MAINNET');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function gql(type, query) {
    const started = Date.now();
    let ok = false;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await limiter();
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/json', 'x-api-key': key },
          body: JSON.stringify({ query }),
        });
        if (res.status === 429 && attempt === 0) { await sleep(retryWaitMs); continue; }
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

  const addr = (a) => {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(a || '')) throw new Error('Not a Sui address');
    return a.toLowerCase();
  };

  return {
    async latestCheckpoint() {
      const d = await gql('latestCheckpoint', '{ checkpoint { sequenceNumber } }');
      return d.checkpoint.sequenceNumber;
    },
    async referenceGasPrice() {
      const d = await gql('referenceGasPrice', '{ epoch { referenceGasPrice } }');
      return Number(d.epoch.referenceGasPrice);
    },
    async balance(address) {
      const d = await gql('balance', `{ address(address:"${addr(address)}") { balance(coinType:"0x2::sui::SUI") { totalBalance } } }`);
      return d.address?.balance?.totalBalance ?? '0';
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
    // Who sent the first SUI to this address. Returns olderThanData when the first funding may predate our floor.
    async firstFunder(address) {
      const a = addr(address);
      const page = await this.listTransactions(a, { first: 50 });
      for (const t of page.transactions) {
        if (t.status !== 'SUCCESS' || t.sender === a) continue;
        const got = t.balanceChanges.find((b) => b.owner === a && b.coin === SUI_COIN && BigInt(b.amount) > 0n);
        if (got) return { funder: t.sender, digest: t.digest, amount: got.amount, checkpoint: t.checkpoint, timestamp: t.timestamp, gasSponsor: t.gasSponsor, olderThanData: false };
      }
      return { funder: null, olderThanData: true, note: 'first funding is older than our data', incoming: 0 };
    },
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
