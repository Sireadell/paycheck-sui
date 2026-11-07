// Pure helpers for the benchmark: case building, the fixed split, the plain AI prompt and answer parsing, scoring.
// Nothing here fetches anything. scripts/benchmark.js does the reading and writing.
import { createHash } from 'node:crypto';

export const lc = (a) => String(a ?? '').toLowerCase();
export const VERDICTS = ['pay', 'caution', 'do not pay'];

/**
 * Fixed split rule (also written in docs/METHOD.md, decided before any run, no look at outcomes):
 *  - a group case is its recorded probe wallet. The probe is held out. The first listed member that is not the probe
 *    is the training wallet, and memory is told that its payment went bad.
 *  - controls in id order: 1st, 3rd, 5th ... are training (memory is told "paid fine"), 2nd, 4th, 6th ... are held out.
 * A case file has the shape of data/real-set/groups.json and controls.json (groups[], controls[]).
 */
export function buildCases({ groups = [], controls = [] }, setName = 'real') {
  const cases = [];
  for (const g of groups) {
    const train = g.members.map((m) => m.address).find((a) => lc(a) !== lc(g.probe)) ?? null;
    cases.push({ id: g.id, set: setName, kind: 'group', type: g.type, wallet: g.probe, linkAddress: g.linkAddress, trainWallet: train, split: 'heldout', trainOutcome: 'bad' });
  }
  const sorted = controls.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  sorted.forEach((c, i) => {
    cases.push({ id: c.id, set: setName, kind: 'control', type: 'control', wallet: c.address, linkAddress: null, trainWallet: i % 2 === 0 ? c.address : null, split: i % 2 === 0 ? 'train' : 'heldout', trainOutcome: 'good' });
  });
  return cases;
}

/** Trim one provider transaction to the fields the AI reads. Same raw facts the checker reads, fewer keys. */
export function compactTx(t) {
  return {
    d: t.digest, t: t.timestamp, s: t.sender, g: t.gasSponsor ?? t.sender, ok: t.status === 'SUCCESS',
    c: (t.balanceChanges ?? []).map((b) => [b.owner, b.amount, String(b.coin ?? '').split('::').slice(-1)[0] || '?']),
  };
}
export const txLines = (txs) => (txs?.length ? txs.map((t) => JSON.stringify(compactTx(t))).join('\n') : '(none)');

export function buildPrompt(template, { wallet, walletTxs, funder, funderTxs, sponsor, sponsorTxs }) {
  const fill = { WALLET: wallet, WALLET_TXS: txLines(walletTxs), FUNDER: funder ?? 'none found', FUNDER_TXS: funder ? txLines(funderTxs) : '(none)', SPONSOR: sponsor ?? 'none (the wallet paid its own fees)', SPONSOR_TXS: sponsor ? txLines(sponsorTxs) : '(none)' };
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '');
}
export const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Parse the AI's text into {verdict, linked, linkAddress, reason}. verdict is 'unparsed' when it cannot be read. */
export function parseAnswer(text) {
  const raw = String(text ?? '');
  let obj = null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) { try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { obj = null; } }
  const norm = (v) => {
    const s = lc(v).replace(/[_-]/g, ' ').trim();
    if (s === 'pay' || s === 'safe' || s === 'safe to pay') return 'pay';
    if (s === 'caution') return 'caution';
    if (s === 'do not pay' || s === 'dont pay' || s === 'don\'t pay' || s === 'donotpay') return 'do not pay';
    return null;
  };
  let verdict = obj ? norm(obj.verdict) : null;
  if (!verdict) {
    const m = /"?verdict"?\s*[:=]\s*"?(do not pay|don't pay|caution|pay)/i.exec(raw);
    verdict = m ? norm(m[1]) : null;
  }
  const la = obj && typeof obj.link_address === 'string' && /^0x[0-9a-fA-F]+$/.test(obj.link_address) ? lc(obj.link_address) : null;
  return { verdict: verdict ?? 'unparsed', linked: Boolean(obj?.linked), linkAddress: la, reason: obj && typeof obj.reason === 'string' ? obj.reason.slice(0, 400) : null };
}

/** Link found: the column shows a link whose address is the recorded link address (groups only). */
export const linkFound = (col, linkAddress) => Boolean(linkAddress) && lc(col.linkAddress) === lc(linkAddress);

/** One cell of the table: how one column answered one case. */
export function outcomeOf(kase, col) {
  const v = col.verdict;
  if (kase.kind === 'group') return { flagged: v === 'caution' || v === 'do not pay', stopped: v === 'do not pay', link: linkFound(col, kase.linkAddress) };
  return { falseAlarmStrict: v === 'do not pay', falseAlarmIncl: v === 'caution' || v === 'do not pay' };
}

/** A column "did well" on a case: warned on a group, stayed quiet (pay) on a control. */
export const didWell = (kase, col) => (kase.kind === 'group' ? col.verdict === 'caution' || col.verdict === 'do not pay' : col.verdict === 'pay');

/** Counts for one column over the given rows: [{case, ai, nomem, mem}]. colName picks the column. */
export function tally(rows, colName) {
  const r = rows.filter((x) => x[colName]);
  const g = r.filter((x) => x.case.kind === 'group');
  const c = r.filter((x) => x.case.kind === 'control');
  const o = (x) => outcomeOf(x.case, x[colName]);
  return {
    groups: g.length, linkFound: g.filter((x) => o(x).link).length, flagged: g.filter((x) => o(x).flagged).length, stopped: g.filter((x) => o(x).stopped).length,
    controls: c.length, falseAlarmStrict: c.filter((x) => o(x).falseAlarmStrict).length, falseAlarmIncl: c.filter((x) => o(x).falseAlarmIncl).length,
  };
}

/** Honest lists: cases where plain AI did well and our checker (with memory) did not, and every case our checker did not do well on. */
export function lossLists(rows) {
  const aiBeat = [];
  const weLost = [];
  for (const x of rows) {
    if (!x.mem || !x.ai) continue;
    const ours = didWell(x.case, x.mem);
    const ai = didWell(x.case, x.ai);
    const aiLink = x.case.kind === 'group' && linkFound(x.ai, x.case.linkAddress);
    const ourLink = x.case.kind === 'group' && linkFound(x.mem, x.case.linkAddress);
    if (ai && !ours) aiBeat.push({ id: x.case.id, kind: x.case.kind, ai: x.ai.verdict, ours: x.mem.verdict, why: 'AI answered better on the verdict' });
    else if (aiLink && !ourLink) aiBeat.push({ id: x.case.id, kind: x.case.kind, ai: x.ai.verdict, ours: x.mem.verdict, why: 'AI named the recorded link address, the checker did not' });
    if (!ours) weLost.push({ id: x.case.id, kind: x.case.kind, ours: x.mem.verdict, code: x.mem.code ?? null, ai: x.ai.verdict });
  }
  return { aiBeat, weLost };
}
