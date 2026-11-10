// Pay per check with x402 (version 2), scheme "exact", network sui:mainnet, asset native SUI.
// This follows the x402 foundation's Sui exact scheme: the caller signs a complete SUI transfer and sends it in the
// PAYMENT-SIGNATURE header. This server checks the signature, simulates the transfer, broadcasts it itself (it is its own
// facilitator, so there is no third-party service in the path), and only then returns the check.
// Each signed transaction works once: used digests are saved so a restart does not forget them.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { padAddress } from './address.js';

export const X402_VERSION = 2;
export const NETWORK = 'sui:mainnet';
export const ASSET = '0x2::sui::SUI';
export const PRICE_MIST = 1_000_000n; // 0.001 SUI, the same price as the plain paid check
const isSui = (coin) => /::sui::SUI$/.test(String(coin ?? ''));

export const encodeHeader = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
export function decodeHeader(text) {
  try { return JSON.parse(Buffer.from(String(text), 'base64').toString('utf8')); } catch { return null; }
}

/** `rpc` needs dryRunTransactionBlock, executeTransactionBlock and waitForTransaction (a SuiJsonRpcClient has all three). */
export function createX402Check({ rpc, checker, payee, usedFile = null, now = () => Date.now(), priceMist = PRICE_MIST, maxTimeoutSeconds = 60 } = {}) {
  const payTo = padAddress(payee);
  if (!payTo) throw new Error('A valid receiving address is required for x402 checks');
  const used = new Map();  // digest -> {payer, address, settledAt, served}
  const busy = new Set();
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    if (!usedFile) return;
    try { for (const r of JSON.parse(await readFile(usedFile, 'utf8')).settled ?? []) used.set(r.digest, r); } catch { /* none yet */ }
  }
  async function save() {
    if (!usedFile) return;
    await mkdir(dirname(usedFile), { recursive: true });
    await writeFile(usedFile, JSON.stringify({ settled: [...used.values()] }, null, 1));
  }

  const accepts = () => ({ scheme: 'exact', network: NETWORK, amount: priceMist.toString(), asset: ASSET, payTo, maxTimeoutSeconds, extra: {} });
  const required = (resourceUrl, error) => ({ x402Version: X402_VERSION, error, resource: { url: resourceUrl, description: 'One PayCheck Sui check of one address', mimeType: 'application/json' }, accepts: [accepts()] });
  const refuse = (status, resourceUrl, error, extra = {}) => ({ status, headers: { 'PAYMENT-REQUIRED': encodeHeader(required(resourceUrl, error)) }, body: { ...required(resourceUrl, error), ...extra } });

  const paidTo = (changes) => (changes ?? []).filter((b) => isSui(b.coinType) && b.owner?.AddressOwner && padAddress(b.owner.AddressOwner) === payTo).reduce((s, b) => s + BigInt(b.amount), 0n);

  /** @returns {{status:number, headers:object, body:object}} */
  async function handle({ address, resourceUrl, paymentHeader, memoryOn = true }) {
    await load();
    const target = padAddress(address);
    if (!target) return { status: 400, headers: {}, body: { error: 'Send a Sui address in "address".' } };
    if (!paymentHeader) return refuse(402, resourceUrl, 'Payment required: send a signed SUI transfer in the PAYMENT-SIGNATURE header.');

    const p = decodeHeader(paymentHeader);
    const a = p?.accepted, want = accepts();
    if (!p || p.x402Version !== X402_VERSION || !a || !p.payload?.transaction || !p.payload?.signature) return refuse(400, resourceUrl, 'The PAYMENT-SIGNATURE header is not a valid x402 v2 payment.');
    if (a.scheme !== want.scheme || a.network !== want.network || a.asset !== want.asset || String(a.amount) !== want.amount || padAddress(a.payTo) !== payTo) return refuse(402, resourceUrl, 'The payment does not match what this server asked for.');

    let bytes, digest, sender;
    try {
      bytes = Uint8Array.from(Buffer.from(String(p.payload.transaction), 'base64'));
      digest = TransactionDataBuilder.getDigestFromBytes(bytes);
      const pub = await verifyTransactionSignature(bytes, String(p.payload.signature));
      sender = pub.toSuiAddress();
      const data = Transaction.from(bytes).getData();
      if (padAddress(data.sender) !== padAddress(sender)) return refuse(402, resourceUrl, 'The signature is not from the sender of the transaction.');
      if (data.gasData?.owner && padAddress(data.gasData.owner) !== padAddress(sender)) return refuse(402, resourceUrl, 'Sponsored transactions are not accepted here. The payer must pay its own gas.');
    } catch {
      return refuse(402, resourceUrl, 'The transaction or its signature could not be read.');
    }
    const txB64 = Buffer.from(bytes).toString('base64');

    // Settled earlier but the check was never delivered (the server failed after taking payment): serve it again, once, for the same address.
    const prior = used.get(digest);
    if (prior && !prior.served && prior.address === target) return serve({ digest, sender: prior.payer, address, memoryOn, resourceUrl, record: prior });
    if (prior || busy.has(digest)) return refuse(409, resourceUrl, 'This payment was already used for a check.');
    busy.add(digest);
    try {
      let sim;
      try { sim = await rpc.dryRunTransactionBlock({ transactionBlock: txB64 }); } catch { return refuse(503, resourceUrl, 'Could not simulate the payment just now. Try again shortly.', { retryable: true }); }
      if (sim.effects?.status?.status !== 'success') return refuse(402, resourceUrl, 'The payment would fail on Sui, so it was not sent.');
      if (paidTo(sim.balanceChanges) < priceMist) return refuse(402, resourceUrl, `The payment must send at least ${priceMist} mist of SUI to ${payTo}.`);

      let done;
      try {
        const sent = await rpc.executeTransactionBlock({ transactionBlock: txB64, signature: String(p.payload.signature), options: { showEffects: true, showBalanceChanges: true } });
        done = await rpc.waitForTransaction({ digest: sent.digest, options: { showEffects: true, showBalanceChanges: true } });
      } catch { return refuse(503, resourceUrl, 'The payment could not be sent to Sui just now. Try again shortly.', { retryable: true }); }
      if (done.effects?.status?.status !== 'success' || paidTo(done.balanceChanges) < priceMist) return refuse(402, resourceUrl, 'The payment did not settle on Sui.');

      const record = { digest, payer: sender, address: target, settledAt: new Date(now()).toISOString(), served: false };
      used.set(digest, record);
      await save();
      return serve({ digest, sender, address, memoryOn, resourceUrl, record });
    } finally { busy.delete(digest); }
  }

  async function serve({ digest, sender, address, memoryOn, resourceUrl, record }) {
    let result;
    try { result = await checker.check(address, { memoryOn }); } catch {
      return refuse(500, resourceUrl, 'Your payment settled, but the check failed. Send the same payment header again to get the check without paying twice.', { retryable: true, settled: { transaction: digest } });
    }
    record.served = true;
    await save();
    const receipt = { success: true, transaction: digest, network: NETWORK, payer: sender };
    return { status: 200, headers: { 'PAYMENT-RESPONSE': encodeHeader(receipt) }, body: { ...result, payment: { settled: true, route: 'x402 v2 exact on sui:mainnet', digest, payee: payTo } } };
  }

  return { handle, count: async () => { await load(); return used.size; }, payee: payTo, priceMist, network: NETWORK };
}
