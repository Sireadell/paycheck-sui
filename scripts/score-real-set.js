// Runs the real engine with memory OFF on every case of the real set and prints the catch rate and false alarm rate.
// Usage: node --env-file=.env scripts/score-real-set.js [--rerun]
// First run reads the chain (cached under data/real-set/raw/cache) and saves data/real-set/results.json.
// Later runs print from the saved file. --rerun runs the engine again.
import path from 'node:path';
import { createChecker } from '../src/check.js';
import { DIR, makeClients, readJson, writeJson } from './lib/realSetCommon.js';

const NO_LINKS = 'NO_LINKS_NO_BAD_HISTORY';
const resultsFile = path.join(DIR, 'results.json');
const groupsFile = readJson(path.join(DIR, 'groups.json'));
const controlsFile = readJson(path.join(DIR, 'controls.json'));
if (!groupsFile || !controlsFile) { console.error('Missing data/real-set/groups.json or controls.json. Run scripts/build-real-set.js first.'); process.exit(1); }

// Memory is OFF: the checker gets a memory that remembers nothing and stores nothing.
const noMemory = { recall: async () => [], enqueue: () => ({ state: 'none', key: null }), write: async () => ({ state: 'none' }), markChanged() {}, flush: async () => {}, destroy() {} };

const lc = (a) => String(a ?? '').toLowerCase();
const slim = (r) => ({
  address: r.address, verdict: r.verdict, code: r.code, label: r.label,
  links: (r.evidence ?? []).filter((e) => e.kind === 'link').map((e) => ({ type: e.type, address: e.address ?? null, wallets: e.wallets ?? null })),
  weakLinks: (r.evidence ?? []).filter((e) => e.kind === 'weak_link').map((e) => ({ type: e.type, address: e.address ?? null, note: e.note })),
  roundTrip: (r.evidence ?? []).some((e) => e.kind === 'round_trip' && e.counted),
  notes: r.notes ?? [], tatumCalls: r.callLog?.tatum?.calls ?? null,
});

async function run() {
  const { tatum } = makeClients({ withAnkr: false });
  const checker = createChecker({ tatum, ankr: null, memory: noMemory, mode: 'live' });
  const check = async (address) => {
    for (let i = 0; i < 3; i++) {
      const r = await checker.check(address, { memoryOn: false });
      if (r.code !== 'DATA_UNAVAILABLE') return slim(r);
      await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
    }
    return slim(await checker.check(address, { memoryOn: false }));
  };
  const out = { ranAt: new Date().toISOString(), memory: 'off', label: groupsFile.label, groups: [], controls: [], sharedServices: [] };

  for (const g of groupsFile.groups) {
    const members = [];
    for (const m of g.members) members.push(await check(m.address));
    const caughtBy = (r) => r.links.some((l) => lc(l.address) === lc(g.linkAddress));
    const probe = members.find((r) => lc(r.address) === lc(g.probe)) ?? members[0];
    const caught = caughtBy(probe);
    const row = { id: g.id, type: g.type, linkAddress: g.linkAddress, probe: g.probe, caught, membersCaught: members.filter(caughtBy).length, members: members.length, probeResult: probe, memberResults: members };
    if (!caught) {
      const weak = probe.weakLinks.find((w) => lc(w.address) === lc(g.linkAddress));
      row.missReason = weak ? `engine read the link as a weak link: ${weak.note}` : probe.code === 'DATA_UNAVAILABLE' ? 'chain data could not be read' : `engine showed no link to the recorded ${g.type === 'gas_sponsor' ? 'gas sponsor' : 'funder'}${probe.notes.length ? ` (${probe.notes.join(' ')})` : ''}`;
    }
    out.groups.push(row);
    console.error(`group ${g.id} ${g.type}: ${caught ? 'caught' : 'MISSED'} (${row.membersCaught} of ${row.members} members)`);
  }

  for (const c of controlsFile.controls) {
    const r = await check(c.address);
    const alarm = r.code !== NO_LINKS || r.links.length > 0;
    const row = { id: c.id, address: c.address, falseAlarm: alarm, result: r };
    if (alarm) row.alarmReason = r.code === 'ROUND_TRIP_TO_FUNDER' ? 'sent money back to its funder (caution)' : r.links.length ? `engine showed a counted link (${r.links.map((l) => l.type).join(', ')})` : `answer was ${r.code}`;
    out.controls.push(row);
    console.error(`control ${c.id}: ${alarm ? 'FALSE ALARM' : 'clean'}`);
  }

  for (const h of groupsFile.sharedServices ?? []) {
    const r = await check(h.probe);
    const weak = r.weakLinks.find((w) => lc(w.address) === lc(h.address));
    const counted = r.links.find((l) => lc(l.address) === lc(h.address));
    out.sharedServices.push({ type: h.type, address: h.address, observedWallets: h.wallets, atLeast: h.atLeast, observedSpanHours: h.spanHours, engineCalledSharedService: Boolean(weak), engineCountedAsLink: Boolean(counted), probe: h.probe, code: r.code });
    console.error(`shared service ${h.address.slice(0, 10)}: engine says ${weak ? 'shared service' : counted ? 'counted link' : 'nothing'}`);
  }
  out.summary = summarize(out);
  writeJson(resultsFile, out);
  return out;
}

