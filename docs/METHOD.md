# Method


## Pre-scan: which real addresses we scanned

The pre-scan is a set of checks we ran ourselves on public Sui addresses before launch, so the memory is not empty on day one. It is not user activity. Every pre-scan memory is stored with `origin=prescan` in the `live` namespace and is counted on its own line, apart from checks by users and apart from test memories.

### Pick rule (fixed before the run, public, reproducible)

| Step | Rule |
|---|---|
| Start | The latest checkpoint Tatum reports when the first run begins. It is saved in `data/prescan/progress.json` as `startCheckpoint` |
| Walk | Go down one checkpoint at a time (start, start - 1, start - 2, and so on). Never go below Tatum's data floor |
| Take | In each checkpoint, the first 50 transactions as Tatum lists them. The sender of each transaction that succeeded |
| Skip | Only two things: a sender already picked (duplicates), and the zero address. Nothing is skipped because of how a wallet looks or what its verdict would be |
| Stop | When the list holds the number of addresses asked for. The list is a prefix: the first 20 are also the first 20 of the 200 |
| Order | Exactly the order found, never sorted or re-ranked |

Why this rule: recent senders are real wallets that are active right now, and the rule has no input from outcomes, so we cannot choose easy or flattering wallets. The cost is that very busy automated wallets turn up more often than quiet personal ones. We keep them in and report how many of the results are shared services.

### What is stored

| Item | Detail |
|---|---|
| Check | The same pipeline as a user check (Tatum, Ankr cross-check, memory recall, the rules in `VERDICT_RULES.md`) |
| Memory | One `verdict` memory per address, namespace `live`, `origin=prescan`, body marked `prescan: true`. Written in batches of 20 |
| Raw record | Every verdict is also saved as one line in `data/prescan/verdicts.jsonl`, the pick list and progress in `data/prescan/progress.json` |
| Counters | Pre-scan memories never count as user checks and never count as "changed a verdict". Test memories are kept apart as before |
| Reproduce | `node --env-file=.env scripts/prescan.js --count=200`, then compare the pick list with `progress.json`. The checkpoints move on, so a new run starts from a newer checkpoint and finds different wallets. Our list is the saved one |

### Results

Filled in after the run (see the end of this section).


## Real set: real mainnet wallet groups and clean control wallets

The real set is made of real Sui mainnet facts we checked ourselves. A group is a set of wallets where the link is recorded on chain: the same wallet sent the first SUI to each of them, or the same wallet paid the network fee (gas sponsor) for them. Each group stores the addresses, the transaction digests that prove the link, the timestamps and a one-line reason. Controls are wallets with no recorded link. Both come from the same fixed pick rule below, which was written before any pick was made. Nothing is invented: every address and digest was read back from the chain by digest (Tatum, then a second read from Ankr).

### Pick rule (fixed, public, re-derivable by `scripts/build-real-set.js`)

