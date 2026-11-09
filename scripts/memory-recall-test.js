// Step 1.2a: can we get an exact memory back by address or by group id? Writes 10 labelled TEST memories into
// namespace k2-test (origin=k2-test, never counted in headline numbers), then recalls each two ways.
import { createHash } from 'node:crypto';
import { MemWal } from '@mysten-incubation/memwal';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
const NS = 'k2-test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

// Real addresses from recent Tatum Sui checkpoints (senders and receivers of plain SUI transfers).
async function gql(query) {
  const res = await fetch('https://sui-mainnet.gateway.tatum.io/graphql', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.TATUM_API_KEY_MAINNET },
    body: JSON.stringify({ query }),
  });
  if (res.status === 429) { await sleep(1000); return gql(query); }
  return res.json();
}
async function pickAddresses(n) {
  const cp = (await gql('{ checkpoint { sequenceNumber } }')).data.checkpoint.sequenceNumber;
  const set = new Set();
  for (let seq = cp - 3; set.size < n && seq > cp - 300; seq--) {
    await sleep(450);
    const r = await gql(`{ checkpoint(sequenceNumber:${seq}) { transactions(first:50){ nodes{ effects{ balanceChanges(first:10){ nodes{ amount coinType{repr} owner{address} } } } } } } }`);
    for (const t of r.data?.checkpoint?.transactions?.nodes || []) {
      for (const b of t.effects?.balanceChanges?.nodes || []) if (b.coinType.repr === SUI && set.size < n) set.add(b.owner.address);
    }
  }
  return [...set];
}

const groupOf = (i) => 'g-' + createHash('sha256').update('k2b-group-' + Math.floor(i / 2)).digest('hex').slice(0, 8);
const header = (kind, address, group) => `PAYCHECK v1 kind=${kind} address=${address} group=${group} origin=k2-test`;
const parse = (text) => {
  const line = String(text).split('\n')[0];
  return { address: /address=(\S+)/.exec(line)?.[1], group: /group=(\S+)/.exec(line)?.[1] };
};

const addrs = await pickAddresses(10);
if (addrs.length < 10) { console.log('FAIL could not pick 10 addresses, got', addrs.length); process.exit(1); }

const client = MemWal.create({ key: cfg.MEMWAL_DELEGATE_PRIVATE_KEY, accountId: cfg.MEMWAL_ACCOUNT_ID, serverUrl: cfg.MEMWAL_RELAYER_URL, namespace: NS });
const writeMs = [];
for (let i = 0; i < 10; i++) {
  const group = groupOf(i);
  const text = `${header('verdict', addrs[i], group)}\n` + JSON.stringify({ test: true, note: 'K2b recall test memory, not a real check', verdict: i % 2 ? 'caution' : 'pay', index: i });
  const t0 = Date.now();
  const r = await client.rememberAndWait(text, NS, { idempotencyKey: createHash('sha256').update(text).digest('hex'), timeoutMs: 90000 });
  writeMs.push(Date.now() - t0);
  console.error(`write ${i + 1}/10 ${Date.now() - t0}ms blob ${r.blob_id}`);
}
await sleep(5000);

let byAddr = 0, byGroup = 0, top1 = 0;
for (let i = 0; i < 10; i++) {
  const group = groupOf(i);
  const a = await client.recall({ query: addrs[i], limit: 20, namespace: NS });
  if (a.results.some((m) => parse(m.text).address === addrs[i])) byAddr++;
  if (a.results[0] && parse(a.results[0].text).address === addrs[i]) top1++;
  const g = await client.recall({ query: group, limit: 20, namespace: NS });
  const hits = g.results.filter((m) => parse(m.text).group === group);
  if (hits.some((m) => parse(m.text).address === addrs[i])) byGroup++;
}
console.error('median write ms', writeMs.sort((a, b) => a - b)[5]);
console.log(`wrote 10, exact by address ${byAddr}/10, exact by group ${byGroup}/10, raw top-1 ${top1}/10`);
client.destroy();
