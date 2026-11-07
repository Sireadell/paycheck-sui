// Step 1.3 smoke test: node --env-file=.env scripts/tatum-smoke.js <sui address>
import { getTatum, callLog } from '../src/providers/index.js';

const address = process.argv[2];
if (!address) { console.error('Usage: node scripts/tatum-smoke.js <sui address>'); process.exit(1); }
const tatum = getTatum();
const since = callLog.mark();
const page = await tatum.listTransactions(address, { first: 50 });
const a = address.toLowerCase();
const incoming = page.transactions.filter((t) => t.sender !== a && t.balanceChanges.some((b) => b.owner === a && BigInt(b.amount) > 0n)).length;
const balance = await tatum.balance(address);
await tatum.latestCheckpoint();
await tatum.referenceGasPrice();
const s = callLog.summarize(since, 'tatum');
const types = Object.entries(s.byType).map(([k, v]) => `${k}=${v}`).join(' ');
console.log(`incoming ${incoming}, balance ${balance}, calls ${s.calls} by type ${types}, failed ${s.failed}`);
console.log(`median ${s.medianMs} ms, oldest checkpoint seen ${page.oldestCheckpoint}`);
