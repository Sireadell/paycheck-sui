# Reproduce the numbers

Every number on the `/proof` page can be rechecked with one command. You need Node 22 and a clone of this repository. Nothing is installed beyond `npm install`.

## 1. Recount the saved results (no keys, no network, a few seconds)

```
npm install
npm run reproduce
```

This reads the saved result files, recounts every number row by row (not from the stored totals), prints them in the same wording as the `/proof` page, and checks three things: the recount matches the totals stored in the files, every count appears on the page exactly as printed, and the four loss cases on the page are the ones the recount finds. The last line is `0 differences` when all of it agrees. If anything differs, each difference is printed and the command exits with code 1.

| What is recounted | Saved file |
|---|---|
| 18 of 20 real groups found, wallets tied back, ordinary wallets left alone | `data/real-set/results.json` |
| The four columns on the 30 held-back wallets, and the four loss cases | `bench/results/real.json` |
| 171 of 200 pre-scan memories recalled and verified | `data/prescan/verified.json` |
| Stress test, two-agent run, refuse then pay, paid check | `bench/results/stress.json`, `data/cross-agent/latest.json`, `data/refuse-then-pay/latest.json`, `data/paid-check/latest.json`. These print "not yet run" until the file exists |

To see the page itself:

```
npm start
```

Then open `http://localhost:3000/proof`. The same data is at `/api/proof`.

## 2. Run it again on the chain (needs keys, a few minutes)

```
npm run reproduce -- --live
```

Put your own keys in a `.env` file first (see `.env.example` if present): `TATUM_API_KEY_MAINNET`, and `ANKR_API_KEY` for the second opinion.

This checks the 20 group wallets and the 20 ordinary wallets again with the real checker, memory off, and compares each one with the saved run. It reads the chain only. It writes no memory and changes no saved result.

| Limit | Value |
|---|---|
| Tatum requests | 2.5 a second (the free plan allows 3) |
| Ankr requests | 4 a second |
| Failed or rate-limited calls | retried up to 5 times with a growing pause |
| Time | A few minutes for a first run |

Answers are cached in `data/real-set/raw/cache`. That folder is not in the repository, so a fresh clone makes every call for real. If you run it twice on one machine, the second run reads the cache; delete that folder to go out to the network again.

The live chain keeps moving. A wallet's history only grows, but the checker reads the oldest 50 transactions of each wallet, so a result can still shift if a provider changes what it returns. Any difference is printed, not hidden.

## 3. Run the tests

```
npm test
```

No keys needed. The tests use recorded answers.
