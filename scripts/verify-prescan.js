// Verifies the stored pre-scan by recall. Walrus reads only: no writes, no Tatum, no Ankr.
// Usage: node --env-file=.env scripts/verify-prescan.js [--dir=data/prescan]
// Recalls every stored address from the live namespace by exact address filter (2 at a time, retries inside the memory layer),
// prints `verified recalled N of M`, lists each failure with its exact error, writes <dir>/verified.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function loadAddresses(dir) {
  const progress = join(dir, 'progress.json');
  if (existsSync(progress)) {
    const p = JSON.parse(readFileSync(progress, 'utf8'));
    const stored = Object.keys(p.stored ?? {});
    if (stored.length) return stored;
  }
  const v = join(dir, 'verdicts.jsonl');
  return readFileSync(v, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.memoryItem).map((r) => r.address);
}

export async function verifyPrescan({ addresses, memory, concurrency = 2, log = () => {} }) {
  const verified = [];
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < addresses.length) {
      const address = addresses[next++];
      try {
        const found = await memory.recall({ namespace: 'live', address, limit: 100 });
        if (found.some((m) => m.origin === 'prescan' && m.kind === 'verdict')) verified.push(address);
        else failed.push({ address, error: 'recall worked but returned no pre-scan verdict for this address' });
      } catch (e) { failed.push({ address, error: String(e?.message || e) }); }
      if ((verified.length + failed.length) % 20 === 0) log(`progress ${verified.length + failed.length} of ${addresses.length}, verified ${verified.length}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { verified: addresses.filter((a) => verified.includes(a)), failed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { createMemory } = await import('../src/memory/index.js');
  const dir = process.argv.slice(2).find((a) => a.startsWith('--dir='))?.split('=')[1] ?? 'data/prescan';
  const addresses = loadAddresses(dir);
  const memory = createMemory();
  const out = await verifyPrescan({ addresses, memory, log: console.log });
  console.log(`verified recalled ${out.verified.length} of ${addresses.length}`);
  for (const f of out.failed) console.log(`FAILED ${f.address}: ${f.error}`);
  writeFileSync(join(dir, 'verified.json'), JSON.stringify({ checkedAt: new Date().toISOString(), of: addresses.length, verified: out.verified, failed: out.failed }, null, 2));
  memory.destroy();
  process.exit(0);
}
