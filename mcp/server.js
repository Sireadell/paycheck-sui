#!/usr/bin/env node
// MCP tool server (stdio) with one tool: check_payee(address).
// It calls the existing check in src/check.js and returns the verdict, the evidence labelled
// FACT (read on chain), GUESS (behaviour rule) or report (stored memory), and the memories cited.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';

const LABELS = { fact: 'FACT', guess: 'GUESS', report: 'report' };

/** Turn a check answer into the plain object the tool returns. Pure. */
export function toToolResult(r) {
  const evidence = (r.evidence ?? []).map((e) => ({
    label: LABELS[e.basis] ?? String(e.basis ?? 'GUESS'),
    ...e,
  }));
  const memoryIds = r.memoryIds ?? [];
  const citations = (r.warnedBy ?? []).map((w) => ({
    memoryId: w.memoryId, reporter: w.reporter, reportedAddress: w.reportedAddress, crossAddress: w.crossAddress, via: w.via,
  }));
  return {
    address: r.address,
    verdict: r.verdict,
    code: r.code,
    reason: r.reason,
    evidence,
    memoryIds,
    citations,
    nextAction: r.nextAction ?? null,
    retryable: r.retryable ?? false,
    memory: r.memory ?? null,
    notes: r.notes ?? [],
  };
}

/** Build the server. `check(address)` is the existing checker's check function. */
export function createPayeeServer({ check, version = '0.1.0' }) {
  const server = new McpServer({ name: 'paycheck-sui', version });
  server.registerTool(
    'check_payee',
    {
      title: 'Check a Sui payee before paying',
      description: 'Call this before sending money to a Sui address. Returns pay, caution or do not pay, with evidence labelled FACT (read on chain), GUESS (behaviour rule) or report (a stored memory from another agent), and the memory ids behind the answer. Do not sign the payment on "do not pay".',
      inputSchema: { address: z.string().describe('The Sui address you are about to pay (0x followed by hex)') },
    },
    async ({ address }) => {
      try {
        const out = toToolResult(await check(address));
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `check failed: ${String(e?.message || e).slice(0, 200)}` }] };
      }
    },
  );
  return server;
}

async function main() {
  const { createChecker } = await import('../src/check.js');
  const { createMemory } = await import('../src/memory/index.js');
  const { getTatum, getAnkr } = await import('../src/providers/index.js');
  const { loadConfig } = await import('../src/config.js');
  const cfg = loadConfig();
  const memory = createMemory();
  const checker = createChecker({ tatum: getTatum(), ankr: cfg.ANKR_API_KEY ? getAnkr() : null, memory, mode: process.env.PAYCHECK_MODE === 'live' ? 'live' : 'test' });
  const server = createPayeeServer({ check: (a) => checker.check(a) });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
}
