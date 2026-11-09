# How paid checks work

A check can be bought per call. The route is plain SUI on Sui mainnet. It is not x402 and it is not MPP.

## The steps

1. The caller sends `POST /api/paid/check` with `{"address": "0x..."}`.
2. The server answers HTTP 402 with the receiving address, the coin (SUI), an exact amount (0.001 SUI plus a few mist that make it unique) and a one-time id.
3. The caller sends that exact amount on Sui mainnet.
4. The caller sends the same request again with `id` and the transaction `digest`.
5. The server reads the transaction back through Tatum GraphQL and checks four things: it succeeded, the receiving address got exactly the asked amount in SUI, it is less than 30 minutes old, and the digest was never used before. Only then it returns the check. The 402 answer also shows the price in dollars (`approxUsd` and `rate`), read from Tatum's exchange rate. If that read fails the answer simply leaves it out.

Each id works once and expires after 15 minutes. Each digest works once, and used digests are saved to `data/paid-check/used.json` so a restart does not forget them. The receiving address is `PAID_CHECK_PAYEE`, or `SUI_ADDRESS` when that is not set.

Because a plain transfer has no memo field, the unique amount is what ties a payment to one request. Someone who copies another caller's digest cannot use it: the id it belongs to is not theirs, and the digest is single use.

Run one yourself: `node --env-file=.env agent/paid-client.js --run`. The last saved run is `data/paid-check/latest.json`.

## Why not x402

I looked for an x402 route that settles on Sui (9 Nov 2026).

| Option | What I found | Why it is not used here |
|---|---|---|
| `@t2000/sui-x402` 11.7.0 | x402 "exact" scheme for Sui, gasless USDC | Takes USDC. The payer wallet holds SUI only |
| `x402-sui` 2.0.1 | x402 v2 for Sui | Not run against mainnet by us |
| `@suimpp/mpp` 0.9.0 | MPP payment method, USDC | Takes USDC. Same reason |
| Public x402 facilitators for Sui | One community facilitator announces testnet only; another lists Sui as coming soon | No confirmed mainnet facilitator |

None of these was run, so nothing here claims x402 or MPP. If one is added later and settles a real mainnet payment, this page will say which.

## Is it switched on?

Paid checks run only when the server has a receiving address (`PAID_CHECK_PAYEE`, or `SUI_ADDRESS`). `GET /api/stats` shows `paidChecks.enabled` as true or false. When it is false the route answers 503.
