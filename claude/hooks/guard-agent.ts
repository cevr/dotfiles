#!/usr/bin/env bun
// PreToolUse(Agent): keep subagents lean and inside the account pool's budget.
// A general-purpose, claude or untyped agent loads every tool and MCP server
// before its first turn (about 88k tokens against 34k for worker), so it runs
// as `worker` instead. An agent type asked for by its former name runs under
// its current one: a session that read the skill before the rename still asks
// for it. A new agent starts only when orchestrate's `budget.ts --admit` says
// its turn in the agent queue came and its expected cost fits the pool's pace.
// A held agent stays queued: the session runs the waiter the reason names in
// the background, and calls Agent again when it exits. CLAUDE_FULL_AGENT=1
// lets a full agent through.

import { homedir } from 'node:os';
import { join } from 'node:path';

type Input = { session_id?: string; cwd?: string; tool_input?: Record<string, unknown> };

const FULL = new Set([undefined, '', 'general-purpose', 'claude']);
// Former agent type → current, asked for bare or as the status mod's copy.
// The role agents dropped their orchestrate- prefix; the reviewer is the verifier's former name.
const RENAMED: Record<string, string> = {
  'orchestrate-worker': 'worker',
  'orchestrate-planner': 'planner',
  'orchestrate-implementor': 'implementor',
  'orchestrate-verifier': 'verifier',
  'orchestrate-reviewer': 'verifier',
};
const renamed = (type: string) => RENAMED[type.replace(/^status:/, '')];
const BUDGET = join(homedir(), '.claude', 'skills', 'orchestrate', 'scripts', 'budget.ts');

const input: Input = JSON.parse((await Bun.stdin.text()) || '{}');
const toolInput = input.tool_input ?? {};

const reply = (output: Record<string, unknown>) => {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...output } }));
  process.exit(0);
};

const asked = toolInput.subagent_type as string | undefined;
const lean = FULL.has(asked) && process.env.CLAUDE_FULL_AGENT !== '1';
const type = lean ? 'worker' : ((asked && renamed(asked)) ?? asked);
const run = Bun.spawnSync(
  [
    'bun',
    BUDGET,
    '--admit',
    '--session',
    input.session_id ?? '',
    '--cwd',
    input.cwd ?? process.cwd(),
    '--type',
    type ?? '',
    '--description',
    String(toolInput.description ?? ''),
  ],
  { timeout: 8e3 },
);
// Exit 1 holds the agent; an unreachable host (2) or a timeout lets it run.
if (run.exitCode === 1) {
  reply({
    permissionDecision: 'deny',
    permissionDecisionReason: `guard-agent: the Claude pool's pace holds this agent.\n${run.stdout.toString().trim()}`,
  });
}

if (type !== asked) {
  reply({
    permissionDecision: 'allow',
    permissionDecisionReason: lean
      ? `guard-agent: ${asked || 'untyped'} agent runs as worker (lean tools, no MCP servers).`
      : `guard-agent: ${asked} is now ${type}.`,
    updatedInput: { ...toolInput, subagent_type: type },
  });
}
