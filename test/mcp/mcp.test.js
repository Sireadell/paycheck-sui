import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPayeeServer, toToolResult } from '../../mcp/server.js';

const W = '0x' + 'a'.repeat(64);
const fakeAnswer = {
  address: W, verdict: 'do not pay', code: 'GROUP_BAD_OUTCOME', reason: 'linked to a bad payment',
  evidence: [
    { kind: 'link', basis: 'fact', detail: 'same funder' },
    { kind: 'behaviour', basis: 'guess', detail: 'fresh wallet' },
    { kind: 'memory', basis: 'report', memoryId: 'blob1' },
  ],
  memoryIds: ['blob1'],
  warnedBy: [{ memoryId: 'blob1', reporter: 'agent-a', reportedAddress: '0x' + 'b'.repeat(64), crossAddress: true, via: 'funder' }],
  nextAction: 'Do not sign.', retryable: false, memory: { used: 1, recalled: 3, recallOk: true },
};

async function connect(check) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createPayeeServer({ check }).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return client;
}

test('the server lists exactly one tool, check_payee', async () => {
  const client = await connect(async () => fakeAnswer);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['check_payee']);
});

test('check_payee returns verdict, labelled evidence and memory citations', async () => {
  const seen = [];
  const client = await connect(async (a) => { seen.push(a); return fakeAnswer; });
  const res = await client.callTool({ name: 'check_payee', arguments: { address: W } });
  assert.deepEqual(seen, [W]);
  const out = res.structuredContent;
  assert.equal(out.verdict, 'do not pay');
  assert.deepEqual(out.evidence.map((e) => e.label), ['FACT', 'GUESS', 'report']);
  assert.deepEqual(out.memoryIds, ['blob1']);
  assert.equal(out.citations[0].reporter, 'agent-a');
  assert.equal(out.citations[0].crossAddress, true);
  assert.equal(JSON.parse(res.content[0].text).verdict, 'do not pay');
});

test('a failing check comes back as a tool error, not a crash', async () => {
  const client = await connect(async () => { throw new Error('tatum down'); });
  const res = await client.callTool({ name: 'check_payee', arguments: { address: W } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /tatum down/);
});

test('toToolResult copes with an answer that has no evidence', () => {
  const o = toToolResult({ address: W, verdict: 'pay', code: 'OK', reason: 'r' });
  assert.deepEqual(o.evidence, []);
  assert.deepEqual(o.citations, []);
});
