// Agent B. It is asked to pay a wallet. It never sees any address Agent A dealt with: its only input is the one wallet below.
// Usage: node --env-file=.env agent/agent-b.js <wallet> [--live]
//   --live   reads the live namespaces and writes its refusal to the agent-b namespace. Without it: test namespace.
// B holds no signing key at all: if the check says pay it only reports that it would pay. The last line is RESULT {json}.
import { createSafePay, PayCheckRefused } from './safePay.js';
import { buildEnv } from './common.js';

const args = process.argv.slice(2);
const wallet = args.find((a) => !a.startsWith('--'));
const live = args.includes('--live');
if (!wallet) { console.error('Usage: node --env-file=.env agent/agent-b.js <wallet> [--live]'); process.exit(1); }

const AGENT = 'agent-b';
const { memory, checker } = buildEnv({ mode: live ? 'live' : 'test' });
const safePay = createSafePay({ checker, memory, agentId: AGENT, dryRun: true, refusalNamespace: live ? 'agent-b' : 'k2-test', refusalOrigin: live ? 'agent-b' : 'k2-test' });

const linkOf = (evidence) => {
  const l = (evidence ?? []).find((e) => e.kind === 'link' && (e.type === 'shared_funder' || e.type === 'gas_sponsor'));
  return l ? { type: l.type === 'gas_sponsor' ? 'gas_sponsor' : 'funder', address: l.address } : null;
};
const links = (evidence) => (evidence ?? []).filter((e) => e.kind === 'link').map((e) => ({ type: e.type === 'gas_sponsor' ? 'gas_sponsor' : e.type === 'shared_funder' ? 'funder' : e.type, address: e.address ?? null }));
const tell = (c) => (c.type === 'gas_sponsor' ? 'gas sponsor' : 'first funder');

let out;
try {
  const r = await safePay(wallet, '0.001');
  console.log(`${AGENT}: ${r.verdict}, nothing in memory stops this payment (${r.code})`);
  out = { id: AGENT, address: r.payee, refused: false, check: r.check };
} catch (e) {
  if (!(e instanceof PayCheckRefused)) throw e;
  const w = e.warnedBy[0];
  const link = linkOf(e.evidence);
  console.log(`${AGENT}: ${e.verdict}, warned by ${w?.reporter ?? 'unknown'} memory ${w?.memoryId ?? e.memoryIds[0]}${link ? `, link: ${tell(link)} ${link.address}` : ''}`);
  console.log(`${AGENT}: ${e.checkCode}. ${e.reason} Refusal saved as memory ${e.refusalMemory.id ?? 'NOT SAVED'}. Nothing was sent.`);
  out = { id: AGENT, address: e.payee, refused: true, refusalMemoryId: e.refusalMemory.id, checkCode: e.checkCode, reason: e.reason, warnedBy: e.warnedBy, memoryIds: e.memoryIds, link, links: links(e.evidence), check: { verdict: e.check.verdict, code: e.check.code, label: e.check.label, reason: e.check.reason, warnedBy: e.check.warnedBy, withoutMemory: e.check.withoutMemory, memoryIds: e.check.memoryIds } };
}
console.log(`${AGENT}: addresses this agent was given: ${wallet}`);
await memory.flush();
memory.destroy();
console.log(`RESULT ${JSON.stringify({ ...out, givenAddresses: [wallet] })}`);
process.exit(out.refused ? 0 : 4);
