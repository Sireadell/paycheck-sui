// Builds the real set from the fixed pick rule in docs/METHOD.md ("Real set").
// Usage: node --env-file=.env scripts/build-real-set.js [--minutes=25] [--groups=20] [--controls=20]
// Reads only. Raw answers are cached under data/real-set/raw/cache (not committed); proof answers are saved under data/real-set/raw/proof.
import path from 'node:path';
import { classifyHub } from '../src/engine/exchanges.js';
import { padAddress } from '../src/address.js';
import {
  DIR, PROOF, RULE, FLOOR_CHECKPOINT, TX_FIELDS, makeClients, listFull, payouts, incoming, normalizeTx,
  readJson, writeJson, explorerTx, explorerAddr, tsMs, netStats,
} from './lib/realSetCommon.js';

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? Number(a.split('=')[1]) : d; };
const MINUTES = arg('minutes', 25);
const GROUP_TARGET = arg('groups', RULE.groupTarget);
const CONTROL_TARGET = arg('controls', RULE.controlTarget);
const deadline = Date.now() + MINUTES * 60_000;
const log = (...a) => console.error(...a);
const short = (a) => `${a.slice(0, 8)}...${a.slice(-4)}`;
const hours = (ms) => Math.round((ms / 3_600_000) * 10) / 10;

const { tatum, ankrRpc, post } = makeClients();

const groups = [];
const hubs = [];
const controls = [];
const skipped = { sponsorTooBusy: 0, sponsorSingle: 0, funderTooBusy: 0, funderFewRecipients: 0, funderNoVerifiedPair: 0, controlRejected: {} };
const seen = { sponsor: new Set(), funder: new Set(), control: new Set() };
const used = new Set(); // addresses already part of a group, hub or control
const count = (t) => groups.filter((g) => g.type === t).length;
const rejectControl = (why) => { skipped.controlRejected[why] = (skipped.controlRejected[why] ?? 0) + 1; return null; };
const timeUp = () => Date.now() > deadline;
const done = () => groups.length >= GROUP_TARGET && controls.length >= CONTROL_TARGET;

const timeOrder = (a, b) => a.timestampMs - b.timestampMs;

// ---- gas sponsor candidate ----
async function evalSponsor(S, found) {
  const { txs, complete } = await listFull(tatum, S, RULE.sponsorPages);
  const rows = txs.filter((t) => t.status === 'SUCCESS' && t.gasSponsor === S && t.sender && t.sender !== S)
    .map((t) => ({ sender: t.sender, digest: t.digest, timestamp: t.timestamp, timestampMs: tsMs(t), checkpoint: t.checkpoint }))
    .sort(timeOrder);
  const first = new Map();
  for (const r of rows) if (!first.has(r.sender)) first.set(r.sender, r);
  const touches = rows.map((r) => ({ wallet: r.sender, timestampMs: r.timestampMs }));
  const hub = classifyHub(touches, { capped: !complete });
  if (first.size < 2) { skipped.sponsorSingle++; return; }
  if (hub.verdict.startsWith('shared')) {
    hubs.push({ type: 'gas_sponsor', address: S, wallets: hub.wallets, atLeast: hub.atLeast, spanHours: hours(hub.spanMs), hubHours: hub.hours, historyComplete: complete, engineRule: hub.verdict, probe: [...first.values()][0].sender, probeDigest: [...first.values()][0].digest, discovered: found, note: 'Shared service by the engine rule (15 or more wallets over 25 hours or more). Not counted as a group.' });
    used.add(S);
    return;
  }
  if (!complete) { skipped.sponsorTooBusy++; return; }
  if (count('gas_sponsor') >= RULE.perTypeCap || groups.length >= GROUP_TARGET) return;
  const members = [...first.values()].slice(0, RULE.maxMembers);
  groups.push({
    type: 'gas_sponsor', linkAddress: S,
    members: members.map((m) => ({ address: m.sender, proofDigest: m.digest, timestamp: m.timestamp, checkpoint: m.checkpoint })),
    memberCount: first.size, burst: hub.reason === 'burst',
    observed: { wallets: hub.wallets, spanHours: hours(hub.spanMs), historyComplete: true, engineHubRule: hub.reason },
    reason: `The same wallet (${short(S)}) paid the network fee for ${first.size} different wallets, so they share a gas sponsor. The first ${members.length} are listed with the fee-paid transaction for each.`,
    discovered: found,
  });
  used.add(S);
  for (const m of members) used.add(m.sender);
  log(`  GROUP ${groups.length}: gas sponsor ${short(S)} wallets ${first.size}`);
}

