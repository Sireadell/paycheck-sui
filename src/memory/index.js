// Memory layer: one Walrus Memory client per namespace, exact-filter recall, idempotent writes,
// a background write queue (writes take 15 to 25 s) and a restore that rebuilds state from Walrus.
import { MemWal } from '@mysten-incubation/memwal';
import { NAMESPACES, KINDS, ORIGINS, buildText, parseMemory, idempotencyKey } from './header.js';
import { loadConfig } from '../config.js';

export * from './header.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// agent 'b' signs with its own delegate key when one is set. Same account, different key.
export function keyFor(cfg, agent) {
  return agent === 'b' && cfg.MEMWAL_AGENT_B_DELEGATE_PRIVATE_KEY ? cfg.MEMWAL_AGENT_B_DELEGATE_PRIVATE_KEY : cfg.MEMWAL_DELEGATE_PRIVATE_KEY;
}

export function sdkFactoryFromConfig(cfg = loadConfig(), { agent } = {}) {
  return (namespace) => MemWal.create({
    key: keyFor(cfg, agent),
    accountId: cfg.MEMWAL_ACCOUNT_ID,
    serverUrl: cfg.MEMWAL_RELAYER_URL,
    namespace,
  });
}

// sdkFactory(namespace) returns an object with rememberAndWait, recall, listMemories, restore, destroy.
export function createMemory({ sdkFactory, retries = 2, retryWaitMs = 2000, writeTimeoutMs = 90000, recallLimit = 100, recallConcurrency = 2, recallRetries = 3, recallRetryWaitMs = 1500 } = {}) {
  const factory = sdkFactory || sdkFactoryFromConfig();
  const clients = new Map();
  const clientFor = (ns) => {
    if (!NAMESPACES.includes(ns)) throw new Error(`unknown namespace: ${ns}`);
    if (!clients.has(ns)) clients.set(ns, factory(ns));
    return clients.get(ns);
  };

  // Recalls: at most recallConcurrency at once (many in parallel made the SDK preflight time out), the rest wait in line.
  let recallActive = 0;
  const recallWaiting = [];
  const recallSlot = async () => {
    if (recallActive >= recallConcurrency) await new Promise((r) => recallWaiting.push(r));
    else recallActive++;
  };
  const recallDone = () => { const next = recallWaiting.shift(); if (next) next(); else recallActive--; };
  const isTimeout = (err) => /timed out|timeout|preflight|fetch failed/i.test(String(err?.message || err));
  async function limitedRecall(client, args) {
    await recallSlot();
    try {
      for (let attempt = 0; ; attempt++) {
        try { return await client.recall(args); } catch (err) {
          if (attempt >= recallRetries || !isTimeout(err)) throw err;
          await sleep(recallRetryWaitMs);
        }
      }
    } finally { recallDone(); }
  }

  // ledger: "namespace:idempotency key" -> entry. The counter is built from it.
  const ledger = new Map();
  const changedIds = new Set();
  // Memories Walrus already holds (read back after a start): blob id -> { namespace, origin }. origin is null until a note is read.
  const known = new Map();
  const hydration = { state: 'idle', startedAt: null, finishedAt: null, namespaces: {}, restoredChanged: 0 };
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
    // Bulk write for scripts (the pre-scan). One call for many memories of one namespace; 20 took about 56 s in the K2 test.
    // Memories already stored are skipped, so a resumed run never writes the same text twice. Never call this on the screen path.
    async bulkWrite(memories, { timeoutMs = 300000 } = {}) {
      const fresh = [];
      for (const m of memories) {
        if (!NAMESPACES.includes(m.namespace)) throw new Error(`unknown namespace: ${m.namespace}`);
        const text = buildText(m, m.body);
        const key = idempotencyKey(text);
        const lk = `${m.namespace}:${key}`;
        const existing = ledger.get(lk);
        if (existing && existing.state !== 'failed') continue;
        const e = { key, namespace: m.namespace, kind: m.kind, origin: m.origin, address: m.address || null, group: m.group || null, text, state: 'pending' };
        ledger.set(lk, e);
        fresh.push(e);
      }
      if (!fresh.length) return [];
      const namespace = fresh[0].namespace;
      if (fresh.some((e) => e.namespace !== namespace)) throw new Error('bulkWrite takes one namespace per call');
      try {
        const r = await clientFor(namespace).rememberBulkAndWait(
          fresh.map((e) => ({ text: e.text, namespace })),
          { timeoutMs, idempotencyKey: idempotencyKey(fresh.map((e) => e.key).join(',')) },
        );
        fresh.forEach((e, i) => {
          const it = r.results?.[i];
          if (it?.status === 'done') { e.state = 'stored'; e.blobId = it.blob_id; e.id = it.id; e.writtenAt = new Date().toISOString(); e.error = null; }
          else { e.state = 'failed'; e.error = String(it?.error || it?.status || 'no result'); }
        });
      } catch (err) {
        for (const e of fresh) { e.state = 'failed'; e.error = String(err?.message || err); }
      }
      return fresh.map(view);
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
      const res = await limitedRecall(client, { query: query || address || group, limit, namespace });
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

    // The newest shared warnings: bad-outcome reports in one namespace, newest first. Read only. Includes reports saved by this
    // server since it started, so a fresh report shows at once. Test reports (origin k2-test) are never listed.
    async recentOutcomes({ namespace = 'shared-outcomes', limit = 5 } = {}) {
      const byId = new Map();
      const add = (id, p, writtenAt) => {
        if (!id || !p || p.kind !== 'outcome' || p.origin === 'k2-test') return;
        if (String(p.body?.outcome ?? '').trim().toLowerCase() !== 'bad') return;
        byId.set(id, { memoryId: id, reporter: p.body?.reporter ?? p.origin ?? null, reportedAt: p.body?.reportedAt ?? writtenAt ?? null, reportedAddress: p.address ?? null, origin: p.origin ?? null });
      };
      for (const e of ledger.values()) if (e.state === 'stored' && e.namespace === namespace) add(e.blobId || e.id, parseMemory(e.text), e.writtenAt);
      const res = await limitedRecall(clientFor(namespace), { query: 'PAYCHECK v1 kind=outcome outcome bad', limit: 100, namespace });
      for (const m of res.results || []) add(m.blob_id, parseMemory(m.text), m.created_at);
      const time = (w) => { const t = Date.parse(w.reportedAt ?? ''); return Number.isFinite(t) ? t : 0; };
      return [...byId.values()].sort((a, b) => time(b) - time(a)).slice(0, limit);
    },

    // Mark memories cited in a verdict that came out different with memory off.
    markChanged(ids) { for (const id of [].concat(ids)) changedIds.add(id); },

    // Counter (plan section 3e). Test memories never count in stored. Memories written this session and memories read back from
    // Walrus after a start are merged by blob id, so one memory is never counted twice.
    counter() {
      let test = 0;
      const seen = new Map();
      for (const [id, k] of known) if (k.namespace !== 'k2-test') seen.set(id, k.origin);
      for (const [lk, e] of ledger) {
        if (e.state !== 'stored') continue;
        if (e.origin === 'k2-test' || e.namespace === 'k2-test') { test++; continue; }
        const id = e.blobId && known.has(e.blobId) ? e.blobId : lk; // one memory counts once, even if Walrus also lists it
        seen.set(id, e.origin ?? seen.get(id) ?? null);
      }
      let prescan = 0;
      let unlabelled = 0; // listed by Walrus, label not read (yet)
      for (const o of seen.values()) { if (o === 'prescan') prescan++; else if (o == null) unlabelled++; }
      return { changed: changedIds.size, stored: seen.size, prescan, unlabelled, test };
    },

    // How far the read-back from Walrus has got. Plain facts for /api/stats.
    hydration() { return { ...hydration, namespaces: { ...hydration.namespaces } }; },

    // Read the counts back from Walrus after a start. Every memory in the live and shared-outcomes namespaces is counted from the
    // list, which is paged to the end. The list holds no text, so a note's origin (pre-scan or not) is read with searches. Each search
    // returns at most 100 notes, so the searches are repeated with different words (each origin, each kind, then each group seen so
    // far) until every listed note has a label or a round brings nothing new. A note still without a label is counted as unlabelled,
    // never guessed. Changed-answer notes (verdict notes that record which memories changed their answer) come from the same
    // searches. Never throws: a failed piece is marked and the rest goes on.
    async hydrate({ namespaces = ['live', 'shared-outcomes'], probeLimit = 100, maxSearches = 80 } = {}) {
      hydration.state = 'loading';
      hydration.startedAt = new Date().toISOString();
      let failed = 0;
      let pieces = 0;
      const CHANGED_QUERY = 'PAYCHECK v1 kind=verdict changedByIds';
      for (const namespace of namespaces) {
        const info = { listed: null, labelled: 0, unlabelled: null, searches: 0, notesRead: 0, ok: true };
        hydration.namespaces[namespace] = info;
        const mine = new Set(); // blob ids listed in this namespace
        pieces++;
        try {
          const client = clientFor(namespace);
          let cursor;
          do {
            const p = await client.listMemories({ cursor, limit: 500, namespace });
            for (const m of p.memories || []) {
              const id = m.blob_id || m.memory_id;
              if (!id) continue;
              mine.add(id);
              if (!known.has(id)) known.set(id, { namespace, origin: null });
            }
            info.listed = mine.size;
            cursor = p.has_more ? p.next_cursor : null;
          } while (cursor);
        } catch { info.ok = false; failed++; }
        const groupsSeen = new Set();
        const asked = new Set();
        const unlabelledNow = () => { let n = 0; for (const id of mine) if (known.get(id)?.origin == null) n++; return n; };
        const search = async (query) => {
          if (asked.has(query) || info.searches >= maxSearches) return 0;
          asked.add(query);
          info.searches++;
          pieces++;
          let gained = 0;
          try {
            const res = await limitedRecall(clientFor(namespace), { query, limit: probeLimit, namespace });
            for (const m of res.results || []) {
              const p = parseMemory(m.text);
              if (!p) continue;
              info.notesRead++;
              if (p.group) groupsSeen.add(p.group);
              const id = m.blob_id;
              if (id) {
                if (known.get(id)?.origin == null && p.origin) gained++;
                known.set(id, { namespace, origin: p.origin ?? known.get(id)?.origin ?? null });
              }
              for (const cid of Array.isArray(p.body?.changedByIds) ? p.body.changedByIds : []) {
                if (typeof cid === 'string' && cid && !changedIds.has(cid)) { changedIds.add(cid); hydration.restoredChanged++; }
              }
            }
          } catch { info.ok = false; failed++; }
          return gained;
        };
        // Round 1: each origin and each kind. Later rounds: each group seen so far. Stop when nothing is left or a round gains nothing.
        let queries = [...ORIGINS.map((o) => `PAYCHECK v1 origin=${o}`), ...KINDS.map((k) => `PAYCHECK v1 kind=${k}`), CHANGED_QUERY];
        while (queries.length) {
          let gained = 0;
          for (const q of queries) gained += await search(q);
          if (!gained || (mine.size && unlabelledNow() === 0)) break;
          queries = [...groupsSeen].map((g) => `PAYCHECK v1 group=${g}`).filter((q) => !asked.has(q));
        }
        info.unlabelled = unlabelledNow();
        info.labelled = mine.size - info.unlabelled;
      }
      hydration.state = failed === 0 ? 'done' : failed >= pieces ? 'failed' : 'partial';
      hydration.finishedAt = new Date().toISOString();
      return this.hydration();
    },

    // Restore: ask Walrus to rebuild the namespace, then rebuild the local ledger from the recalled headers.
    async restore(namespace, { limit = 500, probe = 'PAYCHECK v1' } = {}) {
      const client = clientFor(namespace);
      const r = await client.restore(namespace, limit);
      const res = await limitedRecall(client, { query: probe, limit: Math.min(limit, 100), namespace });
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
