# PayCheck Sui as an MCP tool

One tool, `check_payee(address)`. An AI agent calls it before paying a Sui address. It runs the same check as the website and returns:

| Field | Meaning |
|---|---|
| `verdict` | `pay`, `caution` or `do not pay`, plus `code` and a plain `reason` |
| `evidence` | Each row labelled `FACT` (read on chain), `GUESS` (behaviour rule) or `report` (a memory stored by another agent) |
| `memoryIds`, `citations` | The Walrus Memory entries behind the answer, with who reported them, the address they were about, and the link used |
| `nextAction`, `retryable`, `notes` | What to do next and anything that could not be read |

Do not sign the payment on `do not pay`.

## Hosted address (no setup)

The live server runs the same tool at `https://paycheck-sui-app.onrender.com/mcp` (MCP over HTTP, no session). No keys, nothing to install.

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http paycheck-sui https://paycheck-sui-app.onrender.com/mcp` |
| Clients that take a URL (Cursor, others) | Add a server of type `http` with that URL |
| Clients that only run local tools | `npx mcp-remote https://paycheck-sui-app.onrender.com/mcp` |

Limits: 10 calls a minute per visitor, shared with `/api/check`. `GET` and `DELETE` on `/mcp` answer 405.

## Run it yourself

## Setup

1. Clone the repo and run `npm install`.
2. Copy `.env.example` to `.env` and fill in the Tatum key and the Walrus Memory keys (the same ones the website uses).
3. Optional: set `PAYCHECK_MODE=live` to read and write the live memory space. The default is the labelled test space.

## Client config (Claude Desktop, Claude Code, Cursor and others)

Replace the path with your own folder.

```json
{
  "mcpServers": {
    "paycheck-sui": {
      "command": "node",
      "args": ["--env-file=C:/path/to/total-recall/.env", "C:/path/to/total-recall/mcp/server.js"]
    }
  }
}
```

For Claude Code: `claude mcp add paycheck-sui -- node --env-file=C:/path/to/total-recall/.env C:/path/to/total-recall/mcp/server.js`

The server talks over stdio. It prints nothing else to standard output, so it is safe to wire in as is.

## Notes

- A check reads the wallet, its first funder and its gas sponsor from Tatum, so a single call makes several Tatum requests. The client limits itself to 2.5 requests per second (the free Tatum plan allows 3).
- The verdict is also saved as a memory in the background (a single save took 15 to 25 seconds when we measured it), as with the website.
