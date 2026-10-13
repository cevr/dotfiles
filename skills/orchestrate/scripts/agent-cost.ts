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

let turns = 0;
let read = 0;
let create = 0;
let out = 0;
let compactions = 0;
let first: string | undefined;
let last: string | undefined;

for (const line of (await Bun.file(file).text()).split('\n')) {
  if (line === '') continue;
  let d: {
    type?: string;
    subtype?: string;
    timestamp?: string;
    message?: { usage?: Record<string, number> };
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
    const u = d.message?.usage ?? {};
    turns++;
    read += u.cache_read_input_tokens ?? 0;
    create += u.cache_creation_input_tokens ?? 0;
    out += u.output_tokens ?? 0;
  }
}

const m = (n: number) => `${(n / 1e6).toFixed(1)}M`;
const minutes = first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 60000) : 0;
console.log(
  `cost ${id}: ${turns} turns, ${m(read)} cache-read, ${m(create)} cache-create, ${Math.round(out / 1000)}k out, ${compactions} compactions, ${minutes} min`,
);
