// The cross-agent warning demo. Two agents run as two separate programs.
//   Agent A pays W1 and reports the payment as bad into the shared memory.
//   Agent B is then asked to pay W2, a different wallet linked to W1. It is never given W1. It is warned by A's memory.
// Both agents use one Walrus Memory account (separate programs, same account). That is stated in the output file.
// Usage:
//   node --env-file=.env agent/cross-agent.js --run                real payments, live namespaces, writes data/cross-agent/latest.json
//   node --env-file=.env agent/cross-agent.js --run --wallets=<W1>,<W2>   reuse a group built earlier (skips building it)
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildEnv, sleep } from './common.js';
import { buildTestGroup } from './testGroup.js';
import { mistToSui } from './payer.js';
import { ENDPOINT_BASE } from '../src/providers/ankr.js';

const args = process.argv.slice(2);
if (!args.includes('--run')) { console.error('Usage: node --env-file=.env agent/cross-agent.js --run [--wallets=<W1>,<W2>]'); process.exit(1); }
const given = args.find((a) => a.startsWith('--wallets='))?.split('=')[1]?.split(',');

const { cfg, payer } = buildEnv({ mode: 'live', withPayer: true });
const before = await payer.balance();
console.log(`working wallet balance before: ${mistToSui(before)} SUI`);

let group;
const opt = (n) => args.find((a) => a.startsWith('--' + n + '='))?.split('=')[1];
if (given) group = { w1: given[0], w2: given[1], funder: opt('funder') ?? null, fundingDigest: opt('funding') ?? null, firstFundingDigest: opt('first') ?? null, sponsoredDigests: (opt('sponsored') ?? '').split(',').filter(Boolean), reused: true };
else {
  group = await buildTestGroup({ main: payer, rpcUrl: ENDPOINT_BASE + cfg.ANKR_API_KEY, log: (m) => console.log(m) });
  console.log('waiting 20 s for the explorer data to catch up...');
  await sleep(20000);
}

function runAgent(file, extra) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--env-file=.env', file, ...extra], { stdio: ['ignore', 'pipe', 'inherit'], cwd: fileURLToPath(new URL('..', import.meta.url)) });
    child.on('error', reject);
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.on('close', (code) => {
      const line = out.split('\n').reverse().find((l) => l.startsWith('RESULT '));
      if (!line) return reject(new Error(`${file} gave no RESULT (exit ${code})`));
      resolve({ code, result: JSON.parse(line.slice(7)) });
    });
  });
}

console.log('--- agent A (its own process) ---');
const a = await runAgent('agent/agent-a.js', [group.w1, '--live']);
if (a.code !== 0) throw new Error(`agent A did not finish cleanly (exit ${a.code})`);
console.log('--- agent B (its own process, given only the second wallet) ---');
const b = await runAgent('agent/agent-b.js', [group.w2, '--live']);

const after = await payer.balance();
const spent = before - after;
const ok = b.result.refused && b.result.warnedBy.some((w) => w.memoryId === a.result.memoryId);
const result = {
  ranAt: new Date().toISOString(),
  mode: 'live',
  sharedAccount: true,
  sharedAccountNote: 'Agent A and Agent B run as two separate programs but use one Walrus Memory account and read the same shared space.',
  agentA: { id: a.result.id, address: a.result.address, memoryId: a.result.memoryId, reportedAt: a.result.reportedAt, payment: a.result.payment },
  agentB: { id: b.result.id, address: b.result.address, givenAddresses: b.result.givenAddresses, refusalMemoryId: b.result.refusalMemoryId ?? null, check: b.result.check },
  link: b.result.link ? { type: b.result.link.type, address: b.result.link.address } : null,
  links: b.result.links ?? [],
  testGroup: { builtByUs: true, funder: group.funder, fundingDigest: group.fundingDigest ?? null, firstFundingDigest: group.firstFundingDigest ?? null, sponsoredDigests: group.sponsoredDigests ?? [], note: 'Three wallets we made for this run. Nobody else is involved.' },
  agentBWarnedByAgentA: ok,
  spentMist: spent.toString(),
  spentSui: mistToSui(spent),
};
if (ok) {
  await mkdir(new URL('../data/cross-agent/', import.meta.url), { recursive: true });
  await writeFile(new URL('../data/cross-agent/latest.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
  console.log('wrote data/cross-agent/latest.json');
} else {
  console.log('NOT WRITTEN: agent B was not warned by agent A. Result follows.');
}
console.log(`real SUI spent this run: ${mistToSui(spent)}`);
console.log(`agent A memory: ${result.agentA.memoryId}\nagent A address: ${result.agentA.address}\nagent B address: ${result.agentB.address}\nlink: ${result.link?.type} ${result.link?.address}`);
process.exit(ok ? 0 : 5);