| Step | Rule |
|---|---|
| Sample | Start at checkpoint 342,700,000. Take every 600th checkpoint going down (342,700,000, 342,699,400, ...), at most 60,000 of them. That is about 36 million checkpoints, roughly 100 days up to 7 Nov 2026, all inside Tatum's data window |
| Take | In each sampled checkpoint, the first 50 transactions as Tatum lists them, reading the first 6 balance changes of each (a plain payment has at most 5). Failed transactions are ignored |
| Candidates | Gas sponsor candidate: the sponsor of a sampled transaction whose sponsor is not its sender. New wallet candidate: every receiver of a plain SUI payment, meaning a sampled transaction where every balance change is SUI, the sender is the only payer, there are 1 to 4 receivers, and no sponsor. A new wallet candidate becomes a funder group member or a control, on facts only (see below). Each address is a candidate once per role, in the order found. Nothing is sorted, ranked or skipped for how it looks |
| Read the history | For a candidate, list its transactions oldest first from Tatum's data floor, up to 4 pages of 50 (30 pages, 1,500 transactions, for a gas sponsor). A history longer than that is "too busy to check fully" |
| Gas sponsor group | The sponsor paid the fee for 2 or more different wallets (its own transactions are ignored). Group members are the first 6 of those wallets by time of the first sponsored transaction. Proof digest: that first sponsored transaction |
| Funder group | A new wallet candidate must have a whole history of 50 transactions or fewer whose first item is that payment. Its payer is then tested as a funder when it paid at least one other address within 24 hours of that payment. The funder's history shows SUI sent to 2 or more different addresses, and for each one the first incoming SUI in that address's own history is that payment, with nothing earlier. We check the first 12 recipients in time order. Members are the largest set of verified recipients whose first funding falls inside one 24 hour window, at most 6. Proof digest: the funding transaction |
| Shared service | Judged by the engine's own hub rule (15 or more different wallets over 25 hours or more). Candidates that meet it are not counted as groups. They are listed apart as shared services, with the counts we saw |
| Too busy | If the history is longer than 200 transactions and the part we could read does not already meet the shared service rule, the candidate is skipped and counted in the skipped tally |
| Control | A new wallet candidate whose whole history is 50 transactions or fewer, with no sponsored transactions either way, and whose first incoming SUI came from a funder with a complete history (200 or fewer) that paid no other address within 24 hours of that payment and is not a shared service. A control is accepted or refused on those facts only, never on what the engine answers |
| Stop | 20 groups (at most 12 of each link type) and 20 controls, or 60,000 sampled checkpoints, or the time box. Sampling is a prefix, so the first picks do not change when the run goes longer |
| Probe wallet | In each group the member with the earliest proof timestamp. The engine is run on it with memory off, and also on every member |

Limits we state openly: the pick rule favours wallets that are active in the last 8 days and small enough to read completely, so very busy automated wallets appear mostly as shared services or as skipped. A wallet's "first SUI" is the first one inside Tatum's data window, because older history is not served. Controls have no recorded link we could find, which is not proof that none exists.

Rule history: the first version of this rule (every 20,000th checkpoint, any sender as a control or funder candidate) and two later versions (every 2,000th checkpoint, receivers of two-line payments only) were tried in short runs. They found no group and only a handful of controls, because senders in a sample are mostly busy automated wallets and plain payments are rare. The sampling step and the candidate type were widened to the version above. Every pick found under an earlier version was thrown away, and the final lists come only from a run of the final rule.

A last widening was made after a full pass of 12,000 checkpoints gave only 5 groups: the sample length went from 12,000 to 60,000 checkpoints and the gas sponsor history limit from 500 to 1,500 transactions. The engine had not been run on any case at that time, so no outcome could influence these changes. The first 12,000 checkpoints are a prefix of the final sample.

### How the engine is scored

Memory is off, so no verdict can turn red. A group counts as caught when the engine, run on the probe wallet, shows a counted fact link (shared funder or gas sponsor) whose address is the recorded link address. A control is a false alarm when the engine shows any counted link or any answer other than "pay, no links, no bad history". Every miss and every false alarm is listed with its reason in `data/real-set/results.json`.

Files: `data/real-set/groups.json`, `controls.json`, `results.json`, raw answers in `data/real-set/raw/proof/` (one file per proof digest). Run: `node --env-file=.env scripts/build-real-set.js`, then `node --env-file=.env scripts/score-real-set.js`.

### Real set results

Run of 7 Nov 2026 (engine with memory off, from `node --env-file=.env scripts/score-real-set.js`). Label: real set, real mainnet facts we checked.

