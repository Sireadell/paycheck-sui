// Shared setup for the agent scripts: memory, checker and (when asked) the payer, all from the environment.
import { createChecker } from '../src/check.js';
import { createMemory } from '../src/memory/index.js';
import { getTatum, getAnkr } from '../src/providers/index.js';
import { loadConfig } from '../src/config.js';
import { ENDPOINT_BASE } from '../src/providers/ankr.js';
import { createSuiPayer, keypairFromSecret } from './payer.js';

export const EXPLORER_TX = (digest) => `https://suiscan.xyz/mainnet/tx/${digest}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** mode 'live' writes to the live namespaces (the public proof run); anything else uses the labelled test namespace. */
export function buildEnv({ mode = 'test', withPayer = false, reserveSui = 2 } = {}) {
  const cfg = loadConfig();
  const memory = createMemory();
  const checker = createChecker({ tatum: getTatum(), ankr: cfg.ANKR_API_KEY ? getAnkr() : null, memory, mode: mode === 'live' ? 'live' : 'test' });
  let payer = null;
  if (withPayer) {
    const keypair = keypairFromSecret(cfg.SUI_WALLET_PRIVATE_KEY);
    if (cfg.SUI_WALLET_ADDRESS && keypair.toSuiAddress() !== cfg.SUI_WALLET_ADDRESS.toLowerCase()) throw new Error('SUI_WALLET_PRIVATE_KEY does not match SUI_WALLET_ADDRESS');
    payer = createSuiPayer({ keypair, rpcUrl: ENDPOINT_BASE + cfg.ANKR_API_KEY, reserveMist: BigInt(Math.round(reserveSui * 1e9)) });
  }
  return { cfg, memory, checker, payer, mode };
}

/** Walrus search needs a few seconds before a new memory can be found. Polls until the blob id is recalled. */
export async function waitUntilRecalled(memory, { namespace, address, blobId }, { tries = 12, waitMs = 5000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const found = await memory.recall({ namespace, address }).catch(() => []);
    if (found.some((m) => m.blobId === blobId)) return true;
    await sleep(waitMs);
  }
  return false;
}
