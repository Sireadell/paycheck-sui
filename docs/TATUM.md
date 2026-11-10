# How PayCheck uses Tatum on Sui

Tested on 10 Nov 2026 with the project's own key. Every row below was run, not read from a summary.

## What is used

| Tatum read | Where | What it is for |
|---|---|---|
| Sui GraphQL: transactions by address | every check | History of the wallet, its first funder and its fee payer |
| Sui GraphQL: address balance and type | every check | Stops "pay" for a package, an object or an empty address |
| Sui GraphQL: latest checkpoint | every check | The "data as of" label |
| Sui GraphQL: transaction by digest | paid checks | Reads the SUI payment back before answering |
| Sui GraphQL: balances, objects and SuiNS name | live server checks | Holdings of the wallet and its funder, shown as evidence only |
| Sui GraphQL: reference gas price | live server checks | The "network fee now" line |
| Sui GraphQL: transactions by address, for the funder of the first funder | live server checks | One extra page of history of the second-hop funder: how many wallets it paid. Evidence only |
| Sui GraphQL: address balance and type, for the funder of the first funder | live server checks | Whether the second-hop funder is a wallet and what it holds. Evidence only |
| Exchange rate (REST, SUI in USD) | paid check price | Shows what the 0.001 SUI price is in dollars |

The check screen lists the real Tatum calls of each check, so the numbers on screen are the numbers the server used.

Who funded the first funder is found in the funder history that is already read, so naming it costs no call. Reading that second funder costs at most 2 extra Tatum calls per check (one history page, one address profile), only on the live server path, and the Tatum panel shows "2 extra Tatum calls" beside the row. If a read fails, only that part of the row is dropped. Wallet age, activity and pass-through are worked out from history already read and cost no call. A bad-outcome report also saves a short profile note (first funder, fee payer, age, transactions read) in shared memory; this uses no Tatum call beyond the history the report already reads.

Holdings never change a verdict. A test runs the same address with holdings on and off and asserts the verdict, reason and evidence are identical, and another test makes both reads fail and checks the answer still comes back. The second-hop reads and the profile note have the same tests: verdict, reason and evidence identical with the feature on and off, the call count capped at 2, and the check still answering when the reads fail (`test/finalRound.test.js`).

## What was tested and left out

| Tatum feature | Result on 10 Nov 2026 | Decision |
|---|---|---|
| Notifications (webhook alerts on an address) | `GET /v4/subscription/chains` with our key lists no Sui chain | Not used. Nothing to subscribe to for Sui |
| Address screening | Documented for Bitcoin, Ethereum, Litecoin, Solana and Tron. Sui answers "valid" like any chain (see TATUM_SCREENING.md) | Not used |
| Sui JSON-RPC | `sui_getLatestCheckpointSequenceNumber` and `suix_getReferenceGasPrice` both answered 404. Tatum's own migration guide says Sui deprecated JSON-RPC in favour of gRPC | Not used. GraphQL answers the same questions |
| Sui gRPC | Exists. Needs protobuf files and a separate client | Not used: it would give the same data through a heavier client |
| WebSocket subscriptions | The "Supported Chains" table lists Solana, Ethereum, Polygon, Arbitrum One, BSC and Robinhood. No Sui | Not used |
| Fee estimation product | Documented for UTXO and EVM chains | Not used. Sui's reference gas price is read through GraphQL instead |
| Named exchange labels for Sui | No Tatum read labels exchanges, and I have not checked a public source for Sui exchange addresses | The exchange list stays empty rather than guess. The shared-service test is behaviour based, not a list |
| Correlated-funding rule | Needs the funding of wallets that other funders paid in the same 10 minutes, which no per-address read returns | Stays off. Turning it on would also change verdicts, and the saved benchmark must not move |

## Limits

Tatum's free plan allows 3 requests a second. The server keeps to 2.5. The holdings read is capped at the first 20 coin types and the first 50 objects of an address, and the screen says "+" when there are more.
