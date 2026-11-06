#!/usr/bin/env bun
// One line of what an agent spent, read from its record: turns, cache-read,
// cache-create and output tokens, compactions, wall time, the first turn's
// context (the floor every turn pays), the mean context per turn, and the shell
// calls that poll. A hand-back's token count is the agent's final context, not
// its spend.
//
// Usage: bun agent-cost.ts <agent id> [--projects <dir>]
//   An OpenCode session id (`ses_…`, the subagent's child session) is read
//   through the running OpenCode service's HTTP API, with the retro miner's
//   client. Any other id is a Claude Code agent: its transcript
//   `<projects>/<repo>/<session>/subagents/agent-<id>.jsonl` under
//   ~/.claude/projects (or the given dir); the newest match wins.

import { Glob } from 'bun';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { messagesOf, serviceEndpoint } from '../../retro/scripts/mine/opencode.ts';

export type Spend = {
  /** Per model turn, the context it sent: fresh input, cache-read and cache-create tokens. */
  turns: { input: number; read: number; create: number; output: number }[];
  compactions: number;
  polls: number;
  first?: number;
  last?: number;
};

const POLL = /sleep [0-9]|until |while true|gh run watch/;

/** A Claude Code subagent transcript (JSONL). */
export function claudeSpend(text: string): Spend {
  // One message is written as several transcript lines (a text block, a tool
  // call), each carrying its usage; keep each message id's largest counts once.
  const usage = new Map<string, Spend['turns'][number]>();
  let compactions = 0;
  let polls = 0;
  let first: number | undefined;
  let last: number | undefined;
  for (const line of text.split('\n')) {
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
      first ??= Date.parse(d.timestamp);
      last = Date.parse(d.timestamp);
    }
    if (d.type === 'system' && d.subtype === 'compact_boundary') compactions++;
    if (d.type === 'assistant') {
      const key = d.message?.id ?? `line-${usage.size}`;
      const had = usage.get(key) ?? { input: 0, read: 0, create: 0, output: 0 };
      const u = d.message?.usage ?? {};
      usage.set(key, {
        input: Math.max(had.input, u.input_tokens ?? 0),
        read: Math.max(had.read, u.cache_read_input_tokens ?? 0),
        create: Math.max(had.create, u.cache_creation_input_tokens ?? 0),
        output: Math.max(had.output, u.output_tokens ?? 0),
      });
      for (const b of d.message?.content ?? []) {
        if (b.type === 'tool_use' && b.name === 'Bash' && POLL.test(String(b.input?.command ?? ''))) polls++;
      }
    }
  }
  return { turns: [...usage.values()], compactions, polls, first, last };
}

// A shell command run directly, or from a kernel cell: `tools.shell({ command: "…" })`.
const SHELL_IN_CELL = /\btools\.shell\(\s*\{[^}]*?\bcommand\s*:\s*(["'`])([\s\S]*?)\1/g;

/** An OpenCode session's projected messages (GET /api/session/:id/message). */
export function opencodeSpend(msgs: any[]): Spend {
  const turns: Spend['turns'] = [];
  let compactions = 0;
  let polls = 0;
  let first: number | undefined;
  let last: number | undefined;
  for (const m of msgs) {
    const at: number | undefined = m.time?.created;
    if (at) {
      first ??= at;
      last = Math.max(last ?? 0, m.time?.completed ?? at);
    }
    if (m.type === 'compaction' && m.status === 'completed') compactions++;
    if (m.type !== 'assistant') continue;
    const t = m.tokens ?? {};
    turns.push({ input: t.input ?? 0, read: t.cache?.read ?? 0, create: t.cache?.write ?? 0, output: (t.output ?? 0) + (t.reasoning ?? 0) });
    for (const c of m.content ?? []) {
      if (c?.type !== 'tool') continue;
      const input = c.state?.input ?? {};
      const commands = c.name === 'shell' ? [String(input.command ?? '')] : [...String(input.code ?? '').matchAll(SHELL_IN_CELL)].map((x) => x[2]!);
      polls += commands.filter((cmd) => POLL.test(cmd)).length;
    }
  }
  return { turns, compactions, polls, first, last };
}

/** The receipt line `log.md` keeps. */
export function costLine(id: string, s: Spend): string {
  const sum = (k: keyof Spend['turns'][number]) => s.turns.reduce((n, t) => n + t[k], 0);
  const contexts = s.turns.map((t) => t.input + t.read + t.create);
  const floor = contexts[0] ?? 0;
  const meanContext = s.turns.length ? contexts.reduce((a, b) => a + b, 0) / s.turns.length : 0;
  const m = (n: number) => `${(n / 1e6).toFixed(1)}M`;
  const k = (n: number) => Math.round(n / 1000);
  const minutes = s.first && s.last ? Math.round((s.last - s.first) / 60000) : 0;
  return `cost ${id}: ${s.turns.length} turns, ${m(sum('read'))} cache-read, ${m(sum('create'))} cache-create, ${k(sum('output'))}k out, ${s.compactions} compactions, ${minutes} min, floor ${k(floor)}k, ctx ${k(meanContext)}k/turn, polls ${s.polls}`;
}

async function main() {
  const args = process.argv.slice(2);
  const id = args.find((a) => !a.startsWith('--'));
  const at = args.indexOf('--projects');
  const projects = at >= 0 && args[at + 1] ? args[at + 1]! : join(homedir(), '.claude', 'projects');
  if (!id) {
    console.error('usage: bun agent-cost.ts <agent id | ses_… OpenCode session id> [--projects <dir>]');
    process.exit(2);
  }

  if (id.startsWith('ses_')) {
    const ep = serviceEndpoint();
    if (!ep) {
      console.error('no OpenCode service registered (service.json under $XDG_STATE_HOME/opencode); start OpenCode, then rerun');
      process.exit(1);
    }
    let msgs: any[];
    try {
      msgs = await messagesOf(ep, id);
    } catch (e) {
      console.error(`no OpenCode session ${id} at ${ep.url}: ${(e as Error).message}`);
      process.exit(1);
    }
    console.log(costLine(id, opencodeSpend(msgs)));
    return;
  }

  const matches = [...new Glob(`*/*/subagents/agent-${id}.jsonl`).scanSync({ cwd: projects, absolute: true })];
  if (matches.length === 0) {
    console.error(`no transcript for agent ${id} under ${projects}`);
    process.exit(1);
  }
  const stats = await Promise.all(matches.map(async (f) => ({ f, m: (await Bun.file(f).stat()).mtimeMs })));
  const file = stats.sort((a, b) => b.m - a.m)[0]!.f;
  console.log(costLine(id, claudeSpend(await Bun.file(file).text())));
}

if (import.meta.main) await main();
