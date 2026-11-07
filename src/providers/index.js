// Single import point for data providers. Reads TATUM_API_KEY_MAINNET from the config.
import config from '../config.js';
import { createTatum } from './tatum.js';
import * as callLog from './callLog.js';

let tatum = null;
export function getTatum() {
  if (!tatum) tatum = createTatum({ key: config.TATUM_API_KEY_MAINNET });
  return tatum;
}
export { callLog };
export { FLOOR_CHECKPOINT, SUI_COIN } from './tatum.js';
