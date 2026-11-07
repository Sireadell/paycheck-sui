// Usage: npm run outcome -- <sui address> <bad|good> [reporter]
// Saves a "paid fine" or "went bad" report. Waits for the memory write (15 to 25 s each) and says so.
import { createChecker } from '../src/check.js';
import { createMemory } from '../src/memory/index.js';
import { getTatum } from '../src/providers/index.js';
import { loadConfig } from '../src/config.js';

const [address, outcome, reporter] = process.argv.slice(2);
if (!address || !['bad', 'good'].includes(outcome)) { console.error('Usage: npm run outcome -- <sui address> <bad|good> [reporter]'); process.exit(1); }
loadConfig();
const memory = createMemory();
const checker = createChecker({ tatum: getTatum(), memory, mode: 'test' });
console.log('saving the report and waiting for the memory write to finish (this takes 15 to 25 s per memory)...');
const t = Date.now();
const r = await checker.reportOutcome(address, outcome, { reporter: reporter || 'cli' });
for (const w of r.written) console.log(`wrote outcome ${r.outcome} for ${r.address} group ${w.group ?? 'none'}: ${w.state}${w.blobId ? `, blob ${w.blobId}` : ''}${w.error ? `, error ${w.error}` : ''}`);
console.log(`done in ${Math.round((Date.now() - t) / 1000)} s${r.test ? ', stored in the test namespace (labelled test)' : ''}`);
// Walrus search needs a few seconds before a new memory can be recalled.
await new Promise((res) => setTimeout(res, 8000));
memory.destroy();
process.exit(r.written.every((w) => w.state === 'stored') ? 0 : 1);
