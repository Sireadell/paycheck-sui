// safePay: the payment step that refuses to sign unless the PayCheck check says pay.
// A "do not pay" answer is a hard stop: nothing is signed, nothing is sent, and the refusal is saved as a memory.
// Caution also stops (fail closed) unless the caller opts in. Anything the check could not judge counts as caution.
import { isSuiAddress, padAddress } from '../src/address.js';
import { suiToMist, mistToSui } from './payer.js';

export class PayCheckRefused extends Error {
  constructor(info) {
    super(`${info.code}: not paying ${info.payee}. ${info.reason}`);
    this.name = 'PayCheckRefused';
    Object.assign(this, info);
  }
}

/**
 * checker: has check(address), from src/check.js.
 * memory: has write({namespace, kind, address, group, origin, body}), from src/memory.
 * payer: has pay(to, mist). Leave it out (or set dryRun) to stop after the check.
 * agentId: the name written into the refusal memory.
 * refusalNamespace and refusalOrigin: where the refusal memory goes.
 * maxMist: the largest single payment this agent may make.
 */
export function createSafePay({ checker, memory, payer = null, agentId = 'agent', refusalNamespace = 'agent-a', refusalOrigin = 'agent-a', maxMist = 50_000_000n, allowCaution = false, dryRun = false, now = () => Date.now() } = {}) {
  if (!checker) throw new Error('safePay needs a checker');

  async function refuse(payee, mist, verdict, code) {
    const memoryIds = verdict.memoryIds ?? [];
    let entry = null;
    try {
      entry = await memory.write({
        namespace: refusalNamespace, kind: 'lesson', address: payee, group: null, origin: refusalOrigin,
        body: {
          event: 'payment_refused', agentId, verdict: verdict.verdict, code: verdict.code, reason: verdict.reason,
          citedMemoryIds: memoryIds, amountMist: mist.toString(), refusedAt: new Date(now()).toISOString(),
        },
      });
    } catch (e) {
      entry = { state: 'failed', error: String(e.message || e) };
    }
    throw new PayCheckRefused({
      code, payee, amountMist: mist, verdict: verdict.verdict, checkCode: verdict.code, reason: verdict.reason,
      memoryIds, warnedBy: verdict.warnedBy ?? [], evidence: verdict.evidence ?? [], check: verdict,
      refusalMemory: { state: entry?.state ?? 'none', id: entry?.blobId ?? null, namespace: refusalNamespace, error: entry?.error ?? null },
    });
  }

  return async function safePay(payeeInput, amount) {
    if (!isSuiAddress(payeeInput)) throw new Error('Not a Sui address');
    const payee = padAddress(payeeInput);
    const mist = suiToMist(amount);
    if (mist > maxMist) throw new Error(`Amount ${mistToSui(mist)} SUI is above this agent's limit of ${mistToSui(maxMist)} SUI`);

    const verdict = await checker.check(payee);
    if (verdict.verdict === 'do not pay') return refuse(payee, mist, verdict, 'PAYCHECK_REFUSED');
    if (verdict.verdict !== 'pay' && !allowCaution) return refuse(payee, mist, verdict, 'PAYCHECK_CAUTION');

    const summary = { payee, amountMist: mist, verdict: verdict.verdict, code: verdict.code, memoryIds: verdict.memoryIds ?? [], check: verdict };
    if (dryRun || !payer) return { ...summary, paid: false, dryRun: true, digest: null };
    const sent = await payer.pay(payee, mist);
    return { ...summary, paid: true, dryRun: false, digest: sent.digest, status: sent.status, gasMist: sent.gasMist };
  };
}
