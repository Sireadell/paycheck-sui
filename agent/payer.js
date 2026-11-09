// The one place that signs and sends a plain SUI payment on mainnet. Nothing else in the repo holds a signing key.
// The key is read from the environment by the caller and is never printed, logged or stored.
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { padAddress } from '../src/address.js';

export const MIST_PER_SUI = 1_000_000_000n;

/** "0.001" or 0.001 to whole mist. Throws on anything that is not a plain positive decimal with up to 9 places. */
export function suiToMist(amount) {
  const s = String(amount).trim();
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(s);
  if (!m) throw new Error(`Not a SUI amount: ${s}`);
  const mist = BigInt(m[1]) * MIST_PER_SUI + BigInt((m[2] ?? '').padEnd(9, '0') || '0');
  if (mist <= 0n) throw new Error('Amount must be more than zero');
  return mist;
}

export const mistToSui = (mist) => {
  const m = BigInt(mist);
  const frac = (m % MIST_PER_SUI).toString().padStart(9, '0').replace(/0+$/, '');
  return `${m / MIST_PER_SUI}${frac ? `.${frac}` : ''}`;
};

/** Accepts the wallet export format (suiprivkey...), or the raw key as hex or base64. */
export function keypairFromSecret(secret) {
  const s = String(secret ?? '').trim();
  if (!s) throw new Error('No signing key given');
  if (s.startsWith('suiprivkey')) return Ed25519Keypair.fromSecretKey(s);
  const bytes = /^(0x)?[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s.replace(/^0x/, ''), 'hex') : Buffer.from(s, 'base64');
  return Ed25519Keypair.fromSecretKey(new Uint8Array(bytes));
}

/**
 * A payer sends plain SUI from one wallet. `reserveMist` is the floor it will never spend below.
 * pay() returns {digest, status, amountMist, gasMist}. It throws if the chain does not report success.
 */
export function createSuiPayer({ keypair, rpcUrl, client = null, reserveMist = 0n, network = 'mainnet' } = {}) {
  if (!keypair) throw new Error('A keypair is required');
  const rpc = client ?? new SuiJsonRpcClient({ url: rpcUrl, network });
  const address = keypair.toSuiAddress();
  const balance = async () => BigInt((await rpc.getBalance({ owner: address })).totalBalance);
  // One transaction that sends plain SUI to one or more wallets.
  async function payMany(items) {
    const outs = items.map((i) => ({ payee: padAddress(i.to), amount: BigInt(i.amountMist) }));
    if (!outs.length || outs.some((o) => !o.payee)) throw new Error('Not a Sui address');
    const total = outs.reduce((s, o) => s + o.amount, 0n);
    const have = await balance();
    // Gas for a plain transfer is well under 0.01 SUI; the reserve is on top of that.
    if (have - total - 10_000_000n < reserveMist) throw new Error('Payment would take the wallet below its reserve');
    const tx = new Transaction();
    for (const o of outs) {
      const [coin] = tx.splitCoins(tx.gas, [o.amount]);
      tx.transferObjects([coin], o.payee);
    }
    tx.setSender(address);
    const sent = await rpc.signAndExecuteTransaction({ signer: keypair, transaction: tx, options: { showEffects: true } });
    const done = await rpc.waitForTransaction({ digest: sent.digest, options: { showEffects: true } });
    const effects = done.effects ?? sent.effects;
    const status = effects?.status?.status ?? 'unknown';
    const g = effects?.gasUsed;
    const gasMist = g ? BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate) : null;
    if (status !== 'success') throw new Error(`Payment ${sent.digest} did not succeed (${status})`);
    return { digest: sent.digest, status, amountMist: total, gasMist };
  }
  return {
    address,
    balance,
    pay: (to, amountMist) => payMany([{ to, amountMist }]),
    payMany,
  };
}
