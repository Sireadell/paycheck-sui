// The mainnet stress test on wallets we built (synthetic, kept apart from the real set).
// node --env-file=.env scripts/stress-test.js --dry-run              prints the plan and the most it can cost, sends nothing
// node --env-file=.env scripts/stress-test.js --build [--groups=20 --controls=20 --max-spend=3.5]
//     builds the wallets on mainnet and writes the answer key to data/stress/key.json. The checker is NOT run here.
// node --env-file=.env scripts/stress-test.js --check                reads the saved key, runs the checker (memory off, depth 50), writes the results
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { createChecker } from '../src/check.js';
import { createTatum } from '../src/providers/tatum.js';
import { ENDPOINT_BASE } from '../src/providers/ankr.js';
import { loadConfig } from '../src/config.js';
import { createSuiPayer, keypairFromSecret, mistToSui } from '../agent/payer.js';
import { LABEL, planStress, estimateMist, buildStress, scoreStress } from './lib/stress.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'stress');
const KEY = path.join(DIR, 'key.json');
const args = process.argv.slice(2);
const opt = (n, d) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const write = (p, v) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };

// Memory is OFF: the checker gets a memory that remembers nothing and stores nothing.
const noMemory = { recall: async () => [], enqueue: () => ({ state: 'none', key: null }), write: async () => ({ state: 'none' }), markChanged() {}, flush: async () => {}, destroy() {} };
const slim = (r) => ({
  address: r.address, verdict: r.verdict, code: r.code,
  links: (r.evidence ?? []).filter((e) => e.kind === 'link').map((e) => ({ type: e.type, address: e.address ?? null, wallets: e.wallets ?? null })),
  weakLinks: (r.evidence ?? []).filter((e) => e.kind === 'weak_link').map((e) => ({ type: e.type, address: e.address ?? null, note: e.note })),
  roundTrip: (r.evidence ?? []).some((e) => e.kind === 'round_trip' && e.counted),
  notes: r.notes ?? [],
});

if (args.includes('--dry-run')) {
  const plan = planStress({ groups: Number(opt('groups', 20)), controls: Number(opt('controls', 20)) });
  const members = plan.groups.reduce((s, g) => s + g.size, 0);
  console.log(`groups ${plan.groups.length} (${members} wallets), controls ${plan.controls.length}, most it can cost ${mistToSui(estimateMist(plan))} SUI, 0 sent`);
  process.exit(0);
}

if (args.includes('--build')) {
  if (existsSync(KEY) && !args.includes('--force')) { console.error('data/stress/key.json already exists. Refusing to build a second set (use --force).'); process.exit(1); }
  const cfg = loadConfig();
  const keypair = keypairFromSecret(cfg.SUI_WALLET_PRIVATE_KEY);
  if (cfg.SUI_WALLET_ADDRESS && keypair.toSuiAddress() !== cfg.SUI_WALLET_ADDRESS.toLowerCase()) throw new Error('SUI_WALLET_PRIVATE_KEY does not match SUI_WALLET_ADDRESS');
  const rpc = new SuiJsonRpcClient({ url: ENDPOINT_BASE + cfg.ANKR_API_KEY, network: 'mainnet' });
  const before = await createSuiPayer({ keypair, client: rpc }).balance();
  const maxSpend = BigInt(Math.round(Number(opt('max-spend', 3.5)) * 1e9));
  const plan = planStress({ groups: Number(opt('groups', 20)), controls: Number(opt('controls', 20)) });
  if (estimateMist(plan) > maxSpend) throw new Error(`Plan could cost ${mistToSui(estimateMist(plan))} SUI, over the cap`);
  // The payer's reserve floor keeps the wallet from ever spending past the cap.
  const main = createSuiPayer({ keypair, client: rpc, reserveMist: before - maxSpend });
  console.log(`balance before ${mistToSui(before)} SUI`);
  const key = await buildStress({ main, rpc, plan, log: (m) => console.log(m) });
  const after = await main.balance();
  key.spentMist = (before - after).toString();
  key.spentSui = mistToSui(before - after);
  key.rule = 'A wallet counts as found when its check shows a counted link to the funder written here. A control counts as a false alarm when its check is anything other than "no links, no bad history".';
  write(KEY, key);
  console.log(`built ${key.groups.length} groups (${key.groups.reduce((s, g) => s + g.members.length, 0)} wallets) and ${key.controls.length} controls; key saved; spent ${key.spentSui} SUI`);
  console.log(`sponsored transactions: ${key.groups.reduce((s, g) => s + g.sponsoredDigests.length, 0)} confirmed, ${key.groups.reduce((s, g) => s + g.sponsorFailures, 0)} failed`);
  process.exit(0);
}

if (args.includes('--check')) {
  if (!existsSync(KEY)) { console.error('No data/stress/key.json. Run --build first.'); process.exit(1); }
  const key = JSON.parse(readFileSync(KEY, 'utf8'));
  const cfg = loadConfig();
  const tatum = createTatum({ key: cfg.TATUM_API_KEY_MAINNET });
  const checker = createChecker({ tatum, ankr: null, memory: noMemory, mode: 'live', maxTx: 50 });
  const check = async (address) => {
    for (let i = 0; i < 3; i++) {
      const r = await checker.check(address, { memoryOn: false });
      if (r.code !== 'DATA_UNAVAILABLE') return slim(r);
      await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
    }
    return slim(await checker.check(address, { memoryOn: false }));
  };
  const addrs = [...key.groups.flatMap((g) => g.members), ...key.controls.map((c) => c.address)];
  const results = [];
  for (const a of addrs) { results.push(await check(a)); if (results.length % 10 === 0) console.error(`checked ${results.length} of ${addrs.length}`); }
  const s = scoreStress(key, results);
  const ranAt = new Date().toISOString();
  write(path.join(DIR, 'results.json'), { label: LABEL, ranAt, memory: 'off', depth: 50, ...s, results });
  // The numbers the proof page and the blog read.
  const summary = { caught: s.caught, total: s.total, falseAlarms: s.falseAlarms, controls: s.controls, label: LABEL, ranAt };
  write(path.join(DIR, 'stress.json'), summary);
  write(path.join(ROOT, 'bench', 'results', 'stress.json'), summary);
  console.log(`${LABEL}`);
  console.log(`found ${s.caught} of ${s.total} wallets in ${s.groups} groups; groups with at least one wallet found ${s.groupsWithAnyMemberCaught} of ${s.groups}`);
  console.log(`false alarms ${s.falseAlarms} of ${s.controls} controls`);
  for (const m of s.misses) console.log(`miss ${m.group} ${m.type} ${m.address}: ${m.code}${m.notes.length ? ` (${m.notes.join(' ')})` : ''}`);
  for (const a of s.falseAlarmRows) console.log(`false alarm ${a.id} ${a.address}: ${a.code}`);
  process.exit(0);
}

console.error('Usage: scripts/stress-test.js --dry-run | --build | --check');
process.exit(1);
