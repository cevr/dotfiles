#!/usr/bin/env bun
// One line of what an agent spent, read from its transcript: turns, cache-read,
// cache-create and output tokens, compactions, wall time, the first turn's
// context (the floor every turn pays), the mean context per turn, and the Bash
// calls that poll. A task notification's token count is the agent's final
// context, not its spend.
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
let polls = 0;
const POLL = /sleep [0-9]|until |while true|gh run watch/;
let first: string | undefined;
let last: string | undefined;

for (const line of (await Bun.file(file).text()).split('\n')) {
  if (line === '') continue;
  let d: {
    type?: string;
    subtype?: string;
    timestamp?: string;
    message?: {
      id?: string;
      usage?: Record<string, number>;
      content?: { type?: string; name?: string; input?: { command?: unknown } }[];
    };
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
      input_tokens: max('input_tokens'),
      cache_read_input_tokens: max('cache_read_input_tokens'),
      cache_creation_input_tokens: max('cache_creation_input_tokens'),
      output_tokens: max('output_tokens'),
    });
    for (const b of d.message?.content ?? []) {
      if (b.type === 'tool_use' && b.name === 'Bash' && POLL.test(String(b.input?.command ?? ''))) polls++;
    }
  }
}

const sum = (k: string) => [...usage.values()].reduce((n, u) => n + (u[k] ?? 0), 0);
const turns = usage.size;
const read = sum('cache_read_input_tokens');
const create = sum('cache_creation_input_tokens');
const out = sum('output_tokens');
// A turn's context is everything it sent: fresh input plus cached prefix.
const contextOf = (u: Record<string, number>) =>
  (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
const contexts = [...usage.values()].map(contextOf);
const floor = contexts[0] ?? 0;
const meanContext = turns ? contexts.reduce((a, b) => a + b, 0) / turns : 0;

const m = (n: number) => `${(n / 1e6).toFixed(1)}M`;
const k = (n: number) => Math.round(n / 1000);
const minutes = first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 60000) : 0;
console.log(
  `cost ${id}: ${turns} turns, ${m(read)} cache-read, ${m(create)} cache-create, ${k(out)}k out, ${compactions} compactions, ${minutes} min, floor ${k(floor)}k, ctx ${k(meanContext)}k/turn, polls ${polls}`,
);
