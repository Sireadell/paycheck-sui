# API contract

All answers are JSON. The web layer only calls these endpoints.

| Endpoint | Purpose |
|---|---|
| GET /api/check?address=0x...&memory=on | Check an address. Returns `{verdict, code, reason, evidence[], memoryIds[], retryable, nextAction}` plus the call log |
| POST /api/outcome | Report "paid fine" or "went bad" for an address. Needs the report token (see below) |
| POST /api/paid/check | Buy a check with plain SUI. First call answers 402 with an amount and id; second call carries the payment digest. See PAYMENTS.md |
| GET /api/stats | Memory counters and Tatum call totals |
| GET /health | Returns `ok` |
| GET /api/failures | Every miss, false alarm and failed recall in the saved results, recounted from the rows. The same data is shown at `/failures` |

## Addresses

An address is read in one place (`src/address.js`). Surrounding spaces are ignored. A Sui address of 1 to 64 hex characters after `0x` (or `0X`) is accepted in any letter case and is padded to 64 hex characters, lowercase, before it is looked up or compared, so `0x1` becomes `0x` plus 63 zeros and a 1. The answer's `address` field echoes what was sent.

Anything else is refused with HTTP 400, `verdict: "caution"`, `code: "INVALID_INPUT"`, `retryable: false`, a plain `reason`, and an `inputCode`. No chain read or memory read is made for it, and nothing is saved.

| inputCode | Sent |
|---|---|
| EMPTY_ADDRESS | Nothing, spaces only, or just `0x` |
| MISSING_0X | Hex without the leading `0x` |
| NOT_HEX | Anything with characters other than 0 to 9 and a to f after `0x`, including unicode and other chains' text |
| TOO_LONG | More than 64 hex characters |
| ETHEREUM_ADDRESS | Exactly 40 hex characters (the Ethereum shape, a likely wrong-chain mistake) |
| NAME_NOT_SUPPORTED | A SuiNS name such as `alice.sui` or `@alice`. Names are not looked up |

## Limits

| Where | Limit | Over the limit |
|---|---|---|
| GET /api/check | 10 per minute per IP address | 429 with a plain message and a Retry-After header |
| POST /api/outcome | 20 per hour per IP address | 429 as above |
| GET /health | none | always answers |
| Provider queue behind a check | at most 100 waiting Tatum calls | the call fails at once with a clear message, the check still answers and lists it in notes |

### Who counts as one visitor

The limits are counted per visitor, in the memory of the one server process (a restart resets them). Behind the host's proxy and Cloudflare the visitor is read from the `cf-connecting-ip` header, which Cloudflare sets together with `cf-ray`. A `cf-connecting-ip` header without `cf-ray` is ignored. When neither is present, the address Express reads from one trusted proxy hop (`X-Forwarded-For`) is used. An answer over the limit is HTTP 429 with a `Retry-After` header in seconds and `retryable: true`.

## Reporting an outcome

POST /api/outcome needs the report token, sent as the header `x-outcome-token: <token>` or `Authorization: Bearer <token>`. The server reads the token from the environment variable OUTCOME_TOKEN. With no token or a wrong one the answer is 401 and nothing is written. If the server has no OUTCOME_TOKEN set, every report gets 401.

Body: `{"address": "0x...", "outcome": "bad" or "good", "reporter": "optional name"}`.

Command line: `npm run outcome -- <address> <bad|good>` writes directly. With PAYCHECK_URL set it posts to that server and sends OUTCOME_TOKEN from the environment.

## Read-only pages data

| Endpoint | Purpose |
|---|---|
| GET /api/benchmark | Real set numbers from `data/real-set/results.json` and, when `bench/results/stress.json` exists, the stress test numbers (labelled synthetic) |
| GET /api/cross-agent | The last two-agent demo run from `data/cross-agent/latest.json`. 404 `{available:false}` until one exists |

The first screen (`web/`) is served from `/` and calls only the endpoints in this file.
