// Step 1.0b: checks which Tatum Sui routes answer. Plain fetch, no install. Never prints key values.
const KEY = process.env.TATUM_API_KEY_MAINNET;
if (!KEY) { console.error('Missing TATUM_API_KEY_MAINNET'); process.exit(1); }
const BASE = 'https://sui-mainnet.gateway.tatum.io';
const FLOOR = 237661232;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function post(path, body, base = BASE) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = 450 - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetch(base + path, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'x-api-key': KEY },
      body: JSON.stringify(body),
    });
    if (res.status === 429) { await sleep(1000); continue; }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json };
  }
  return { status: 429, json: null };
}
const gql = (query) => post('/graphql', { query });

const rpc = { jsonrpc: '2.0', id: 1, method: 'suix_getReferenceGasPrice', params: [] };
console.log('graphql', (await gql('{ epoch { referenceGasPrice } }')).status);
console.log('jsonrpc /', (await post('/', rpc)).status);
console.log('jsonrpc /jsonrpc', (await post('/jsonrpc', rpc)).status);
// Route taken from Tatum's Sui docs: the gRPC host (HTTPS reachability only, no gRPC client installed).
try {
  const r = await fetch('https://sui-mainnet-grpc.gateway.tatum.io', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'x-api-key': KEY, 'content-type': 'application/grpc' }, body: '' });
  console.log('grpc host https', r.status, 'grpc-status', r.headers.get('grpc-status'));
} catch (e) { console.log('grpc host https error', e.cause?.code || e.message); }

// Find 3 real plain SUI transfers (one sender loses, one receiver gains) in recent checkpoints.
const cp = (await gql('{ checkpoint { sequenceNumber } }')).json.data.checkpoint.sequenceNumber;
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const found = [];
for (let seq = cp - 3; found.length < 3 && seq > cp - 300; seq--) {
  const r = await gql(`{ checkpoint(sequenceNumber:${seq}) { transactions(first:50){ nodes{ digest effects{ status balanceChanges(first:10){ nodes{ amount coinType{repr} owner{address} } } } } } } }`);
  for (const n of r.json?.data?.checkpoint?.transactions?.nodes || []) {
    if (found.length >= 3) break;
    const bc = n.effects?.balanceChanges?.nodes || [];
    const sui = bc.filter((b) => b.coinType.repr === SUI);
    const neg = sui.filter((b) => BigInt(b.amount) < 0n), pos = sui.filter((b) => BigInt(b.amount) > 0n);
    if (n.effects?.status === 'SUCCESS' && bc.length === sui.length && neg.length === 1 && pos.length === 1 && pos[0].owner.address !== neg[0].owner.address) {
      // re-read by digest to prove transaction(digest) works
      const t = await gql(`{ transaction(digest:"${n.digest}") { sender{address} gasInput{ gasSponsor{address} } effects{ balanceChanges(first:10){ nodes{ amount owner{address} } } } } }`);
      const tx = t.json?.data?.transaction;
      if (tx?.effects?.balanceChanges?.nodes?.length === bc.length) found.push({ digest: n.digest, from: neg[0].owner.address, to: pos[0].owner.address, amount: pos[0].amount, sponsor: tx.gasInput?.gasSponsor?.address });
    }
  }
}
console.log(found.length ? 'tx-by-digest ok' : 'tx-by-digest FAIL');
console.log(`balanceChanges ${found.length === 3 ? 'ok' : 'FAIL'} ${found.length}/3`);
for (const f of found) console.log(' transfer', f.digest, 'amount', f.amount, 'sponsor', f.sponsor ? 'gasOwner readable' : 'none');
if (found[0]) {
  const b = await gql(`{ address(address:"${found[0].to}") { balance(coinType:\"0x2::sui::SUI\") { totalBalance } } }`);
  console.log(b.json?.data?.address?.balance?.totalBalance ? 'balance ok' : 'balance FAIL ' + JSON.stringify(b.json?.errors?.[0]?.message || b.status));
}
const l = await gql(`{ transactions(first:1, filter:{ affectedAddress:"${found[0]?.to}", afterCheckpoint:${FLOOR} }) { nodes{ digest } } }`);
console.log('listing afterCheckpoint', l.json?.data ? 'ok' : 'FAIL');
