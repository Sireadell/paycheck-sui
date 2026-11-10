// Live comparison for reproduce --live. Kept in its own file so the live runner can import it without importing reproduce.js (that file runs main at load time).
/**
 * Live mode: checks every probe and every control again with the real engine (memory off) and compares with the saved run.
 * `checker` is injected so tests can run it without a network.
 */
export async function liveCompare({ groups, controls, checker, log = () => {} }) {
  const lc = (a) => String(a ?? '').toLowerCase();
  const hasLink = (res, addr) => (res.evidence ?? []).some((e) => e.kind === 'link' && lc(e.address) === lc(addr));
  let caught = 0;
  let strict = 0;
  let caution = 0;
  const diffs = [];
  for (const g of groups) {
    const res = await checker.check(g.probe, { memoryOn: false });
    const now = hasLink(res, g.linkAddress);
    if (now) caught++;
    if (now !== g.caught) diffs.push(`${g.id}: saved ${g.caught ? 'found' : 'missed'}, now ${now ? 'found' : 'missed'}`);
    log(`group ${g.id}: ${now ? 'found' : 'missed'}`);
  }
  for (const c of controls) {
    const res = await checker.check(c.address, { memoryOn: false });
    if (res.verdict === 'do not pay') strict++;
    const alarm = res.code !== 'NO_LINKS_NO_BAD_HISTORY' || (res.evidence ?? []).some((e) => e.kind === 'link');
    if (alarm) caution++;
    if (alarm !== c.falseAlarm) diffs.push(`${c.id}: saved ${c.falseAlarm ? 'alarm' : 'clean'}, now ${alarm ? 'alarm' : 'clean'}`);
    log(`control ${c.id}: ${alarm ? 'alarm' : 'clean'}`);
  }
  return { caught, groups: groups.length, strict, caution, controls: controls.length, diffs };
}
