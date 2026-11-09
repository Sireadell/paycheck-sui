# Verdict rules

PayCheck gives one of three answers: **pay**, **caution** or **do not pay**. The first rule that matches wins.

The main idea: being linked to other wallets is not unsafe. Exchanges and payroll wallets fund lots of honest wallets. A link on its own never gives "do not pay". You only get a red answer when a stored report of a bad payment reaches this wallet through a real link.

| # | When | Answer | Code | Rests on |
|---|---|---|---|---|
| 1 | Someone reported a bad payment to this exact address | do not pay | OUTCOME_BAD_SELF | REPORT |
| 2 | A bad payment was reported for a wallet with a direct link to this one: the same first funder (not a shared service), the same gas sponsor (not a shared service), the same group, or the funder or sponsor itself | do not pay | GROUP_BAD_OUTCOME | FACT (the link) + REPORT |
| 3 | The bad report reaches this wallet only through a shared service | caution | HUB_BAD_OUTCOME | GUESS (shared service) + REPORT |
| 3b | A bad report about another wallet, or about the funder itself, reaches this wallet only because they share a first funder that paid 15 or more wallets in under 25 hours, and this wallet is not in that funder's group | caution | BUSY_FUNDER_BAD_OUTCOME | FACT (same first funder) + GUESS (busy service) + REPORT |
| 4 | The bad report reaches this wallet through a link we have not yet checked for being a shared service | caution | LINK_NOT_CHECKED | FACT + REPORT |
| 5 | This wallet sent money straight back to its own first funder | caution | ROUND_TRIP_TO_FUNDER | FACT |
| 6 | Linked to other wallets, but there is no bad report anywhere in the group | pay ("linked, no bad history") | LINKED_NO_BAD_HISTORY | FACT |
| 7 | No links and no reports | pay ("no links, no bad history") | NO_LINKS_NO_BAD_HISTORY | FACT |
| - | Not a Sui address | caution | INVALID_INPUT | - |
| - | Chain data could not be read (rule 1 still applies) | caution | DATA_UNAVAILABLE | - |
| - | The shared memory could not be read fully (timed out or failed, after one retry) and the answer would have been "pay" | caution, `retryable: true` | MEMORY_UNAVAILABLE | - |
| - | The address has no transactions and no SUI balance, and the answer would have been "pay" | caution | NO_HISTORY | FACT (nothing found) |

A brand-new or unused wallet cannot be judged, and a mistyped address looks exactly the same, so it never gets "pay". The check reads the balance in the same moment as the first page of history, so it adds one Tatum call but no waiting. A stored bad report on the exact address still gives "do not pay". A check that ends this way is not saved as a memory.
| - | The address is a Sui package or another object, not a wallet, and the answer would have been "pay" | caution | PAYEE_NOT_A_WALLET | FACT (read on chain) |

The check asks Tatum whether an object or package exists at the address (the same call that reads the balance). Wallets have no object at their address, so this has no false alarms on wallets. If that read fails the check is skipped and a note says so. A stored bad report still wins.

When the shared memory cannot be read fully, a "pay" becomes caution, because nobody could look for a report of a bad payment. A "do not pay" stays as it is. Another caution keeps its own code and gets the same note added to its reason. The "without memory" side of the answer is not changed. A check that ended this way is not saved as a new memory. The web page shows the caution with a Retry button.

Rule 3b exists because a busy payout wallet can look like a farm: it pays many wallets in a short run. One report about one of its wallets must not turn all the others red. The red answer (rule 2) is kept when this wallet sits in the funder's group by the 24 hour window, or when the funder paid fewer than 15 wallets. Measured on the real set, this changes nothing: 18 of 20 groups found at depth 50, 19 of 20 at depth 200, 0 of 20 ordinary wallets told "do not pay", 3 of 20 with caution.

## What each signal is

| Signal | Label | What it means |
|---|---|---|
| Same first funder | FACT | The same address sent the first SUI to both wallets, inside a 24 hour window |
| Same gas sponsor | FACT | Sui records who paid the fee for a transaction, and both wallets had their fee paid by the same address |
| Money sent back to the funder | FACT | There is a transfer on chain. What it means is left open, which is why it only gives caution |
| Shared service (hub) | GUESS | A funder or sponsor that reached 15 or more wallets over 25 hours or more. We read that as a service, so it counts as a weak link. The 15 and 25 are values we picked, and we recheck them against real data |
| Burst | GUESS | 15 or more wallets inside 25 hours. That looks like a farm, so it still counts as a link |
| Same amount, different funders, within 10 minutes | GUESS | Funded at the same moment for the same amount. It is listed as a link, but on its own it never makes an answer red |
| Known exchange | FACT (cited label) | We only list an exchange when a public label source backs it. The list may be empty |
| Bad or good outcome | REPORT | A stored memory from an agent that paid. Each answer shows its memory id and who reported it |

## Limits we state openly

| Limit | Why |
|---|---|
| A single bad report is enough to make a direct link red | That is how one agent warns all the others. The answer always shows who reported it and the memory id |
| A brand new farm with no reports gets "pay, linked, no bad history" | Memory can't protect the first wallet in a new group. The links still appear on screen |
| A slow farm that looks like a shared service gets caution at most | We accept this so that one report can't turn every exchange customer red |
| A "paid fine" report never makes an answer greener | Good reports are shown, but the rules decide |
| Test memories never change an answer | They are kept apart and counted separately |