| Item | Result |
|---|---|
| Sample used | 57,631 sampled checkpoints (the run stopped when 20 groups and 20 controls were found), about 3,900 calls to Tatum |
| Groups | 20 (8 same gas sponsor, 12 same first funder), 70 member wallets, every proof digest read back from Tatum and from Ankr, both agree on sender, gas payer and success |
| Controls | 20, same pick rule |
| Caught | 18 of 20 groups (gas sponsor 7 of 8, funder 11 of 12). Counting every member wallet, 57 of 70 |
| False alarms | 3 of 20 controls. All three are round trips: the wallet sent money back to its own funder, which the rules answer with caution (a fact, not proof of harm) |
| Misses | rs-15 (gas sponsor): the sponsored transactions are not among the wallet's oldest 50, which is all the engine reads. rs-19 (funder): the engine showed no link to the recorded funder |
| Shared services | 84 candidates met the engine's rule (15 or more wallets over 25 hours or more). The engine itself named only 18 of them as shared services, because it reads only the oldest 50 transactions of a funder or sponsor. The other probes showed them as an ordinary link or no link |
| 15 and 25 hour check | Largest real group saw 14 wallets (rs-12). Smallest shared service saw 15 wallets over 37 hours. So 15 splits what we saw, but the shared service list is defined by that same rule, so this does not prove the value. No burst (15 or more wallets inside 25 hours) was seen. 32 of the 84 shared services spanned under 100 hours and 6 under 48 hours, the shortest 33 hours |
| Skipped | Sponsor candidates with a single wallet 26, too busy to read fully 15. Funder candidates with no verified pair 20, too busy 4. Control candidates refused: history over 50 transactions 587, first item not the funding 133, funder already used 116, funder history over 200 transactions 70, sponsored gas 8 |

What "checked" means here: each group was read back digest by digest from two independent providers by script, and the group listing was printed and read. It is not an explorer click-through of all 70 wallets. Each group also carries suiscan links for a person to open.

Known limits of this set: most groups are small (2 to 9 wallets), because the pick rule only accepts wallets whose history we can read completely. Controls are young wallets with short histories. Both are listed in the pick rule above. Caught is measured with memory off, so it measures link finding only; the memory effect is measured in the benchmark step.


### Pre-scan results (first run)

| Item | Result |
|---|---|
| Start checkpoint | 342704139 |
| Scanned, stored (origin=prescan, live namespace), recalled by exact address | 20, 20, 20 |
| By verdict | pay 20, caution 0, do not pay 0 |
| By kind | shared service 0, linked 4, no history 16 |
| Scale to 200 | Stopped by the data provider (Tatum HTTP 429) while picking wallets 85 and on. The 20 above stand. See the scale-up note in the build log |

A "shared service" here means the scanned wallet itself paid many different wallets over a long time, read from the same page of history the check already reads. "Linked" means the wallet has a real on-chain link (shared funder or gas sponsor) and no bad history is stored. Neither is a safety judgement.


### Benchmark split rule (plain AI, checker, checker with memory)

The split below is fixed and public. It was written down before the benchmark ran and it never looks at an outcome or a result.

| Item | Rule |
|---|---|
| Cases | The real set: for each of the 20 groups, its recorded probe wallet. All 20 controls. Another case file with the same shape (`groups`, `controls`) can be added later with `--cases=<file>` and gets the same rule |
| Same input for every column | The plain AI, the checker without memory and the checker with memory read the same saved raw answers: the wallet's oldest 50 transactions, and the first 50 of its first funder and of its gas sponsor. The run makes no Tatum or Ankr calls. A case without saved raw data is skipped and listed, never fetched |
| Held out (scored) | Each group's probe wallet. Every second control in id order starting with the second (rc-02, rc-04 and so on). That is 20 group cases and 10 control cases |
| Training (memory learns from these) | For each group, the first listed member that is not the probe: memory is told its payment went bad. Every first, third, fifth control: memory is told its payment went fine. A training wallet is never a scored case |
| Namespace | Memory is written and read only in `bench-train`. The live namespace is never written or read by the benchmark, and nothing here is counted in a live number or in the pre-scan number |
| Memory changed a verdict | A held-out case where the answer with memory differs from the answer with memory off, in the same run |
| Plain AI | Gemini, temperature 0, one run per case, the fixed prompt in `bench/prompt.txt`, the raw answers kept in `bench/raw/`. The model name is stored in the result file |
| Columns scored | Link found: the column names the recorded link address. Do not pay, and caution or worse, on groups. False alarm strict (do not pay) and including caution, on controls |

