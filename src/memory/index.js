// Memory layer: one Walrus Memory client per namespace, exact-filter recall, idempotent writes,
// a background write queue (writes take 15 to 25 s) and a restore that rebuilds state from Walrus.
import { MemWal } from '@mysten-incubation/memwal';
import { NAMESPACES, buildText, parseMemory, idempotencyKey } from './header.js';
import { loadConfig } from '../config.js';

export * from './header.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sdkFactoryFromConfig(cfg = loadConfig()) {
  return (namespace) => MemWal.create({
    key: cfg.MEMWAL_DELEGATE_PRIVATE_KEY,
    accountId: cfg.MEMWAL_ACCOUNT_ID,
    serverUrl: cfg.MEMWAL_RELAYER_URL,
    namespace,
  });
}

// sdkFactory(namespace) returns an object with rememberAndWait, recall, listMemories, restore, destroy.
export function createMemory({ sdkFactory, retries = 2, retryWaitMs = 2000, writeTimeoutMs = 90000, recallLimit = 20 } = {}) {
  const factory = sdkFactory || sdkFactoryFromConfig();
  const clients = new Map();
  const clientFor = (ns) => {
    if (!NAMESPACES.includes(ns)) throw new Error(`unknown namespace: ${ns}`);
    if (!clients.has(ns)) clients.set(ns, factory(ns));
    return clients.get(ns);
  };

  // ledger: "namespace:idempotency key" -> entry. The counter is built from it.
  const ledger = new Map();
  const changedIds = new Set();
  const queue = [];
  let running = false;
  let idleWaiters = [];

  const view = (e) => ({ key: e.key, namespace: e.namespace, kind: e.kind, origin: e.origin, address: e.address, group: e.group, state: e.state, blobId: e.blobId || null, id: e.id || null, writtenAt: e.writtenAt || null, error: e.error || null });

  async function doWrite(e) {
    const client = clientFor(e.namespace);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await client.rememberAndWait(e.text, e.namespace, { idempotencyKey: e.key, timeoutMs: writeTimeoutMs });
        e.state = 'stored'; e.blobId = r.blob_id; e.id = r.id; e.writtenAt = new Date().toISOString(); e.error = null;
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < retries) await sleep(retryWaitMs);
      }
    }
    e.state = 'failed'; e.error = String(lastErr?.message || lastErr);
  }

  async function drain() {
    if (running) return;
    running = true;
    while (queue.length) await doWrite(queue.shift());
    running = false;
    const w = idleWaiters; idleWaiters = [];
    w.forEach((f) => f());
  }

  return {
    // Background write: returns at once with state 'pending'. The same text twice is one write.
    enqueue({ namespace, kind, address, group, origin, body }) {
      if (!NAMESPACES.includes(namespace)) throw new Error(`unknown namespace: ${namespace}`);
      const text = buildText({ kind, address, group, origin }, body);
      const key = idempotencyKey(text);
      const lk = `${namespace}:${key}`;
      const existing = ledger.get(lk);
      if (existing && existing.state !== 'failed') return view(existing);
      const e = { key, namespace, kind, address: address || null, group: group || null, origin, text, state: 'pending' };
      ledger.set(lk, e);
      queue.push(e);
      drain();
      return view(e);
    },
    // Waiting write, for scripts and tests. Never call this on the screen path.
    async write(memory) {
      const e = this.enqueue(memory);
      await this.flush();
      return this.entry(e.key, e.namespace);
    },
    flush() {
      if (!running && !queue.length) return Promise.resolve();
      return new Promise((r) => idleWaiters.push(r));
    },
    pending() { return [...ledger.values()].filter((e) => e.state === 'pending').map(view); },
    failed() { return [...ledger.values()].filter((e) => e.state === 'failed').map(view); },
    entry(key, namespace) { const e = ledger.get(`${namespace}:${key}`); return e ? view(e) : null; },

    // Exact recall: ask by address or group, keep only results whose header has exactly that value.
    async recall({ namespace, address, group, kind, query, limit = recallLimit }) {
      if (!address && !group) throw new Error('recall needs an address or a group');
      const client = clientFor(namespace);
      const res = await client.recall({ query: query || address || group, limit, namespace });
      const out = [];
      for (const m of res.results || []) {
        const p = parseMemory(m.text);
        if (!p) continue;
        if (address && p.address !== address) continue;
        if (group && p.group !== group) continue;
        if (kind && p.kind !== kind) continue;
        out.push({ blobId: m.blob_id, writtenAt: m.created_at || null, distance: m.distance, ...p });
      }
      return out;
    },

    // Mark memories cited in a verdict that came out different with memory off.
    markChanged(ids) { for (const id of [].concat(ids)) changedIds.add(id); },

    // Counter (plan section 3e). Test memories never count in stored.
    counter() {
      let stored = 0, prescan = 0, test = 0;
      for (const e of ledger.values()) {
        if (e.state !== 'stored') continue;
        if (e.origin === 'k2-test' || e.namespace === 'k2-test') test++;
        else { stored++; if (e.origin === 'prescan') prescan++; }
      }
      return { changed: changedIds.size, stored, prescan, test };
    },

    // Restore: ask Walrus to rebuild the namespace, then rebuild the local ledger from the recalled headers.
    async restore(namespace, { limit = 500, probe = 'PAYCHECK v1' } = {}) {
      const client = clientFor(namespace);
      const r = await client.restore(namespace, limit);
      const res = await client.recall({ query: probe, limit: Math.min(limit, 100), namespace });
      let rebuilt = 0;
      for (const m of res.results || []) {
        const p = parseMemory(m.text);
        if (!p) continue;
        const key = idempotencyKey(m.text);
        const lk = `${namespace}:${key}`;
        if (ledger.has(lk)) continue;
        ledger.set(lk, { key, namespace, kind: p.kind, origin: p.origin, address: p.address, group: p.group, text: m.text, state: 'stored', blobId: m.blob_id, writtenAt: m.created_at || null });
        rebuilt++;
      }
      return { restored: r.restored, skipped: r.skipped, failed: r.failed, total: r.total, rebuilt };
    },

    async listCount(namespace) {
      const client = clientFor(namespace);
      let n = 0, cursor;
      do {
        const p = await client.listMemories({ cursor, limit: 500, namespace });
        n += p.memories.length;
        cursor = p.has_more ? p.next_cursor : null;
      } while (cursor);
      return n;
    },
    listNamespaces: () => clientFor('live').listNamespaces(),
    health: () => clientFor('live').health(),
    compatibility: () => clientFor('live').compatibility(),
    destroy() { for (const c of clients.values()) c.destroy?.(); clients.clear(); },
  };
}
