import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../server.js';

const W = '0x' + 'a'.repeat(64);
const memory = { health: async () => true, failed: () => [], pending: () => [], counter: () => ({ stored: 0, prescan: 0, test: 0, changed: 0 }) };
const checker = { mode: 'test', state: { lastRecallOk: true }, check: async (address) => ({ address, verdict: 'do not pay', code: 'GROUP_BAD_OUTCOME', reason: 'linked to a bad payment', evidence: [{ basis: 'fact', detail: 'same funder' }], memoryIds: ['m1'] }) };

async function serve(opts = {}) {
  const app = createApp({ checker, memory, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => { app.locals.stop(); server.close(); server.closeAllConnections?.(); } };
}

test('/mcp: a real MCP client lists check_payee and gets a verdict over HTTP', async () => {
  const s = await serve();
  try {
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`)));
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ['check_payee']);
    const res = await client.callTool({ name: 'check_payee', arguments: { address: W } });
    assert.equal(res.structuredContent.verdict, 'do not pay');
    assert.deepEqual(res.structuredContent.memoryIds, ['m1']);
    await client.close();
  } finally { s.close(); }
});

test('/mcp: GET and DELETE answer 405, not a hang', async () => {
  const s = await serve();
  try {
    assert.equal((await fetch(`${s.base}/mcp`)).status, 405);
    assert.equal((await fetch(`${s.base}/mcp`, { method: 'DELETE' })).status, 405);
  } finally { s.close(); }
});

test('/mcp: calls share the per-visitor limit', async () => {
  const s = await serve({ checkLimit: { max: 1, windowMs: 3600000 } });
  try {
    const call = () => fetch(`${s.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 429);
  } finally { s.close(); }
});