// ---- funder candidate ----
async function evalFunder(F, found, preListed = null) {
  const { txs, complete } = preListed ?? await listFull(tatum, F);
  const pays = payouts(F, txs).sort(timeOrder);
  const firstPay = new Map();
  for (const p of pays) if (!firstPay.has(p.recipient)) firstPay.set(p.recipient, p);
  if (firstPay.size < 2) { skipped.funderFewRecipients++; return; }
  const hub = classifyHub(pays.map((p) => ({ wallet: p.recipient, timestampMs: p.timestampMs })), { capped: !complete });
  if (hub.verdict.startsWith('shared')) {
    hubs.push({ type: 'shared_funder', address: F, wallets: hub.wallets, atLeast: hub.atLeast, spanHours: hours(hub.spanMs), hubHours: hub.hours, historyComplete: complete, engineRule: hub.verdict, probe: [...firstPay.keys()][0], probeDigest: [...firstPay.values()][0].digest, discovered: found, note: 'Shared service by the engine rule (15 or more wallets over 25 hours or more). Not counted as a group.' });
    used.add(F);
    return;
  }
  if (!complete) { skipped.funderTooBusy++; return; }
  if (count('shared_funder') >= RULE.perTypeCap || groups.length >= GROUP_TARGET) return;
  const verified = [];
  for (const [r, p] of [...firstPay].slice(0, RULE.maxFunderRecipients)) {
    if (r === F || used.has(r)) continue;
    const rl = await listFull(tatum, r, 1);
    const inc = incoming(r, rl.txs)[0];
    // The payment must be the first thing in the recipient's own history, and the history must be read from its start.
    if (inc && inc.digest === p.digest && rl.txs[0]?.digest === p.digest) verified.push({ address: r, ...p });
  }
  verified.sort(timeOrder);
  let best = [];
  for (let i = 0; i < verified.length; i++) {
    const win = verified.filter((v) => v.timestampMs >= verified[i].timestampMs && v.timestampMs - verified[i].timestampMs <= RULE.windowMs);
    if (win.length > best.length) best = win;
  }
  if (best.length < 2) { skipped.funderNoVerifiedPair++; return; }
  const members = best.slice(0, RULE.maxMembers);
  const span = best[best.length - 1].timestampMs - best[0].timestampMs;
  groups.push({
    type: 'shared_funder', linkAddress: F,
    members: members.map((m) => ({ address: m.address, proofDigest: m.digest, timestamp: m.timestamp, checkpoint: m.checkpoint })),
    memberCount: best.length, burst: false,
    observed: { wallets: hub.wallets, spanHours: hours(hub.spanMs), historyComplete: true, engineHubRule: hub.reason, firstFundingsWithin24h: best.length, firstFundingSpanHours: hours(span) },
    reason: `The same wallet (${short(F)}) sent the first SUI to ${best.length} new wallets within ${Math.max(1, Math.ceil(hours(span)))} hour(s). Each listed payment is the earliest thing in that wallet's history.`,
    discovered: found,
  });
  used.add(F);
  for (const m of members) used.add(m.address);
  log(`  GROUP ${groups.length}: funder ${short(F)} wallets ${best.length}`);
}

