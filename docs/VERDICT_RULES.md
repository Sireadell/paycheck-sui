# Verdict rules

PayCheck gives one of three answers: **pay**, **caution** or **do not pay**. The first rule that matches wins.

The main idea: being linked to other wallets is not unsafe. Exchanges and payroll wallets fund lots of honest wallets. A link on its own never gives "do not pay". You only get a red answer when a stored report of a bad payment reaches this wallet through a real link.

| # | When | Answer | Code | Rests on |
|---|---|---|---|---|
| 1 | Someone reported a bad payment to this exact address | do not pay | OUTCOME_BAD_SELF | REPORT |
| 2 | A bad payment was reported for a wallet with a direct link to this one: the same first funder (not a shared service), the same gas sponsor (not a shared service), the same group, or the funder or sponsor itself | do not pay | GROUP_BAD_OUTCOME | FACT (the link) + REPORT |
| 3 | The bad report reaches this wallet only through a shared service | caution | HUB_BAD_OUTCOME | GUESS (shared service) + REPORT |
| 4 | The bad report reaches this wallet through a link we have not yet checked for being a shared service | caution | LINK_NOT_CHECKED | FACT + REPORT |
| 5 | This wallet sent money straight back to its own first funder | caution | ROUND_TRIP_TO_FUNDER | FACT |
| 6 | Linked to other wallets, but there is no bad report anywhere in the group | pay ("linked, no bad history") | LINKED_NO_BAD_HISTORY | FACT |
| 7 | No links and no reports | pay ("no links, no bad history") | NO_LINKS_NO_BAD_HISTORY | FACT |
| - | Not a Sui address | caution | INVALID_INPUT | - |
| - | Chain data could not be read (rule 1 still applies) | caution | DATA_UNAVAILABLE | - |

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
