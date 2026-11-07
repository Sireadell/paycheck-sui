// Single import point for data providers. Reads TATUM_API_KEY_MAINNET and ANKR_API_KEY from the config.
import config from '../config.js';
import { createTatum } from './tatum.js';
import { createAnkr } from './ankr.js';
import * as callLog from './callLog.js';

let tatum = null;
export function getTatum() {
  if (!tatum) tatum = createTatum({ key: config.TATUM_API_KEY_MAINNET });
  return tatum;
}
let ankr = null;
export function getAnkr() {
  if (!ankr) ankr = createAnkr({ key: config.ANKR_API_KEY });
  return ankr;
}
export { callLog };
export { FLOOR_CHECKPOINT, SUI_COIN } from './tatum.js';
export { DEPTH_NOTE } from './ankr.js';