// ---- new-wallet candidate: a recipient of a plain SUI payment. It becomes a funder group or a control on facts only ----
async function evalRecipient(W, found) {
  const { txs, complete } = await listFull(tatum, W, 1);
  if (!complete) return rejectControl('history longer than 50');
  if (!txs.length) return rejectControl('no history');
  const first = incoming(W, txs)[0];
  if (!first) return rejectControl('no incoming SUI');
  if (txs[0].digest !== first.digest) return rejectControl('first thing in history is not the funding');
  const F = first.sender;
  if (used.has(F)) return rejectControl('funder already used');
  const fl = await listFull(tatum, F);
  const pays = payouts(F, fl.txs);
  const near = new Set(pays.filter((p) => p.recipient !== W && Math.abs(p.timestampMs - first.timestampMs) <= RULE.windowMs).map((p) => p.recipient));
  if (near.size > 0) {
    seen.funder.add(F);
    if (groups.length < GROUP_TARGET && count('shared_funder') < RULE.perTypeCap) await evalFunder(F, found, fl);
    return null;
  }
  if (controls.length >= CONTROL_TARGET) return null;
  if (!fl.complete) return rejectControl('funder history longer than 200');
  if (txs.some((t) => t.sponsored || (t.gasSponsor === W && t.sender !== W))) return rejectControl('involved in sponsored gas');
  const hub = classifyHub(pays.map((p) => ({ wallet: p.recipient, timestampMs: p.timestampMs })), {});
  if (hub.verdict.startsWith('shared') || hub.wallets >= 15) return rejectControl('funder is a shared service or fan-out');
  controls.push({
    address: W, funder: F, fundingDigest: first.digest, fundingTimestamp: first.timestamp, fundingCheckpoint: first.checkpoint,
    historyTransactions: txs.length, funderDistinctRecipients: hub.wallets,
    reason: `Whole history is ${txs.length} transactions, first SUI came from ${short(F)}, which paid no other wallet within 24 hours of that payment, and nobody sponsored its gas.`,
    discovered: found,
  });
  used.add(W);
  log(`  CONTROL ${controls.length}: ${short(W)}`);
  return null;
}

// ---- walk the fixed checkpoint sample ----
async function sampleBlock(indices) {
  const cps = indices.map((i) => RULE.startCheckpoint - i * RULE.step);
  const q = '{' + cps.map((c, k) => `c${k}: checkpoint(sequenceNumber:${c}){ sequenceNumber timestamp transactions(first:${RULE.takePerCheckpoint}){ nodes{ ${TX_FIELDS.replace('balanceChanges(first:50)', 'balanceChanges(first:6)')} } } }`).join(' ') + '}';
  const d = await post(q);
  return cps.map((c, k) => ({ checkpoint: c, index: indices[k], timestamp: d[`c${k}`]?.timestamp ?? null, txs: (d[`c${k}`]?.transactions?.nodes ?? []).map(normalizeTx).filter((t) => t.status === 'SUCCESS') }));
}

let sampled = 0;
let stopReason = 'sample ended';
try {
  outer:
  for (let b = 0; b * RULE.block < RULE.maxSamples; b++) {
    const idx = Array.from({ length: RULE.block }, (_, i) => b * RULE.block + i).filter((i) => i < RULE.maxSamples);
    const block = await sampleBlock(idx);
    for (const cp of block) {
      sampled++;
      if (cp.checkpoint < FLOOR_CHECKPOINT) { stopReason = 'reached data floor'; break outer; }
      for (const t of cp.txs) {
        const found = { checkpoint: cp.checkpoint, sampleIndex: cp.index, digest: t.digest };
        if (timeUp()) { stopReason = 'time box'; break outer; }
        if (done()) { stopReason = 'targets reached'; break outer; }
        if (t.sponsored && !seen.sponsor.has(t.gasSponsor)) {
          seen.sponsor.add(t.gasSponsor);
          if (groups.length < GROUP_TARGET && count('gas_sponsor') < RULE.perTypeCap) await evalSponsor(t.gasSponsor, found);
        }
        // New-wallet candidates: receivers of a plain SUI payment (every balance change is SUI, the sender is the only payer, 1 to 4 receivers, no sponsor).
        const bc = t.balanceChanges;
        if (!t.sponsored && bc.length >= 2 && bc.length <= 5 && bc.every((x) => x.coin?.endsWith("::sui::SUI") && x.owner)) {
          const neg = bc.filter((x) => BigInt(x.amount) < 0n);
          if (neg.length === 1 && neg[0].owner === t.sender) {
            for (const pos of bc.filter((x) => BigInt(x.amount) > 0n && x.owner !== t.sender)) {
              if (seen.control.has(pos.owner) || used.has(pos.owner)) continue;
              seen.control.add(pos.owner);
              if (groups.length < GROUP_TARGET || controls.length < CONTROL_TARGET) await evalRecipient(pos.owner, found);
            }
          }
        }
      }
    }
    log(`block ${b + 1} done: sampled ${sampled} checkpoints, groups ${groups.length}, controls ${controls.length}, hubs ${hubs.length}, network calls ${netStats.network}, cached ${netStats.cached}`);
  }
} catch (e) {
  if (e.code === 'NETWORK_GIVE_UP') { console.error(`STOPPED: ${e.message}`); }
  else console.error(`STOPPED: ${e.stack}`);
  process.exitCode = 2;
  stopReason = `error: ${e.message}`;
}

