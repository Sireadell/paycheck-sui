// Step 1.2: K2 memory cost and speed. 10 single writes, then 1 bulk of 20, all into namespace k2-test,
// every text labelled as a test. Reads SUI balances (read only) before and after. Sends no transaction.
import { createHash } from 'node:crypto';
import { MemWal } from '@mysten-incubation/memwal';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
const NS = 'k2-test';
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const CAP_MS = 15 * 60 * 1000;

async function balanceAnkr(address) {
  const res = await fetch(`https://rpc.ankr.com/sui/${cfg.ANKR_API_KEY}`, {
    method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getBalance', params: [address, '0x2::sui::SUI'] }),
  });
  const j = await res.json();
  return BigInt(j.result.totalBalance);
}
async function balanceTatum(address) {
  const res = await fetch('https://sui-mainnet.gateway.tatum.io/graphql', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.TATUM_API_KEY_MAINNET },
    body: JSON.stringify({ query: `{ address(address:"${address}") { balance(coinType:"0x2::sui::SUI") { totalBalance } } }` }),
  });
  const j = await res.json();
  return BigInt(j.data?.address?.balance?.totalBalance ?? 0);
}
async function balance(address) {
  if (!address) return null;
  try { return await balanceAnkr(address); } catch { return await balanceTatum(address); }
}
const text = (i, kind) => `PAYCHECK v1 kind=test address=0x${createHash('sha256').update(`k2-${RUN}-${i}`).digest('hex')} group=g-k2test origin=k2-test\n` +
  JSON.stringify({ test: true, note: `K2 cost and speed test memory (${kind}), not a real check`, run: RUN, index: i });

const before = { work: await balance(cfg.SUI_WALLET_ADDRESS), owner: await balance(cfg.SUI_ADDRESS) };
console.error('balances before (MIST): work', String(before.work), 'owner', String(before.owner));

const client = MemWal.create({ key: cfg.MEMWAL_DELEGATE_PRIVATE_KEY, accountId: cfg.MEMWAL_ACCOUNT_ID, serverUrl: cfg.MEMWAL_RELAYER_URL, namespace: NS });
const rows = [];
let okCount = 0;
let firstResult = null;
for (let i = 0; i < 10; i++) {
  if (Date.now() - started > CAP_MS) { console.error('cap reached'); break; }
  const t = text(i, 'single');
  const t0 = Date.now();
  try {
    const r = await client.rememberAndWait(t, NS, { idempotencyKey: createHash('sha256').update(t).digest('hex'), timeoutMs: 90000 });
    if (!firstResult) firstResult = r;
    okCount++; rows.push({ n: i + 1, s: (Date.now() - t0) / 1000, ok: true, blob: r.blob_id });
  } catch (e) { rows.push({ n: i + 1, s: (Date.now() - t0) / 1000, ok: false, err: String(e.message).slice(0, 120) }); }
  console.error(`write ${i + 1} ${rows.at(-1).s}s ok=${rows.at(-1).ok}`);
}

let bulk = null;
if (Date.now() - started < CAP_MS) {
  const items = Array.from({ length: 20 }, (_, i) => ({ text: text(100 + i, 'bulk'), namespace: NS }));
  const t0 = Date.now();
  try {
    const r = await client.rememberBulkAndWait(items, { timeoutMs: 300000 });
    bulk = { s: (Date.now() - t0) / 1000, succeeded: r.succeeded, failed: r.failed, total: r.total };
    okCount += r.succeeded;
  } catch (e) { bulk = { s: (Date.now() - t0) / 1000, err: String(e.message).slice(0, 160) }; }
  console.error('bulk', JSON.stringify(bulk));
}

const after = { work: await balance(cfg.SUI_WALLET_ADDRESS), owner: await balance(cfg.SUI_ADDRESS) };
const secs = rows.filter((r) => r.ok).map((r) => r.s).sort((a, b) => a - b);
const median = secs.length ? secs[Math.floor(secs.length / 2)] : NaN;
const costMist = (before.work - after.work) + (before.owner - after.owner);
console.error('write result fields:', firstResult ? Object.keys(firstResult).join(',') : 'none');
console.error('rows', JSON.stringify(rows.map(({ n, s, ok }) => ({ n, s, ok }))));
console.error('balances after (MIST): work', String(after.work), 'owner', String(after.owner));
console.log(`writes ${okCount} ok, median ${median}s, cost ${Number(costMist) / 1e9} SUI, explorer url: none tested (blob ids only, see log)`);
client.destroy();
