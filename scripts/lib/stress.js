// The mainnet stress test: groups of wallets that WE build, with the answer written down before the checker runs.
// Everything here is synthetic. These are wallets we created, not real-world cases. Keys live in memory only.
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createSuiPayer } from '../../agent/payer.js';
import { sponsoredNoop } from '../../agent/testGroup.js';

export const LABEL = 'Synthetic stress test: wallets we built on Sui mainnet ourselves, not real-world cases';
const lc = (a) => String(a ?? '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAS_HEADROOM = 12_000_000n; // the payer refuses to send unless the sender keeps this much for gas

/** Plain plan, fixed and written down. Sizes stay under the shared-service limit (15 wallets). */
export function planStress({ groups = 20, controls = 20 } = {}) {
  const types = ['funder', 'funder_sponsor', 'round_trip', 'funder'];
  const sizes = [3, 4, 5, 3, 4, 6];
  const g = Array.from({ length: groups }, (_, i) => ({ id: `sg-${String(i + 1).padStart(2, '0')}`, type: types[i % types.length], size: sizes[i % sizes.length] }));
  const c = Array.from({ length: controls }, (_, i) => ({ id: `sc-${String(i + 1).padStart(2, '0')}`, outgoing: i % 2 === 1 }));
  return { groups: g, controls: c };
}

// Share amounts differ by well over 2% between wallets so nothing looks like a copy-paste payout.
const shareFor = (n, round) => (round ? 14_000_000n : 2_000_000n) + BigInt(n) * 150_000n;
const sumOf = (a) => a.reduce((x, y) => x + y, 0n);

/** What the plan will cost at most, in mist (money moved plus a generous gas allowance). */
export function estimateMist(plan) {
  let total = 0n;
  let n = 0;
  for (const g of plan.groups) {
    const shares = sumOf(Array.from({ length: g.size }, () => shareFor(n++, g.type === 'round_trip')));
    total += shares + GAS_HEADROOM;
  }
  for (const c of plan.controls) total += shareFor(n++, false) + GAS_HEADROOM + (c.outgoing ? 2_000_000n : 0n);
  return total + 20_000_000n; // the working wallet's own gas
}

async function waitFor(fn, tries = 40, waitMs = 2000) {
  for (let i = 0; i < tries; i++) { if (await fn()) return true; await sleep(waitMs); }
  return false;
}

/** Runs jobs with at most `limit` in flight. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * Builds the whole set on mainnet. main: a payer for the working wallet. rpc: a Sui JSON-RPC client.
 * Returns the answer key (addresses and digests only, never a key).
 */
export async function buildStress({ main, rpc, plan, log = () => {}, concurrency = 3, keygen = () => Ed25519Keypair.generate(), waitMs = 2000 }) {
  const fundersG = plan.groups.map(() => keygen());
  const fundersC = plan.controls.map(() => keygen());
  let n = 0;
  const gShares = plan.groups.map((g) => Array.from({ length: g.size }, () => shareFor(n++, g.type === 'round_trip')));
  const cShares = plan.controls.map(() => shareFor(n++, false));

  // The working wallet funds every funder, ten at a time in one transaction each.
  const fundItems = [
    ...plan.groups.map((g, i) => ({ to: fundersG[i].toSuiAddress(), amountMist: sumOf(gShares[i]) + GAS_HEADROOM })),
    ...plan.controls.map((c, i) => ({ to: fundersC[i].toSuiAddress(), amountMist: cShares[i] + GAS_HEADROOM + (c.outgoing ? 2_000_000n : 0n) })),
  ];
  const fundDigests = [];
  for (let i = 0; i < fundItems.length; i += 10) {
    let r = null;
    for (let t = 0; t < 4 && !r; t++) {
      try { r = await main.payMany(fundItems.slice(i, i + 10)); } catch (e) { log('funding batch retry: ' + String(e.message || e).slice(0, 100)); await sleep(waitMs * 3); }
    }
    if (!r) throw new Error('Funding batch failed four times');
    await sleep(waitMs * 3); // let the node catch up on the working wallet's coin versions
    fundDigests.push(r.digest);
    log(`funded funders ${i + 1} to ${Math.min(i + 10, fundItems.length)}: ${r.digest}`);
  }

  const groups = await pool(plan.groups, concurrency, async (g, gi) => {
    const f = fundersG[gi];
    const fp = createSuiPayer({ keypair: f, client: rpc });
    await waitFor(async () => (await fp.balance()) >= sumOf(gShares[gi]) + GAS_HEADROOM, 40, waitMs);
    const members = Array.from({ length: g.size }, () => keygen());
    const first = await fp.payMany(members.map((m, i) => ({ to: m.toSuiAddress(), amountMist: gShares[gi][i] })));
    const row = { id: g.id, type: g.type, funder: f.toSuiAddress(), members: members.map((m) => m.toSuiAddress()), firstFundingDigest: first.digest, sponsoredDigests: [], roundTripDigests: [], sponsorFailures: 0 };
    if (g.type === 'funder_sponsor') {
      // The sponsor path can fail on a stale coin version, so each wallet gets two tries and failures are counted.
      for (const m of members) {
        let ok = false;
        for (let t = 0; t < 2 && !ok; t++) {
          try { row.sponsoredDigests.push(await sponsoredNoop(rpc, m, f)); ok = true; } catch { await sleep(waitMs); }
        }
        if (!ok) row.sponsorFailures++;
      }
    }
    if (g.type === 'round_trip') {
      // The first two wallets send some of their SUI straight back to the funder (they hold enough to pay the gas floor).
      for (let i = 0; i < Math.min(2, members.length); i++) {
        const mp = createSuiPayer({ keypair: members[i], client: rpc });
        await waitFor(async () => (await mp.balance()) >= gShares[gi][i], 40, waitMs);
        const back = await mp.pay(f.toSuiAddress(), 3_000_000n + 500_000n * BigInt(i));
        row.roundTripDigests.push(back.digest);
      }
    }
    log(`group ${g.id} (${g.type}) built: ${members.length} wallets, funder ${row.funder}`);
    return row;
  });

  const controls = await pool(plan.controls, concurrency, async (c, ci) => {
    const f = fundersC[ci];
    const fp = createSuiPayer({ keypair: f, client: rpc });
    await waitFor(async () => (await fp.balance()) >= cShares[ci] + GAS_HEADROOM, 40, waitMs);
    const w = keygen();
    const first = await fp.pay(w.toSuiAddress(), cShares[ci]);
    const row = { id: c.id, address: w.toSuiAddress(), funder: f.toSuiAddress(), firstFundingDigest: first.digest, outgoingDigest: null };
    if (c.outgoing) {
      // An ordinary wallet that also spends: one payment to a fresh address that has nothing to do with its funder.
      const wp = createSuiPayer({ keypair: w, client: rpc });
      await waitFor(async () => (await wp.balance()) >= cShares[ci], 40, waitMs);
      row.outgoingDigest = (await wp.pay(keygen().toSuiAddress(), 500_000n)).digest;
    }
    log(`control ${c.id} built: ${row.address}`);
    return row;
  });
  return { label: LABEL, builtAt: new Date().toISOString(), fundDigests, groups, controls };
}

/** Counts a finished run. A wallet is caught when its check shows a link to the funder written in the key. */
export function scoreStress(key, results) {
  const byAddr = new Map(results.map((r) => [lc(r.address), r]));
  const rows = key.groups.flatMap((g) => g.members.map((m) => {
    const r = byAddr.get(lc(m));
    const caught = Boolean(r?.links?.some((l) => lc(l.address) === lc(g.funder)));
    return { group: g.id, type: g.type, address: m, caught, code: r?.code ?? null, verdict: r?.verdict ?? null, roundTrip: Boolean(r?.roundTrip), notes: r?.notes ?? [] };
  }));
  const ctrl = key.controls.map((c) => {
    const r = byAddr.get(lc(c.address));
    const alarm = !r || r.code !== 'NO_LINKS_NO_BAD_HISTORY' || (r.links ?? []).length > 0;
    return { id: c.id, address: c.address, falseAlarm: alarm, code: r?.code ?? null, verdict: r?.verdict ?? null };
  });
  return {
    caught: rows.filter((r) => r.caught).length,
    total: rows.length,
    falseAlarms: ctrl.filter((c) => c.falseAlarm).length,
    controls: ctrl.length,
    groups: key.groups.length,
    groupsWithAnyMemberCaught: key.groups.filter((g) => rows.some((r) => r.group === g.id && r.caught)).length,
    misses: rows.filter((r) => !r.caught),
    falseAlarmRows: ctrl.filter((c) => c.falseAlarm),
    memberRows: rows,
    controlRows: ctrl,
  };
}