What this does and does not show. The outcome reports used for training are put in by the benchmark (a group member is marked as a payment that went bad), because the real set has no recorded losses. So it measures one thing: when one wallet of a linked group has a stored bad report, does a different, never-seen wallet of the same group get stopped, and are unlinked wallets left alone. It does not measure how often real payments go bad. Held-out groups share a funder or gas sponsor with their training wallet by construction, which is the case memory is built for.


### What the memory test measures, and the fourth column (added 7 Nov, step 2.2b)

In this test a report about one wallet in a group is given to memory, and we measure whether the rest of the group is stopped. It tests whether memory spreads a warning, not how well we find bad wallets. The "do not pay" count in the memory column is by construction: one training member of each group is marked as a payment that went bad, because the real set has no recorded losses.

A fair question is why not just put that report into the AI's prompt. So the benchmark has a fourth column, "plain AI + report". It is the same model, the same fixed prompt style (`bench/prompt-report.txt`), temperature 0, one call per case, the same saved raw transactions, plus the same report text that memory receives for that group (the report about the training member: its address, its first funder and its gas fee payer). Held-out controls get "(no reports)", the same as memory, which holds nothing for them. No Tatum or Ankr call is made. The answers are cached in `bench/raw/<model>/` as `real-<case>-report.json`.

Result on the real set, 30 held-out cases (20 group probes, 10 controls), gemini-3.1-flash-lite:

| | Plain AI | Plain AI + report | Checker | Checker + memory |
|---|---|---|---|---|
| Groups answered "do not pay" | 5 of 20 | 18 of 20 | 0 of 20 | 18 of 20 |
| Groups where the right link was named | 17 of 20 | 8 of 20 | 18 of 20 | 18 of 20 |
| Controls wrongly told "do not pay" | 3 of 10 | 3 of 10 | 0 of 10 | 0 of 10 |
| Controls wrongly told "do not pay" or "caution" | 4 of 10 | 5 of 10 | 1 of 10 | 1 of 10 |

Plain AI with the report matches checker plus memory at stopping group wallets (18 of 20 each), and it has more false alarms on controls (3 of 10 against 0 of 10). So the value of memory is not smarter reasoning. It is a shared, persistent, cross-agent report that every agent reads without being told. In this test the AI only had the report because the benchmark pasted it in; a real agent would need something to carry the report to it, which is what memory does.

The baseline model is small (gemini-3.1-flash-lite). Stronger models were over quota on the key used, or limited to 20 calls a day, so they could not run 60 or 80 calls. A stronger model may beat us. The benchmark supports `--model=<name>`, and its answers are cached under that model's own folder.

Where the checker with memory did not do well: rs-20, rc-12, rs-19 and rs-15. They are listed on the first screen.


## Read depth (how many transactions of a wallet are read)

The checker has a setting, `maxTx`: how many of a wallet's oldest transactions it reads, and the same for its first funder and its gas sponsor. The default is 50 (one call per wallet). It can be set up to 200 (up to 4 calls per history, each page asking for transactions after the same data floor). More than 200 is not allowed, so one check cannot use up the data provider quota: at most 12 history calls plus 2 small reads.

| Published number | Read depth used |
|---|---|
| Real set, 18 of 20 groups caught, 3 of 20 controls with caution | 50 |
| Real set, same run at depth 200 (`results-tx200.json`): 19 of 20 caught, 3 of 20 controls with caution, 0 of 20 strict false alarms | 200 |
| Shared services named: 18 of 84 at depth 50, 29 of 84 at depth 200 | 50 and 200 |
| Benchmark (plain AI, checker, checker with memory, plain AI with report) | 50 (saved raw answers, no new reads) |
| Pre-scan (20 and 200 scanned addresses) | 50 |
| First screen figures and live checks (default) | 50 |
| Cross-agent proof run | 50 |

Cost at depth 200 on the real set: 4.79 calls to Tatum per check on average (largest 13), against 3.10 (largest 4) at depth 50, so 1.69 more calls per check on average. Depth 200 left the strict false alarms at 0 of 20. rs-19 (funder) is now caught. rs-15 (gas sponsor) is still missed: its sponsored transactions lie beyond the oldest 200.
