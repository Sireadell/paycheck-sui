// Read-only: prints the SUI balance of the working wallet and the Walrus owner wallet.
// Run: node --env-file=.env scripts/balance.js
import config from '../src/config.js';
import { getTatum } from '../src/providers/index.js';

const MIST_PER_SUI = 1000000000n;

function formatSui(mist) {
  const whole = mist / MIST_PER_SUI;
  const frac = (mist % MIST_PER_SUI).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const wallets = [
  ['wallet', 'SUI_WALLET_ADDRESS'],
  ['walrus-owner', 'SUI_ADDRESS'],
];

for (const [label, name] of wallets) {
  const address = config[name];
  if (!address) {
    console.error(`Missing environment variable: ${name}`);
    process.exitCode = 1;
    continue;
  }
  const mist = await getTatum().balance(address);
  console.log(`SUI: ${formatSui(BigInt(mist))} ${label}`);
}
