// Builds a small group of linked wallets on mainnet, built by us and labelled so everywhere it is shown.
// A fresh funder F gets a little SUI from the working wallet, then sends the first SUI to two fresh wallets (W1, W2),
// and F pays the gas for one empty transaction of each of them. So W1 and W2 share a first funder and a gas sponsor.
// The keys of F, W1 and W2 live only in memory for this run and are never printed or saved. What is left in them is dust.
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createSuiPayer } from './payer.js';

const SUI_TYPE = '0x2::sui::SUI';

export async function sponsoredNoop(rpc, wallet, sponsor) {
  const tx = new Transaction();
  tx.setSender(wallet.toSuiAddress());
  tx.setGasOwner(sponsor.toSuiAddress());
  const [zero] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [SUI_TYPE] });
  tx.moveCall({ target: '0x2::coin::destroy_zero', typeArguments: [SUI_TYPE], arguments: [zero] });
  const bytes = await tx.build({ client: rpc });
  const [a, b] = await Promise.all([wallet.signTransaction(bytes), sponsor.signTransaction(bytes)]);
  const sent = await rpc.executeTransactionBlock({ transactionBlock: bytes, signature: [a.signature, b.signature], options: { showEffects: true } });
  const done = await rpc.waitForTransaction({ digest: sent.digest, options: { showEffects: true } });
  const status = (done.effects ?? sent.effects)?.status?.status;
  if (status !== 'success') throw new Error(`Sponsored transaction ${sent.digest} did not succeed (${status})`);
  return sent.digest;
}

/**
 * main: a payer for the working wallet. Returns the three addresses and the transaction digests.
 * fundMist: what F receives. shareMist: what each of W1 and W2 receives from F.
 */
export async function buildTestGroup({ main, rpcUrl, fundMist = 20_000_000n, shareMist = 3_000_000n, log = () => {} } = {}) {
  const rpc = new SuiJsonRpcClient({ url: rpcUrl, network: 'mainnet' });
  const funder = Ed25519Keypair.generate();
  const w1 = Ed25519Keypair.generate();
  const w2 = Ed25519Keypair.generate();
  const fundTx = await main.pay(funder.toSuiAddress(), fundMist);
  log(`test group: funded the group funder ${funder.toSuiAddress()} with ${fundMist} mist, ${fundTx.digest}`);
  const fp = createSuiPayer({ keypair: funder, client: rpc });
  // The balance read can lag a moment behind a fresh transfer; wait until the funder shows its money.
  for (let i = 0; i < 30 && (await fp.balance()) < fundMist; i++) await new Promise((r) => setTimeout(r, 2000));
  const shareTx = await fp.payMany([{ to: w1.toSuiAddress(), amountMist: shareMist }, { to: w2.toSuiAddress(), amountMist: shareMist }]);
  log(`test group: the funder sent the first SUI to both wallets, ${shareTx.digest}`);
  const sponsored = [];
  for (const w of [w1, w2]) {
    try {
      sponsored.push(await sponsoredNoop(rpc, w, funder));
      log(`test group: the funder paid the gas for one empty transaction of ${w.toSuiAddress()}, ${sponsored.at(-1)}`);
    } catch (e) {
      log(`test group: sponsored transaction failed for ${w.toSuiAddress()} (${String(e.message || e).slice(0, 120)}); continuing with the funder link only`);
    }
  }
  return {
    funder: funder.toSuiAddress(), w1: w1.toSuiAddress(), w2: w2.toSuiAddress(),
    fundingDigest: fundTx.digest, firstFundingDigest: shareTx.digest, sponsoredDigests: sponsored,
  };
}
