# API contract

All answers are JSON. The web layer only calls these endpoints.

| Endpoint | Purpose |
|---|---|
| GET /api/check?address=0x...&memory=on | Check an address. Returns `{verdict, code, reason, evidence[], memoryIds[], retryable, nextAction}` plus the call log |
| POST /api/outcome | Report "paid fine" or "went bad" for an address |
| GET /api/stats | Memory counters and Tatum call totals |
| GET /health | Returns `ok` |
