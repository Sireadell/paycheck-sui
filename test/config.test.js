import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { fakeEnv } from './helpers/env.js';

test('config loads with required names and defaults the relayer', () => {
  const c = loadConfig(fakeEnv);
  assert.equal(c.MEMWAL_RELAYER_URL, 'https://relayer.memory.walrus.xyz');
});
