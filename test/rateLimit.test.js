import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

const checker = { check: async (address) => ({ verdict: 'caution', code: 'INVALID_INPUT', address }), state: {}, mode: 'test', reportOutcome: async () => ({}) };
const memory = { health: async () => true, failed: () => [], pending: () => [], counter: () => ({ stored: 0, prescan: 0, test: 0, changed: 0 }) };

async function serve(extra = {}) {
  const app = createApp({ checker, memory, checkLimit: { max: 3, windowMs: 60000 }, ...extra });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => { app.locals.stop(); server.close(); server.closeAllConnections?.(); } };
}
const get = (base, headers) => fetch(`${base}/api/check?address=0x1`, { headers });

test('behind Cloudflare and the hosting proxy, one visitor is limited even when the edge address changes', async () => {
  const s = await serve();
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      // Same visitor, but the last forwarded address (a Cloudflare edge) differs on every request.
      const r = await get(s.base, { 'cf-connecting-ip': '203.0.113.9', 'cf-ray': `ray-${i}`, 'x-forwarded-for': `203.0.113.9, 172.70.0.${i}` });
      codes.push(r.status);
      if (r.status === 429) {
        assert.ok(Number(r.headers.get('retry-after')) > 0, 'Retry-After is sent');
        assert.match((await r.json()).error, /Too many checks/);
      }
    }
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally { s.close(); }
});

test('two different visitors each get their own count', async () => {
  const s = await serve();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await get(s.base, { 'cf-connecting-ip': '203.0.113.1', 'cf-ray': 'a' })).status, 200);
    assert.equal((await get(s.base, { 'cf-connecting-ip': '203.0.113.1', 'cf-ray': 'a' })).status, 429);
    assert.equal((await get(s.base, { 'cf-connecting-ip': '203.0.113.2', 'cf-ray': 'b' })).status, 200);
  } finally { s.close(); }
});

test('without Cloudflare headers the forwarded address from the hosting proxy is the key', async () => {
  const s = await serve();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await get(s.base, { 'x-forwarded-for': '198.51.100.7' })).status, 200);
    assert.equal((await get(s.base, { 'x-forwarded-for': '198.51.100.7' })).status, 429);
    assert.equal((await get(s.base, { 'x-forwarded-for': '198.51.100.8' })).status, 200);
  } finally { s.close(); }
});

test('a made-up cf-connecting-ip without a cf-ray header does not buy a fresh limit', async () => {
  const s = await serve();
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await get(s.base, { 'cf-connecting-ip': `10.0.0.${i}`, 'x-forwarded-for': '198.51.100.7' })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally { s.close(); }
});
