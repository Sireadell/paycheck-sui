// Pay per check in plain SUI. The caller asks, gets an HTTP 402 with an amount and a one-time id,
// pays that exact amount on Sui mainnet, then sends the transaction digest. The server reads the
// transaction back from Tatum and only then returns the check. Each id and each digest works once.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { padAddress } from './address.js';

export const BASE_MIST = 1_000_000n; // 0.001 SUI
const TAG_RANGE = 9000;              // the id adds 1 to 9000 mist, so each open request has its own exact amount
const isSui = (coin) => /::sui::SUI$/.test(String(coin ?? ''));

const mistToSui = (m) => {
  const v = BigInt(m);
  const frac = (v % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${v / 1_000_000_000n}${frac ? `.${frac}` : ''}`;
};

export function createPaidCheck({ tatum, checker, payee, usedFile = null, now = () => Date.now(), challengeMs = 15 * 60 * 1000, maxAgeMs = 30 * 60 * 1000 } = {}) {
  const to = padAddress(payee);
  if (!to) throw new Error('A valid receiving address is required for paid checks');
  const open = new Map();   // id -> {address, tag, expiresAt}
  const used = new Map();   // digest -> {id, address, settledAt}
  const busy = new Set();   // digests being verified right now
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

  function challenge(address) {
    const t = now();
    for (const [k, v] of open) if (v.expiresAt <= t) open.delete(k);
    const taken = new Set([...open.values()].map((v) => v.tag));
    if (taken.size >= TAG_RANGE) throw new Error('Too many open payment requests');
    let tag;
    do { tag = 1 + (randomBytes(2).readUInt16BE() % TAG_RANGE); } while (taken.has(tag));
    const id = randomBytes(9).toString('base64url');
    open.set(id, { address, tag, expiresAt: t + challengeMs });
    const amountMist = BASE_MIST + BigInt(tag);
    return { id, amountMist: amountMist.toString(), amountSui: mistToSui(amountMist), coin: 'SUI', payee: to, expiresAt: new Date(t + challengeMs).toISOString() };
  }

  /** Returns {ok:true, ...} or {ok:false, status, error, retryable}. Never throws on bad input. */
  async function verify({ id, digest, address }) {
    await load();
    const c = open.get(String(id ?? ''));
    if (!c || c.expiresAt <= now()) return { ok: false, status: 402, error: 'Unknown or expired payment id. Ask again for a new one.' };
    if (c.address !== address) return { ok: false, status: 400, error: 'That payment id was issued for a different address.' };
    const d = String(digest ?? '');
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(d)) return { ok: false, status: 400, error: 'That is not a transaction digest.' };
    if (used.has(d) || busy.has(d)) return { ok: false, status: 409, error: 'This payment was already used for a check.' };
    busy.add(d);
    try {
      let tx;
      try { tx = await tatum.transactionByDigest(d); } catch { return { ok: false, status: 503, retryable: true, error: 'Could not read the transaction just now. Try again shortly.' }; }
      if (!tx) return { ok: false, status: 402, retryable: true, error: 'The transaction was not found on Sui mainnet yet. Wait a few seconds and send it again.' };
      if (String(tx.status).toUpperCase() !== 'SUCCESS') return { ok: false, status: 402, error: 'The payment transaction did not succeed.' };
      const want = BASE_MIST + BigInt(c.tag);
      const got = tx.balanceChanges.filter((b) => b.owner === to && isSui(b.coin)).reduce((s, b) => s + BigInt(b.amount), 0n);
      if (got !== want) return { ok: false, status: 402, error: `The payment to ${to} must be exactly ${mistToSui(want)} SUI. Found ${mistToSui(got)} SUI.` };
      const ts = Date.parse(tx.timestamp ?? '');
      if (!Number.isFinite(ts) || now() - ts > maxAgeMs || ts - now() > 60_000) return { ok: false, status: 402, error: 'The payment is too old. Pay again with a new id.' };
      open.delete(String(id));
      const rec = { digest: d, id: String(id), address, payer: tx.sender, amountMist: want.toString(), settledAt: new Date(now()).toISOString() };
      used.set(d, rec);
      await save();
      return { ok: true, ...rec };
    } finally { busy.delete(d); }
  }

  async function handle({ address, id, digest, memoryOn = true }) {
    const addr = padAddress(address);
    if (!addr) return { status: 400, body: { error: 'Send a Sui address in "address".' } };
    if (!id && !digest) {
      const payment = challenge(addr);
      // The price in dollars, from Tatum's exchange rate. If the rate cannot be read, the SUI amount still stands on its own.
      if (typeof tatum.exchangeRate === 'function') {
        try { const r = await tatum.exchangeRate('SUI', 'USD'); payment.approxUsd = Number((Number(payment.amountSui) * r.value).toFixed(6)); payment.rate = { suiInUsd: r.value, source: 'Tatum exchange rate' }; } catch { /* leave out */ }
      }
      return { status: 402, body: { error: 'Payment required. Pay this exact amount in SUI, then send the same request again with "id" and "digest".', payment } };
    }
    const v = await verify({ id, digest, address: addr });
    if (!v.ok) return { status: v.status, body: { error: v.error, retryable: Boolean(v.retryable) } };
    const result = await checker.check(address, { memoryOn });
    return { status: 200, body: { ...result, payment: { settled: true, digest: v.digest, amountSui: mistToSui(v.amountMist), payee: to } } };
  }

  return { handle, challenge, verify, count: async () => { await load(); return used.size; }, payee: to };
}
