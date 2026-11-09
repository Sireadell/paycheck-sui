// An agent buys one check with plain SUI. It runs our server in this process (real Tatum), asks for a check,
// receives the HTTP 402 amount, pays on Sui mainnet, sends the digest, and gets the verdict back.
// Usage:
//   node --env-file=.env agent/paid-client.js --run [--address=0x...]   sends a real payment, writes data/paid-check/latest.json
// The payee is PAID_CHECK_PAYEE, or SUI_ADDRESS when that is not set. The paying wallet keeps a 3 SUI reserve.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { createPaidCheck } from '../src/paid.js';
import { getTatum } from '../src/providers/index.js';
import { buildEnv, sleep, EXPLORER_TX } from './common.js';
import { mistToSui } from './payer.js';

const OUT = fileURLToPath(new URL('../data/paid-check/latest.json', import.meta.url));
const USED = fileURLToPath(new URL('../data/paid-check/used.json', import.meta.url));
const args = process.argv.slice(2);
if (!args.includes('--run')) { console.error('Usage: node --env-file=.env agent/paid-client.js --run [--address=0x...]'); process.exit(1); }
const flag = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];

const controls = JSON.parse(await readFile(new URL('../data/real-set/controls.json', import.meta.url), 'utf8'));
const target = flag('address') ?? controls.controls[0].address;

const { cfg, memory, checker, payer } = buildEnv({ mode: 'test', withPayer: true, reserveSui: 3 });
const payee = process.env.PAID_CHECK_PAYEE || cfg.SUI_ADDRESS;
if (!payee) throw new Error('No receiving address: set PAID_CHECK_PAYEE or SUI_ADDRESS');
if (payee.toLowerCase() === payer.address) throw new Error('The receiving address is the paying wallet; pick another');
const paidCheck = createPaidCheck({ tatum: getTatum(), checker, payee, usedFile: USED });
const app = createApp({ checker, memory, paidCheck });
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (body) => {
  const r = await fetch(`${base}/api/paid/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

try {
  const before = await payer.balance();
  const ask = await post({ address: target });
  if (ask.status !== 402) throw new Error(`Expected 402, got ${ask.status}`);
  const { id, amountMist } = ask.body.payment;
  console.log(`402: pay ${ask.body.payment.amountSui} SUI to ${ask.body.payment.payee} (id ${id})`);
  const sent = await payer.pay(payee, BigInt(amountMist));
  console.log(`paid: digest ${sent.digest}`);
  let answer;
  for (let i = 0; i < 12; i++) {
    answer = await post({ address: target, id, digest: sent.digest });
    if (answer.status !== 402 || !answer.body.retryable) break;
    await sleep(4000);
  }
  if (answer.status !== 200) throw new Error(`Paid check not served: ${answer.status} ${JSON.stringify(answer.body)}`);
  const ask2 = await post({ address: target });
  const replay = await post({ address: target, id: ask2.body.payment.id, digest: sent.digest });
  console.log(`verdict: ${answer.body.verdict} ${answer.body.code}; replaying the same digest: HTTP ${replay.status}`);
  const after = await payer.balance();
  const spent = before - after;
  const stats = await (await fetch(`${base}/api/stats`)).json();
  const run = {
    ranAt: new Date().toISOString(),
    route: 'plain SUI',
    network: 'Sui mainnet',
    checks: stats.paidChecks.settled,
    digest: sent.digest,
    explorer: EXPLORER_TX(sent.digest),
    payee: paidCheck.payee,
    payer: payer.address,
    amountSui: mistToSui(amountMist),
    gasMist: String(sent.gasMist),
    checkedAddress: target,
    verdict: answer.body.verdict,
    code: answer.body.code,
    verifiedThrough: 'Tatum GraphQL',
    replayStatus: replay.status,
    spentMist: String(spent),
    spentSui: mistToSui(spent),
  };
  await mkdir(fileURLToPath(new URL('../data/paid-check/', import.meta.url)), { recursive: true });
  await writeFile(OUT, JSON.stringify(run, null, 2));
  console.log(`settled ${run.explorer}\nreal SUI spent ${run.spentSui} (balance before ${mistToSui(before)}); paid checks counted ${run.checks}`);
} finally { app.locals.stop(); server.close(); server.closeAllConnections?.(); setTimeout(() => process.exit(), 500); }