// ---- remove controls that turned out to be a group member or funder found later; then fetch proof answers ----
const clash = new Set(groups.flatMap((g) => [g.linkAddress, ...g.members.map((m) => m.address)]));
const cleanControls = controls.filter((c) => !clash.has(c.address) && !clash.has(c.funder));

const TX_Q = (d) => `{ transaction(digest:"${d}") { ${TX_FIELDS} } }`;
async function fetchProof(digest, expectSender) {
  const tRaw = await post(TX_Q(digest));
  const t = tRaw.transaction ? normalizeTx(tRaw.transaction) : null;
  let aRaw = null;
  let agree = null;
  if (ankrRpc) {
    try {
      aRaw = await ankrRpc('sui_getTransactionBlock', [digest, { showInput: true, showEffects: true, showBalanceChanges: true }]);
      const d = aRaw?.result?.transaction?.data;
      if (d && t) agree = d.sender?.toLowerCase() === t.sender && (d.gasData?.owner?.toLowerCase() ?? d.sender?.toLowerCase()) === t.gasSponsor && String(aRaw.result.effects?.status?.status ?? '').toUpperCase() === t.status;
    } catch (e) { aRaw = { error: String(e.message).slice(0, 100) }; }
  }
  writeJson(path.join(PROOF, `${digest}.json`), { digest, savedFor: expectSender ?? null, tatum: tRaw, ankr: aRaw, ankrAgrees: agree });
  return { tx: t, agree };
}

for (const g of groups) {
  for (const m of g.members) {
    const { tx, agree } = await fetchProof(m.proofDigest, m.address);
    m.ankrAgrees = agree;
    m.explorer = explorerTx(m.proofDigest);
    // Re-read check on the fact itself: gas sponsor groups need sponsor = link address; funder groups need the link address as sender paying the member.
    m.verified = g.type === 'gas_sponsor'
      ? Boolean(tx && tx.sender === m.address && tx.gasSponsor === g.linkAddress && tx.status === 'SUCCESS')
      : Boolean(tx && tx.sender === g.linkAddress && tx.balanceChanges.some((b) => b.owner === m.address && BigInt(b.amount) > 0n));
  }
  g.linkExplorer = explorerAddr(g.linkAddress);
  g.verifiedAll = g.members.every((m) => m.verified);
}
for (const c of cleanControls) {
  const { tx, agree } = await fetchProof(c.fundingDigest, c.address);
  c.ankrAgrees = agree;
  c.explorer = explorerTx(c.fundingDigest);
  c.verified = Boolean(tx && tx.sender === c.funder && tx.balanceChanges.some((b) => b.owner === c.address && BigInt(b.amount) > 0n));
}
const goodGroups = groups.filter((g) => g.verifiedAll);
const droppedGroups = groups.length - goodGroups.length;
const goodControls = cleanControls.filter((c) => c.verified);

const stamp = new Date().toISOString();
const label = 'real set: real mainnet facts we verified by script against two providers (Tatum and Ankr)';
goodGroups.forEach((g, i) => { g.id = `rs-${String(i + 1).padStart(2, '0')}`; g.probe = [...g.members].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0].address; g.label = label; });
goodControls.forEach((c, i) => { c.id = `rc-${String(i + 1).padStart(2, '0')}`; c.label = label; });

const meta = { builtAt: stamp, rule: RULE, sampledCheckpoints: sampled, stopReason, skipped, droppedGroupsFailedRecheck: droppedGroups, dataFloorCheckpoint: FLOOR_CHECKPOINT };
writeJson(path.join(DIR, 'groups.json'), { label, meta, groups: goodGroups, sharedServices: hubs });
writeJson(path.join(DIR, 'controls.json'), { label, meta, controls: goodControls });

console.log(`built ${stamp}`);
console.log(`stop reason: ${stopReason}; sampled checkpoints ${sampled}`);
console.log(`groups ${goodGroups.length} (gas sponsor ${goodGroups.filter((g) => g.type === 'gas_sponsor').length}, shared funder ${goodGroups.filter((g) => g.type === 'shared_funder').length}), dropped after re-check ${droppedGroups}`);
console.log(`controls ${goodControls.length}`);
console.log(`shared services found ${hubs.length}`);
console.log(`skipped ${JSON.stringify(skipped)}`);
console.log(`calls: network ${netStats.network}, from cache ${netStats.cached}`);
process.exit(process.exitCode ?? 0);
