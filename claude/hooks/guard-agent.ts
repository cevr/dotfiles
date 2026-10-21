#!/usr/bin/env bun
// PreToolUse(Agent): keep subagents lean and inside the account pool's budget.
// A general-purpose, claude or untyped agent loads every tool and MCP server
// before its first turn (about 88k tokens against 34k for orchestrate-worker), so
// it runs as `orchestrate-worker` instead. A new agent starts only when
// orchestrate's `budget.ts --admit` says its expected cost fits the pool's pace
// and its project's share. CLAUDE_FULL_AGENT=1 lets a full agent through;
// ORCHESTRATE_CAP fixes a count cap instead of the pace.

import { homedir } from 'node:os';
import { join } from 'node:path';

type Input = { session_id?: string; cwd?: string; tool_input?: Record<string, unknown> };

const FULL = new Set([undefined, '', 'general-purpose', 'claude']);
const BUDGET = join(homedir(), '.claude', 'skills', 'orchestrate', 'scripts', 'budget.ts');

const input: Input = JSON.parse((await Bun.stdin.text()) || '{}');
const toolInput = input.tool_input ?? {};

const reply = (output: Record<string, unknown>) => {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...output } }));
  process.exit(0);
};

const asked = toolInput.subagent_type as string | undefined;
const lean = FULL.has(asked) && process.env.CLAUDE_FULL_AGENT !== '1';
const cap = process.env.ORCHESTRATE_CAP;
const run = Bun.spawnSync(
  [
    'bun',
    BUDGET,
    ...(cap
      ? ['--cap', cap]
      : [
          '--admit',
          '--session',
          input.session_id ?? '',
          '--cwd',
          input.cwd ?? process.cwd(),
          '--type',
          lean ? 'orchestrate-worker' : (asked ?? ''),
          '--description',
          String(toolInput.description ?? ''),
        ]),
  ],
  { timeout: 8e3 },
);
// Exit 1 holds the agent; an unreachable host (2) or a timeout lets it run.
if (run.exitCode === 1) {
  reply({
    permissionDecision: 'deny',
    permissionDecisionReason: `guard-agent: the Claude pool's pace holds this agent.\n${run.stdout.toString().trim()}\nWait for a running agent's notification, or stop a finished one, then start this agent.`,
  });
}

if (lean) {
  reply({
    permissionDecision: 'allow',
    permissionDecisionReason: `guard-agent: ${asked ?? 'untyped'} agent runs as orchestrate-worker (lean tools, no MCP servers).`,
    updatedInput: { ...toolInput, subagent_type: 'orchestrate-worker' },
  });
}
