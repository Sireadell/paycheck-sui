import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

const memory = { health: async () => true, failed: () => [], pending: () => [], counter: () => ({ stored: 0, prescan: 0, test: 0, changed: 0 }) };
const checker = {
  mode: 'test',
  state: { lastRecallOk: true },
  check: async (address) => ({ address, verdict: 'pay' }),
  reportOutcome: async (address, outcome) => ({ address, outcome, written: [] }),
};

async function serve(opts = {}) {
  const app = createApp({ checker, memory, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { app.locals.stop(); server.close(); server.closeAllConnections?.(); } };
}
const post = (base, headers = {}) => fetch(`${base}/api/outcome`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ address: '0x1', outcome: 'bad' }) });

test('/api/outcome: 401 without a token or with a wrong one, 200 with the right one', async () => {
  const s = await serve({ outcomeToken: 'secret-token' });
  try {
    assert.equal((await post(s.base)).status, 401);
    assert.equal((await post(s.base, { 'x-outcome-token': 'wrong' })).status, 401);
    assert.equal((await post(s.base, { 'x-outcome-token': 'secret-token-longer' })).status, 401);
    assert.equal((await post(s.base, { 'x-outcome-token': 'secret-token' })).status, 200);
    assert.equal((await post(s.base, { authorization: 'Bearer secret-token' })).status, 200);
  } finally { s.close(); }
});

test('/api/outcome: 401 for everyone when the server has no token set', async () => {
  const s = await serve({ outcomeToken: '' });
  try {
    assert.equal((await post(s.base)).status, 401);
    assert.equal((await post(s.base, { 'x-outcome-token': '' })).status, 401);
  } finally { s.close(); }
});

test('/api/outcome: reports per IP are limited', async () => {
  const s = await serve({ outcomeToken: 't', outcomeLimit: { max: 2, windowMs: 3600000 } });
  try {
    assert.equal((await post(s.base, { 'x-outcome-token': 't' })).status, 200);
    assert.equal((await post(s.base, { 'x-outcome-token': 't' })).status, 200);
    const r = await post(s.base, { 'x-outcome-token': 't' });
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /Too many reports/);
  } finally { s.close(); }
});

test('/api/check: the 11th call in a minute from one IP gets 429, /health stays open', async () => {
  const s = await serve();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${s.base}/api/check?address=0x1`)).status, 200);
    const r = await fetch(`${s.base}/api/check?address=0x1`);
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /Too many checks/);
    assert.ok(r.headers.get('retry-after'));
    for (let i = 0; i < 15; i++) assert.equal((await fetch(`${s.base}/health`)).status, 200);
  } finally { s.close(); }
});

test('/api/check: the limit resets after the window', async () => {
  let t = 1000;
  const s = await serve({ checkLimit: { max: 1, windowMs: 60000 }, now: () => t });
  try {
    assert.equal((await fetch(`${s.base}/api/check?address=0x1`)).status, 200);
    assert.equal((await fetch(`${s.base}/api/check?address=0x1`)).status, 429);
    t += 60001;
    assert.equal((await fetch(`${s.base}/api/check?address=0x1`)).status, 200);
  } finally { s.close(); }
});
