# How paid checks work

A check can be bought per call. This page covers two routes: plain SUI, and x402 v2. Neither is MPP.

## The steps

1. The caller sends `POST /api/paid/check` with `{"address": "0x..."}`.
2. The server answers HTTP 402 with the receiving address, the coin (SUI), an exact amount (0.001 SUI plus a few mist that make it unique) and a one-time id.
3. The caller sends that exact amount on Sui mainnet.
4. The caller sends the same request again with `id` and the transaction `digest`.
5. The server reads the transaction back through Tatum GraphQL and checks four things: it succeeded, the receiving address got exactly the asked amount in SUI, it is less than 30 minutes old, and the digest was never used before. Only then it returns the check. The 402 answer also shows the price in dollars (`approxUsd` and `rate`), read from Tatum's exchange rate. If that read fails the answer simply leaves it out.

Each id works once and expires after 15 minutes. Each digest works once, and used digests are saved to `data/paid-check/used.json` so a restart does not forget them. The receiving address is `PAID_CHECK_PAYEE`, or `SUI_ADDRESS` when that is not set.

Because a plain transfer has no memo field, the unique amount is what ties a payment to one request. Someone who copies another caller's digest cannot use it: the id it belongs to is not theirs, and the digest is single use.

Run one yourself: `node --env-file=.env agent/paid-client.js --run`. The last saved run is `data/paid-check/latest.json`.

## The x402 route

`GET /api/x402/check?address=0x...` (or POST) follows x402 version 2, scheme `exact`, as the x402 foundation wrote it for Sui (`specs/schemes/exact/scheme_exact_sui.md`, read 10 Nov 2026). That spec lists native SUI (`0x2::sui::SUI`) as an allowed asset, which is what makes this route possible with a wallet that holds only SUI.

1. No payment header: the server answers 402. The terms are in the `PAYMENT-REQUIRED` header (base64 JSON) and in the body: scheme `exact`, network `sui:mainnet`, asset `0x2::sui::SUI`, amount `1000000` mist (0.001 SUI), `payTo` the receiving address.
2. The agent builds and signs a complete SUI transfer for that amount and sends the request again with the `PAYMENT-SIGNATURE` header (base64 JSON with `accepted`, and `payload.signature` plus `payload.transaction`).
3. The server checks that the terms match, that the signature is valid and from the transaction's sender, that nobody else pays the gas, that a simulation succeeds and credits the receiving address at least the price, and that the transaction was never used. Then it sends the transaction to Sui itself and waits for it to settle.
4. It answers 200 with the check and a `PAYMENT-RESPONSE` header (transaction digest, network, payer).

Each signed transaction works once, and used ones are saved to `data/x402/used.json`. If the server takes the payment but the check then fails, sending the same header again returns the check once without paying twice.

What is and is not proven:

| Claim | Status |
|---|---|
| Follows the foundation's Sui `exact` spec for headers, fields and verification steps | Yes, written from the spec text |
| Signing, replay, wrong-price, wrong-payee, sponsored-gas and failed-simulation cases | Tested (`test/x402.test.js`) with real signatures and a stand-in network |
| A real payment settled on Sui mainnet through this route | Yes, 10 Nov 2026: 0.001 SUI, [2AzVXWV2Jnntsk5zSijwGBWaxAMPCXRpcFNS4z5qUaL6](https://suiscan.xyz/mainnet/tx/2AzVXWV2Jnntsk5zSijwGBWaxAMPCXRpcFNS4z5qUaL6). The same payment sent again was refused (HTTP 409). That run used this code in my own process. A second payment settled on the live server at paycheck-sui-app.onrender.com: 0.001 SUI, [25tg8MvEfVs4V1GMa8JfbtTK4iEofAYwn4bSCnaJ9TYt](https://suiscan.xyz/mainnet/tx/25tg8MvEfVs4V1GMa8JfbtTK4iEofAYwn4bSCnaJ9TYt), check answered "pay". Record: `data/x402/latest.json`. Rerun: `node --env-file=.env agent/x402-client.js --run` |
| Works with other people's x402 clients and facilitators | Not tested. The foundation's `@x402/sui` package is still an open pull request, so I wrote the server side from the spec instead |
| No outside facilitator | Correct: this server verifies and settles by itself. It is not listed in any facilitator directory |
| MPP | Not claimed |

## Why the plain route stays

The plain route needs no signing library on the caller's side beyond sending SUI, so it stays as the simple option. Earlier (9 Nov 2026) I looked at ready-made Sui x402 packages (`@t2000/sui-x402`, `x402-sui`) and MPP (`@suimpp/mpp`); the ones I found take USDC, and none was run.

## Is it switched on?

Paid checks run only when the server has a receiving address (`PAID_CHECK_PAYEE`, or `SUI_ADDRESS`). `GET /api/stats` shows `paidChecks.enabled` as true or false. When it is false the route answers 503.
