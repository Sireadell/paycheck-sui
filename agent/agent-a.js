// Agent A. It pays a wallet through safePay, and when the payment goes bad it reports that into the shared memory.
// Usage: node --env-file=.env agent/agent-a.js <wallet it pays> [--live] [--amount=0.001]
//   --live   live namespaces and a real mainnet payment. Without it: test namespace, nothing is sent.
// The last line printed is RESULT {json}, read by agent/cross-agent.js. Agent A runs as its own process.
import { createSafePay } from './safePay.js';
import { buildEnv, waitUntilRecalled, EXPLORER_TX } from './common.js';
import { mistToSui } from './payer.js';

const args = process.argv.slice(2);
const wallet = args.find((a) => !a.startsWith('--'));
const live = args.includes('--live');
const amount = args.find((a) => a.startsWith('--amount='))?.split('=')[1] ?? '0.001';
if (!wallet) { console.error('Usage: node --env-file=.env agent/agent-a.js <wallet> [--live] [--amount=0.001]'); process.exit(1); }

const AGENT = 'agent-a';
const { memory, checker, payer } = buildEnv({ mode: live ? 'live' : 'test', withPayer: live });
const safePay = createSafePay({ checker, memory, payer, agentId: AGENT, dryRun: !live, refusalNamespace: live ? 'agent-a' : 'k2-test', refusalOrigin: live ? 'agent-a' : 'k2-test' });

const paid = await safePay(wallet, amount);
console.log(`${AGENT}: check said ${paid.verdict} (${paid.code}) for ${paid.payee}; ${paid.paid ? `paid ${mistToSui(paid.amountMist)} SUI, ${EXPLORER_TX(paid.digest)}` : 'dry run, nothing sent'}`);

console.log(`${AGENT}: the payment went bad. Reporting it into the shared memory and waiting for the write (15 to 25 s)...`);
const report = await checker.reportOutcome(paid.payee, 'bad', { reporter: AGENT });
const stored = report.written.find((w) => w.state === 'stored');
if (!stored) throw new Error(`report not stored: ${report.written.map((w) => w.error).join('; ')}`);
// B finds the report by wallet, funder, sponsor and group id; wait until the group search returns it too.
const groupId = stored.group ?? null;
let searchable = await waitUntilRecalled(memory, { namespace: report.namespace, address: report.address, blobId: stored.blobId });
if (searchable && groupId) searchable = await waitUntilRecalled(memory, { namespace: report.namespace, group: groupId, blobId: stored.blobId }, { tries: 24 });
console.log(`${AGENT}: reported bad as memory ${stored.blobId} (namespace ${report.namespace}), searchable: ${searchable}`);

const result = { id: AGENT, address: report.address, memoryId: stored.blobId, namespace: report.namespace, reportedAt: new Date().toISOString(), searchable, payment: paid.paid ? { digest: paid.digest, amountMist: paid.amountMist.toString(), explorer: EXPLORER_TX(paid.digest) } : null };
await memory.flush();
memory.destroy();
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(searchable ? 0 : 3);
