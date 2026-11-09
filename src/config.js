// Loads settings from environment variables. Fails loudly on a missing name, never prints values.
const REQUIRED = [
  'MEMWAL_DELEGATE_PRIVATE_KEY',
  'MEMWAL_ACCOUNT_ID',
  'TATUM_API_KEY_MAINNET',
];
const OPTIONAL = [
  'MEMWAL_AGENT_ID',
  'MEMWAL_AGENT_B_DELEGATE_PRIVATE_KEY',
  'MEMWAL_PACKAGE_ID',
  'MEMWAL_REGISTRY_ID',
  'MEMWAL_RELAYER_URL',
  'TATUM_API_KEY_TESTNET',
  'TATUM_ACCOUNT_ID',
  'ANKR_API_KEY',
  'GEMINI_API_KEY',
  'SUI_ADDRESS',
  'SUI_WALLET_ADDRESS',
  'SUI_WALLET_PRIVATE_KEY',
];

export function loadConfig(env = process.env, { strict = true } = {}) {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (strict && missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  const out = {};
  for (const name of [...REQUIRED, ...OPTIONAL]) out[name] = env[name] || '';
  if (!out.MEMWAL_RELAYER_URL) out.MEMWAL_RELAYER_URL = 'https://relayer.memory.walrus.xyz';
  return out;
}

// Default export never throws at import time so tests run without keys; entry points call loadConfig() to fail loudly.
export default loadConfig(process.env, { strict: false });
