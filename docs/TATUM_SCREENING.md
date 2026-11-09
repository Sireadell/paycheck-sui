# Tatum address screening: not used for Sui

Tatum sells an address screening call that says whether an address was reported as malicious. We looked at whether it can be an extra piece of evidence in a check. It cannot, for Sui.

| What | Finding |
|---|---|
| What the docs say | Screening supports Bitcoin, Ethereum, Litecoin, Solana and Tron. Sui is not listed on either of the two docs pages that describe it (the fraud detection page and the Malicious Detection reference). The two pages also disagree on the call itself (`GET /v3/security/address/{address}` against `POST /v4/security/malicious`) |
| A real call with our key | `GET /v3/security/address/<a real Sui wallet>` answered HTTP 200 `{"status":"valid"}`. The same call for a well-known Ethereum address also answered `{"status":"valid"}`. The call has no field to choose a chain |
| What that means | A "valid" for a Sui address is the same answer a clean address of any chain gets, so it does not show that Tatum looked at Sui data at all. Treating it as "clean" would be a false comfort |
| Decision | Not added. No evidence row, no change to any answer. If Tatum lists Sui in its supported chains, the call can be added as a REPORT row that can only raise a payee to caution, never to "do not pay" on its own |
