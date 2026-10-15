#!/usr/bin/env bun
// One line of what an agent spent, read from its transcript: turns, cache-read,
// cache-create and output tokens, compactions and wall time. A task
// notification's token count is the agent's final context, not its spend.
//
// Usage: bun agent-cost.ts <agent id> [--projects <dir>]
//   Finds `<projects>/<repo>/<session>/subagents/agent-<id>.jsonl` under
//   ~/.claude/projects (or the given dir); the newest match wins.

import { Glob } from 'bun';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const at = args.indexOf('--projects');
const projects = at >= 0 && args[at + 1] ? args[at + 1] : join(homedir(), '.claude', 'projects');

if (!id) {
  console.error('usage: bun agent-cost.ts <agent id> [--projects <dir>]');
  process.exit(2);
}

const matches = [...new Glob(`*/*/subagents/agent-${id}.jsonl`).scanSync({ cwd: projects, absolute: true })];
if (matches.length === 0) {
  console.error(`no transcript for agent ${id} under ${projects}`);
  process.exit(1);
}
const stats = await Promise.all(matches.map(async (f) => ({ f, m: (await Bun.file(f).stat()).mtimeMs })));
const file = stats.sort((a, b) => b.m - a.m)[0]!.f;

// One message is written as several transcript lines (a text block, a tool
// call), each carrying its usage; keep each message id's largest counts once.
const usage = new Map<string, Record<string, number>>();
let compactions = 0;
let first: string | undefined;
let last: string | undefined;

for (const line of (await Bun.file(file).text()).split('\n')) {
  if (line === '') continue;
  let d: {
    type?: string;
    subtype?: string;
    timestamp?: string;
    message?: { id?: string; usage?: Record<string, number> };
  };
  try {
    d = JSON.parse(line);
  } catch {
    continue;
  }
  if (d.timestamp) {
    first ??= d.timestamp;
    last = d.timestamp;
  }
  if (d.type === 'system' && d.subtype === 'compact_boundary') compactions++;
  if (d.type === 'assistant') {
    const key = d.message?.id ?? `line-${usage.size}`;
    const had = usage.get(key) ?? {};
    const u = d.message?.usage ?? {};
    const max = (k: string) => Math.max(had[k] ?? 0, u[k] ?? 0);
    usage.set(key, {
      cache_read_input_tokens: max('cache_read_input_tokens'),
      cache_creation_input_tokens: max('cache_creation_input_tokens'),
      output_tokens: max('output_tokens'),
    });
  }
}

const sum = (k: string) => [...usage.values()].reduce((n, u) => n + (u[k] ?? 0), 0);
const turns = usage.size;
const read = sum('cache_read_input_tokens');
const create = sum('cache_creation_input_tokens');
const out = sum('output_tokens');

const m = (n: number) => `${(n / 1e6).toFixed(1)}M`;
const minutes = first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 60000) : 0;
console.log(
  `cost ${id}: ${turns} turns, ${m(read)} cache-read, ${m(create)} cache-create, ${Math.round(out / 1000)}k out, ${compactions} compactions, ${minutes} min`,
);
