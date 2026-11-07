// Reads the benchmark files for the first screen. Read only, no provider calls.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const readJson = async (p) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
};

/** Real set numbers from data/real-set/results.json, plus the stress test if its file exists. */
export async function loadBenchmark({ dataDir, benchDir }) {
  const r = await readJson(join(dataDir, 'real-set', 'results.json'));
  let real = null;
  if (r?.summary) {
    const s = r.summary;
    const controls = r.controls ?? [];
    const pick = (r.groups ?? []).find((g) => g.caught && g.probe);
    real = {
      label: 'real set, verified by script against two providers',
      ranAt: r.ranAt,
      memory: r.memory,
      groups: s.realGroups,
      caught: s.groupsCaught,
      members: s.memberWalletsChecked,
      membersCaught: s.memberWalletsCaught,
      controls: s.controls,
      // Strict: only "do not pay" counts. With caution: any answer that is not "pay" counts.
      falseAlarmsStrict: controls.filter((c) => c.result?.verdict === 'do not pay').length,
      falseAlarmsWithCaution: controls.filter((c) => c.result?.verdict && c.result.verdict !== 'pay').length,
      suggested: pick ? { id: pick.id, address: pick.probe, type: pick.type } : null,
    };
  }
  const st = await readJson(join(benchDir, 'results', 'stress.json'));
  const stress = st && Number.isFinite(st.caught) && Number.isFinite(st.total)
    ? { label: 'synthetic, built by us', caught: st.caught, total: st.total }
    : null;
  return { real, stress };
}

/** The last run of the two-agent demo, written by the agent scripts. Null until one exists. */
export const loadCrossAgent = (dataDir) => readJson(join(dataDir, 'cross-agent', 'latest.json'));
