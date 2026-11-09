// The demo agent. It tries to pay a wallet that was reported bad (refused, nothing sent), then pays a clean one (a real mainnet payment).
// Usage:
//   node --env-file=.env agent/demo.js --dry-run     test namespace, nothing is sent, nothing is written to data/
//   node --env-file=.env agent/demo.js --run         live namespaces, sends the real payment, writes data/refuse-then-pay/latest.json
// Options: --amount=0.001  --good=<clean wallet>  (default: real-set ordinary wallet rc-01)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createSafePay, PayCheckRefused } from './safePay.js';
import { buildEnv, waitUntilRecalled, EXPLORER_TX } from './common.js';
import { mistToSui, suiToMist } from './payer.js';

const OUT = new URL('../data/refuse-then-pay/latest.json', import.meta.url);
const args = process.argv.slice(2);
const flag = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const live = args.includes('--run');
if (!live && !args.includes('--dry-run')) { console.error('Usage: node --env-file=.env agent/demo.js --dry-run | --run [--amount=0.001] [--good=0x...]'); process.exit(1); }

const amount = flag('amount') ?? '0.001';
const controls = JSON.parse(await readFile(new URL('../data/real-set/controls.json', import.meta.url), 'utf8'));
const first = controls.controls[0]; // rc-01, the first ordinary wallet of the real set (recorded verdict: pay)
const goodAddress = flag('good') ?? first.address;
if (!goodAddress) throw new Error('No clean wallet to pay');

const env = buildEnv({ mode: live ? 'live' : 'test', withPayer: live });
const { memory, checker, payer } = env;
const safePay = createSafePay({
  checker, memory, payer, agentId: 'demo-agent', dryRun: !live,
  refusalNamespace: live ? 'agent-a' : 'k2-test', refusalOrigin: live ? 'agent-a' : 'k2-test',
});

const before = live ? await payer.balance() : null;

// Step 0: a wallet that was reported bad. It is a fresh address built by us, so nobody else's wallet is named.
const badAddress = new Ed25519Keypair().toSuiAddress();
console.log(`setup: reporting ${badAddress} (fresh wallet, built by us, no funds) as a bad payment${live ? ' in the live namespace' : ' in the test namespace'}...`);
const report = await checker.reportOutcome(badAddress, 'bad', { reporter: 'demo-setup' });
const written = report.written[0];
if (written.state !== 'stored') throw new Error(`report not stored: ${written.error}`);
const seen = await waitUntilRecalled(memory, { namespace: report.namespace, address: report.address, blobId: written.blobId });
if (!seen) throw new Error('the report was stored but could not be searched yet; try again in a minute (nothing was paid)');
console.log(`setup: bad report stored as memory ${written.blobId} and searchable`);

// Step 1: the refusal.
let refused = null;
try {
  const r = await safePay(badAddress, amount);
  console.log(`UNEXPECTED: payment to the bad wallet was not refused (${JSON.stringify({ paid: r.paid, digest: r.digest })})`);
  process.exitCode = 2;
} catch (e) {
  if (!(e instanceof PayCheckRefused)) throw e;
  refused = e;
  console.log(`refused ${e.payee} (memory ${e.memoryIds.join(', ')})`);
  console.log(`  ${e.code}, check says ${e.verdict} ${e.checkCode}: ${e.reason}`);
  console.log(`  refusal saved as memory ${e.refusalMemory.id ?? 'NOT SAVED'} (${e.refusalMemory.state}, namespace ${e.refusalMemory.namespace}); transaction sent: none`);
}

// Step 2: the clean payee.
let paid = null;
if (refused) {
  paid = await safePay(goodAddress, amount);
  if (paid.dryRun) console.log(`dry run ok ${paid.payee} (${paid.verdict} ${paid.code}, would send ${mistToSui(paid.amountMist)} SUI)`);
  else console.log(`paid ${paid.payee} ${mistToSui(paid.amountMist)} SUI, digest ${paid.digest}\n  ${EXPLORER_TX(paid.digest)}`);
}

const after = live ? await payer.balance() : null;
await memory.flush();
memory.destroy();

if (live && refused && paid?.paid) {
  const spent = before - after;
  const result = {
    ranAt: new Date().toISOString(),
    mode: 'live',
    sharedAccount: true,
    note: 'The refused wallet is a fresh address built by us and reported bad by a setup step. No real stranger wallet is named as bad. The paid wallet is an ordinary real-set wallet (rc-01).',
    refused: {
      address: refused.payee,
      builtByUs: true,
      verdict: refused.verdict,
      code: refused.checkCode,
      reason: refused.reason,
      memoryIds: refused.memoryIds,
      reportMemoryId: written.blobId,
      refusalMemoryId: refused.refusalMemory.id,
      transactionSent: false,
    },
    paid: {
      address: paid.payee,
      source: 'real set ordinary wallet rc-01',
      verdict: paid.verdict,
      code: paid.code,
      amountSui: mistToSui(paid.amountMist),
      digest: paid.digest,
      explorer: EXPLORER_TX(paid.digest),
      gasMist: paid.gasMist?.toString() ?? null,
    },
    spentMist: spent.toString(),
    spentSui: mistToSui(spent),
  };
  await mkdir(new URL('../data/refuse-then-pay/', import.meta.url), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote data/refuse-then-pay/latest.json, real SUI spent ${mistToSui(spent)} (payment ${mistToSui(paid.amountMist)} plus network fee)`);
  console.log(`[[REFUSED_ADDRESS]]=${result.refused.address}\n[[REFUSED_MEMORY_ID]]=${result.refused.memoryIds[0]}\n[[PAID_ADDRESS]]=${result.paid.address}\n[[PAID_DIGEST]]=${result.paid.digest}`);
}
process.exit(process.exitCode ?? 0);
