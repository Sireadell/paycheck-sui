// Memory text format: one header line, then a JSON body.
// PAYCHECK v1 kind=<kind> address=<0x...> group=<g-...> origin=<origin>
import { createHash } from 'node:crypto';

export const KINDS = ['verdict', 'outcome', 'group', 'disagreement', 'lesson', 'recheck'];
export const ORIGINS = ['check', 'prescan', 'agent-a', 'agent-b', 'bench-train', 'k2-test'];
export const NAMESPACES = ['live', 'bench-train', 'agent-a', 'agent-b', 'shared-outcomes', 'k2-test'];

const NONE = '-';

export function formatHeader({ kind, address, group, origin }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown memory kind: ${kind}`);
  if (!ORIGINS.includes(origin)) throw new Error(`unknown memory origin: ${origin}`);
  return `PAYCHECK v1 kind=${kind} address=${address || NONE} group=${group || NONE} origin=${origin}`;
}

export function buildText(meta, body = {}) {
  return `${formatHeader(meta)}\n${JSON.stringify(body)}`;
}

export function parseHeader(text) {
  const line = String(text).split('\n')[0];
  if (!line.startsWith('PAYCHECK v1 ')) return null;
  const pick = (k) => {
    const v = new RegExp(`(?:^| )${k}=(\\S+)`).exec(line)?.[1];
    return v === undefined || v === NONE ? null : v;
  };
  return { kind: pick('kind'), address: pick('address'), group: pick('group'), origin: pick('origin') };
}

export function parseMemory(text) {
  const header = parseHeader(text);
  if (!header) return null;
  let body = null;
  try { body = JSON.parse(String(text).split('\n').slice(1).join('\n')); } catch { /* body stays null */ }
  return { ...header, body };
}

export const idempotencyKey = (text) => createHash('sha256').update(text).digest('hex');
