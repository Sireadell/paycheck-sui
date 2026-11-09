# Put the server online (Render)

The server is one Node process (`server.js`). It listens on the port the host gives it (`PORT`) and answers `GET /health` with `ok`. There is no database and no build step: the memory lives in Walrus Memory, and the saved results are files in the repository.

## Steps

| # | Step |
|---|---|
| 1 | In Render, choose New, then Blueprint, and pick this repository. It reads `render.yaml`. |
| 2 | Fill in the secret values it asks for (names below). They are stored by Render, not in the repository. |
| 3 | Deploy. Render waits for `/health` to answer before sending visitors. |
| 4 | Open `/` and `/proof`. Then run one check: `/api/check?address=<a Sui address>&memory=on`. |

Node 22 or newer is required (`NODE_VERSION` is set to 22 in the blueprint).

## Environment variable names

| Name | Needed | What it is for |
|---|---|---|
| `TATUM_API_KEY_MAINNET` | yes | Every chain read |
| `MEMWAL_DELEGATE_PRIVATE_KEY` | yes | Writes and reads in Walrus Memory |
| `MEMWAL_ACCOUNT_ID` | yes | The Walrus Memory account |
| `MEMWAL_AGENT_ID` | no | Agent id shown on memories |
| `MEMWAL_PACKAGE_ID`, `MEMWAL_REGISTRY_ID` | no | Walrus Memory settings |
| `MEMWAL_RELAYER_URL` | no | Defaults to the public relayer |
| `ANKR_API_KEY` | no | Second opinion on chain data |
| `OUTCOME_TOKEN` | no | Lets a caller report "went fine" or "went bad". Without it every report is refused |
| `PAYCHECK_MODE` | no | `test` (default in the blueprint) keeps writes in the labelled test space. `live` writes to the real memory space |

Not needed on the server: `GEMINI_API_KEY` (benchmark only) and the Sui wallet keys.

## Notes

| Topic | Detail |
|---|---|
| `PAYCHECK_MODE` | `test` keeps writes in the labelled test space. `live` writes real memories on mainnet |
| Visitor rate limits | Counted per visitor. The server trusts one proxy hop (`app.set('trust proxy', 1)`) and reads the visitor from `cf-connecting-ip` when Cloudflare sent it with `cf-ray`, so each visitor gets their own limit behind Render (details in API.md) |
| Free plan sleeps | The blueprint uses the paid `starter` plan so the site stays awake. Change `plan` if a slow first load is fine |
