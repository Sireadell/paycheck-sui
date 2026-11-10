// Live part of `npm run reproduce -- --live`: the real engine, Tatum for the chain and Ankr as the second opinion, memory off.
// Answers are cached under data/real-set/raw/cache (not committed). Delete that folder to force every call to go out again.
import { createChecker } from '../../src/check.js';
import { makeClients } from './realSetCommon.js';
import { liveCompare } from './liveCompare.js';

const noMemory = { recall: async () => [], enqueue: () => ({ state: 'none', key: null }), write: async () => ({ state: 'none' }), markChanged() {}, flush: async () => {}, destroy() {} };

export async function runLive({ groups, controls, log }) {
  const { tatum, ankr } = makeClients({ withAnkr: true });
  const checker = createChecker({ tatum, ankr, memory: noMemory, mode: 'live' });
  return liveCompare({ groups, controls, checker, log });
}
