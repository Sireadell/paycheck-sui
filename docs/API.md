# API contract

All answers are JSON. The web layer only calls these endpoints.

| Endpoint | Purpose |
|---|---|
| GET /api/check?address=0x...&memory=on | Check an address. Returns `{verdict, code, reason, evidence[], memoryIds[], retryable, nextAction}` plus the call log |
| POST /api/outcome | Report "paid fine" or "went bad" for an address. Needs the report token (see below) |
| GET /api/stats | Memory counters and Tatum call totals |
| GET /health | Returns `ok` |

## Addresses

Any Sui address of 1 to 64 hex characters is accepted, in any letter case. It is padded to 64 hex characters, lowercase, with the 0x prefix before it is looked up or compared, so `0x1` becomes `0x` plus 63 zeros and a 1. The answer's `address` field echoes what was sent.

## Limits

| Where | Limit | Over the limit |
|---|---|---|
| GET /api/check | 10 per minute per IP address | 429 with a plain message and a Retry-After header |
| POST /api/outcome | 20 per hour per IP address | 429 as above |
| GET /health | none | always answers |
| Provider queue behind a check | at most 100 waiting Tatum calls | the call fails at once with a clear message, the check still answers and lists it in notes |

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
