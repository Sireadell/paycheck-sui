// Usage: npm run check -- <sui address> [--memory=off] [--json]
// Runs a full check. Memory writes go to the test namespace (k2-test) until the live mode is switched on in a later step.
import { createChecker } from '../src/check.js';
import { createMemory } from '../src/memory/index.js';
import { getTatum, getAnkr } from '../src/providers/index.js';
import { loadConfig } from '../src/config.js';

const args = process.argv.slice(2);
const address = args.find((a) => !a.startsWith('--'));
if (!address) { console.error('Usage: npm run check -- <sui address> [--memory=off] [--json]'); process.exit(1); }
const memoryOn = !args.includes('--memory=off');

const cfg = loadConfig();
const memory = createMemory();
const checker = createChecker({ tatum: getTatum(), ankr: cfg.ANKR_API_KEY ? getAnkr() : null, memory, mode: 'test' });
const r = await checker.check(address, { memoryOn });

if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
console.log(`${r.address}`);
console.log(`${r.verdict} (${r.code}): ${r.reason}`);
if (r.changedByMemory) console.log(`${r.verdict}, changed by memory ${r.changedByIds.join(', ')} (without memory: ${r.withoutMemory.verdict})`);
console.log(`memory ${memoryOn ? 'on' : 'off'}${r.test ? ' (test namespace, labelled test)' : ''}`);
console.log(`memory used ${r.memory.used}, wrote ${r.write.count}${r.write.count ? ` (${r.write.state}, ${r.write.note})` : ''}`);
if (r.memory.degraded) console.log(`memory recall problem: ${r.memory.recallError}`);
console.log(`tatum calls ${r.callLog.tatum.calls} (failed ${r.callLog.tatum.failed}), ankr calls ${r.callLog.ankr.calls}, ${r.tookMs} ms`);
if (r.crossCheck?.used) console.log(`ankr cross-check: ${r.crossCheck.agree} of ${r.crossCheck.checked} agree${r.crossCheck.note ? ` (${r.crossCheck.note})` : ''}`);
for (const n of r.notes ?? []) console.log(`note: ${n}`);

if (r.write.count) {
  console.log('waiting for the memory write to finish so it is not lost (the answer above did not wait)...');
  const t = Date.now();
  await Promise.race([memory.flush(), new Promise((res) => setTimeout(res, 120000))]);
  const e = memory.entry(r.write.key, r.write.namespace);
  console.log(`write ${e?.state} after ${Math.round((Date.now() - t) / 1000)} s${e?.blobId ? `, blob ${e.blobId}` : ''}${e?.error ? `, error ${e.error}` : ''}`);
}
memory.destroy();
process.exit(0);
