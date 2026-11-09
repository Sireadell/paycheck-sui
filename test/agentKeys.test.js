import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keyFor, sdkFactoryFromConfig } from '../src/memory/index.js';
import { loadConfig } from '../src/config.js';
import { fakeEnv } from './helpers/env.js';

const cfg = loadConfig({ ...fakeEnv, MEMWAL_DELEGATE_PRIVATE_KEY: 'key-a', MEMWAL_AGENT_B_DELEGATE_PRIVATE_KEY: 'key-b' });

test('agent B signs with its own key, everyone else with the main key', () => {
  assert.equal(keyFor(cfg, 'b'), 'key-b');
  assert.equal(keyFor(cfg, 'a'), 'key-a');
  assert.equal(keyFor(cfg, undefined), 'key-a');
});

test('agent B falls back to the main key when no key of its own is set', () => {
  const plain = loadConfig({ ...fakeEnv, MEMWAL_DELEGATE_PRIVATE_KEY: 'key-a' });
  assert.equal(keyFor(plain, 'b'), 'key-a');
});

test('both keys act on the same Walrus Memory account', () => {
  const same = loadConfig({ ...fakeEnv, MEMWAL_ACCOUNT_ID: '0xacc', MEMWAL_DELEGATE_PRIVATE_KEY: 'key-a', MEMWAL_AGENT_B_DELEGATE_PRIVATE_KEY: 'key-b' });
  assert.equal(typeof sdkFactoryFromConfig(same, { agent: 'b' }), 'function');
  assert.equal(same.MEMWAL_ACCOUNT_ID, '0xacc');
});

test('agent B program asks for its own key and the pay agent does not', () => {
  assert.match(readFileSync(new URL('../agent/agent-b.js', import.meta.url), 'utf8'), /agent: 'b'/);
  assert.doesNotMatch(readFileSync(new URL('../agent/agent-a.js', import.meta.url), 'utf8'), /agent: 'b'/);
});