function summarize(out) {
  const g = out.groups;
  const c = out.controls;
  return {
    realGroups: g.length, groupsCaught: g.filter((x) => x.caught).length,
    memberWalletsChecked: g.reduce((s, x) => s + x.members, 0), memberWalletsCaught: g.reduce((s, x) => s + x.membersCaught, 0),
    caughtBySponsor: g.filter((x) => x.type === 'gas_sponsor' && x.caught).length, sponsorGroups: g.filter((x) => x.type === 'gas_sponsor').length,
    caughtByFunder: g.filter((x) => x.type === 'shared_funder' && x.caught).length, funderGroups: g.filter((x) => x.type === 'shared_funder').length,
    controls: c.length, falseAlarms: c.filter((x) => x.falseAlarm).length,
  };
}

let out = readJson(resultsFile);
if (!out || process.argv.includes('--rerun')) out = await run();
const s = out.summary;

console.log(`${out.label}; memory ${out.memory}; engine run ${out.ranAt}`);
console.log(`real groups ${s.realGroups}, caught ${s.groupsCaught} of ${s.realGroups}, controls ${s.controls}, false alarms ${s.falseAlarms} of ${s.controls}`);
console.log(`by link type: gas sponsor ${s.caughtBySponsor} of ${s.sponsorGroups}, shared funder ${s.caughtByFunder} of ${s.funderGroups}`);
console.log(`every member wallet: caught ${s.memberWalletsCaught} of ${s.memberWalletsChecked}`);
const misses = out.groups.filter((x) => !x.caught);
console.log(`misses (${misses.length}):`);
for (const m of misses) console.log(`  ${m.id} ${m.type} link ${m.linkAddress.slice(0, 12)}... probe ${m.probe.slice(0, 12)}...: ${m.missReason}`);
const alarms = out.controls.filter((x) => x.falseAlarm);
console.log(`false alarms (${alarms.length}):`);
for (const a of alarms) console.log(`  ${a.id} ${a.address.slice(0, 12)}...: ${a.alarmReason}`);
if (out.sharedServices.length) {
  console.log(`shared services seen (${out.sharedServices.length}), engine called shared service on ${out.sharedServices.filter((x) => x.engineCalledSharedService).length}:`);
  for (const h of out.sharedServices) console.log(`  ${h.type} ${h.address.slice(0, 12)}...: ${h.atLeast ? 'at least ' : ''}${h.observedWallets} wallets over ${h.observedSpanHours} h, engine: ${h.engineCalledSharedService ? 'shared service' : h.engineCountedAsLink ? 'counted as a link' : 'no link shown'}`);
}
const sizes = out.groups.length ? groupsFile.groups.map((g) => g.observed) : [];
if (sizes.length) {
  const maxW = Math.max(...sizes.map((x) => x.wallets));
  const maxH = Math.max(...sizes.map((x) => x.spanHours));
  console.log(`hub rule check: largest real group saw ${maxW} wallets over up to ${maxH} h; rule is 15 wallets over 25 h`);
}
