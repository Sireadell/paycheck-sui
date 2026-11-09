// Smoke test: node --env-file=.env scripts/crosscheck-smoke.js <sui address>
import { getTatum, getAnkr, callLog } from '../src/providers/index.js';
import { crossCheck } from '../src/providers/crosscheck.js';

const address = process.argv[2];
if (!address) { console.error('Usage: node scripts/crosscheck-smoke.js <sui address>'); process.exit(1); }
const since = callLog.mark();
const r = await crossCheck({ tatum: getTatum(), ankr: getAnkr(), address });
const ankr = callLog.summarize(since, 'ankr');
console.log(`agree ${r.agree} of ${r.checked}`);
console.log(`ankr oldest checkpoint ${r.ankrOldestCheckpoint ?? 'none (ankr listing empty)'}`);
console.log(`tatum oldest checkpoint ${r.tatumOldestCheckpoint ?? 'none'}, listed by tatum but not by ankr ${r.missingFromAnkrListing}, ankr calls ${ankr.calls}, failed ${ankr.failed}`);
for (const d of r.disagreements) console.log(`disagree ${d.digest}: ${d.reason}`);
if (r.depthNote) console.log(`note: ${r.depthNote}`);
