// An agent buys one check with x402. It asks, receives HTTP 402 with a PAYMENT-REQUIRED header, signs a SUI transfer for the
// exact amount, and sends it in PAYMENT-SIGNATURE. The server simulates, sends and settles it, then answers with the verdict.
// Usage:
//   node --env-file=.env agent/x402-client.js --run [--address=0x...]            runs our server in this process, sends a real mainnet payment, writes data/x402/latest.json
//   node --env-file=.env agent/x402-client.js --url=https://host/api/x402/check --address=0x...   buys one check from a running server
// The paying wallet keeps a 2 SUI reserve. The key is read from the environment and never printed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { createApp } from '../server.js';
import { createX402Check, encodeHeader, decodeHeader, X402_VERSION } from '../src/x402.js';
import { loadConfig } from '../src/config.js';
import { ENDPOINT_BASE } from '../src/providers/ankr.js';
import { buildEnv, EXPLORER_TX } from './common.js';
import { keypairFromSecret, mistToSui } from './payer.js';

const OUT = fileURLToPath(new URL('../data/x402/latest.json', import.meta.url));
const USED = fileURLToPath(new URL('../data/x402/used.json', import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
if (!args.includes('--run') && !flag('url')) { console.error('Usage: node --env-file=.env agent/x402-client.js --run [--address=0x...]  or  --url=<server>/api/x402/check --address=0x...'); process.exit(1); }

const cfg = loadConfig();
const keypair = keypairFromSecret(cfg.SUI_WALLET_PRIVATE_KEY);
const rpc = new SuiJsonRpcClient({ url: ENDPOINT_BASE + cfg.ANKR_API_KEY, network: 'mainnet' });
const RESERVE = 2_000_000_000n;

/** Sign a transfer for what the server asked for. Returns the PAYMENT-SIGNATURE header value. */
async function paymentHeader(required, accepted) {
  const have = BigInt((await rpc.getBalance({ owner: keypair.toSuiAddress() })).totalBalance);
  if (have - BigInt(accepted.amount) - 10_000_000n < RESERVE) throw new Error('Payment would take the wallet below its reserve');
  const tx = new Transaction();
  tx.setSender(keypair.toSuiAddress());
  const [coin] = tx.splitCoins(tx.gas, [BigInt(accepted.amount)]);
  tx.transferObjects([coin], accepted.payTo);
  const bytes = await tx.build({ client: rpc });
  const { signature } = await keypair.signTransaction(bytes);
  return encodeHeader({ x402Version: X402_VERSION, resource: required.resource, accepted, payload: { signature, transaction: Buffer.from(bytes).toString('base64') } });
}

async function buy(url, address) {
  const target = `${url}?address=${address}`;
  const first = await fetch(target);
  if (first.status !== 402) throw new Error(`Expected 402, got ${first.status}`);
  const required = decodeHeader(first.headers.get('payment-required'));
  const accepted = required.accepts[0];
  console.log(`402: pay ${mistToSui(accepted.amount)} SUI (${accepted.asset}) to ${accepted.payTo} on ${accepted.network}`);
  const header = await paymentHeader(required, accepted);
  const paid = await fetch(target, { headers: { 'PAYMENT-SIGNATURE': header } });
  return { header, paid, accepted, receipt: decodeHeader(paid.headers.get('payment-response')), body: await paid.json() };
}

if (flag('url')) {
  const r = await buy(flag('url'), flag('address'));
  console.log(r.paid.status, r.body.verdict ?? r.body.error, r.receipt ? EXPLORER_TX(r.receipt.transaction) : '');
  process.exit(r.paid.status === 200 ? 0 : 1);
}

const controls = JSON.parse(await readFile(new URL('../data/real-set/controls.json', import.meta.url), 'utf8'));
const target = flag('address') ?? controls.controls[0].address;
const { memory, checker } = buildEnv({ mode: 'test' });
const payee = process.env.PAID_CHECK_PAYEE || cfg.SUI_ADDRESS;
if (!payee) throw new Error('No receiving address: set PAID_CHECK_PAYEE or SUI_ADDRESS');
if (payee.toLowerCase() === keypair.toSuiAddress()) throw new Error('The receiving address is the paying wallet; pick another');
const x402 = createX402Check({ rpc, checker, payee, usedFile: USED });
const app = createApp({ checker, memory, x402 });
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/x402/check`;
try {
  const before = BigInt((await rpc.getBalance({ owner: keypair.toSuiAddress() })).totalBalance);
  const r = await buy(base, target);
  if (r.paid.status !== 200) throw new Error(`x402 check not served: ${r.paid.status} ${JSON.stringify(r.body)}`);
  const replay = await fetch(`${base}?address=${target}`, { headers: { 'PAYMENT-SIGNATURE': r.header } });
  const after = BigInt((await rpc.getBalance({ owner: keypair.toSuiAddress() })).totalBalance);
  console.log(`verdict: ${r.body.verdict} ${r.body.code}; replaying the same payment: HTTP ${replay.status}`);
  const run = {
    ranAt: new Date().toISOString(), route: 'x402 v2, scheme exact', network: r.accepted.network, asset: r.accepted.asset,
    digest: r.receipt.transaction, explorer: EXPLORER_TX(r.receipt.transaction), payee: r.accepted.payTo, payer: r.receipt.payer,
    amountSui: mistToSui(r.accepted.amount), checkedAddress: target, verdict: r.body.verdict, code: r.body.code,
    settledBy: 'this server (its own facilitator)', replayStatus: replay.status, spentSui: mistToSui(before - after),
  };
  await mkdir(fileURLToPath(new URL('../data/x402/', import.meta.url)), { recursive: true });
  await writeFile(OUT, JSON.stringify(run, null, 2));
  console.log(`settled ${run.explorer}\nreal SUI spent ${run.spentSui}`);
} finally { app.locals.stop(); server.close(); server.closeAllConnections?.(); setTimeout(() => process.exit(), 500); }
