// Step 1.6 proof: one real write and one exact recall. Default namespace is k2-test (labelled test, not counted).
// Usage: node --env-file=.env scripts/memory-smoke.js [namespace]
import { createMemory } from '../src/memory/index.js';

const ns = process.argv[2] || 'k2-test';
const origin = ns === 'k2-test' ? 'k2-test' : 'check';
const stamp = Date.now().toString(16);
const address = '0x' + stamp.padStart(64, '0');
const group = 'g-' + stamp.slice(-8);
const mem = createMemory();
const t0 = Date.now();
const e = mem.enqueue({ namespace: ns, kind: 'verdict', address, group, origin, body: { test: true, note: 'memory layer smoke memory, not a real check', verdict: 'pay' } });
console.log('state right after enqueue:', e.state);
await mem.flush();
const w = mem.entry(e.key, ns);
if (w.state !== 'stored') { console.log('FAIL write', w.state, w.error); process.exit(1); }
console.error('write ms', Date.now() - t0);
await new Promise((r) => setTimeout(r, 5000));
const hits = await mem.recall({ namespace: ns, address });
console.log(`blob_id ${w.blobId}, recalled exact ${hits.length}, counter ${JSON.stringify(mem.counter())}`);
mem.destroy();
process.exit(hits.length === 1 ? 0 : 1);
