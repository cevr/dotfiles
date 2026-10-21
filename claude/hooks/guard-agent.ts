#!/usr/bin/env bun
// PreToolUse(Agent): keep subagents lean and inside the account pool's budget.
// A general-purpose, claude or untyped agent loads every tool and MCP server
// before its first turn (about 88k tokens against 34k for orchestrate-worker), so
// it runs as `orchestrate-worker` instead. A new agent is refused while orchestrate's
// budget.ts reports the pool at its cap. CLAUDE_FULL_AGENT=1 lets a full agent
// through; ORCHESTRATE_CAP sets the cap (budget.ts default, 8).

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

type Input = { tool_input?: Record<string, unknown> };

const FULL = new Set([undefined, '', 'general-purpose', 'claude']);
const CACHE = join(tmpdir(), 'guard-agent-budget.json');
const CACHE_MS = 60e3;
const BUDGET = join(homedir(), '.claude', 'skills', 'orchestrate', 'scripts', 'budget.ts');

const input: Input = JSON.parse((await Bun.stdin.text()) || '{}');
const toolInput = input.tool_input ?? {};

const reply = (output: Record<string, unknown>) => {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...output } }));
  process.exit(0);
};

type Budget = { at: number; cap: string; over: boolean; text: string };

function budget(): Budget {
  const cap = process.env.ORCHESTRATE_CAP ?? '';
  try {
    const cached: Budget = JSON.parse(readFileSync(CACHE, 'utf8'));
    if (cached.cap === cap && Date.now() - cached.at < CACHE_MS) return cached;
  } catch {}
  const run = Bun.spawnSync(['bun', BUDGET, ...(cap ? ['--cap', cap] : [])], { timeout: 8e3 });
  // Exit 1 is the cap; an unreachable host (2) or a timeout lets the agent run.
  const result = { at: Date.now(), cap, over: run.exitCode === 1, text: run.stdout.toString().trim() };
  try {
    writeFileSync(CACHE, JSON.stringify(result));
  } catch {}
  return result;
}

const pool = budget();
if (pool.over) {
  reply({
    permissionDecision: 'deny',
    permissionDecisionReason: `guard-agent: the Claude pool is at its agent cap.\n${pool.text}\nWait for a running agent's notification, or stop a finished one, then start this agent.`,
  });
}

const type = toolInput.subagent_type as string | undefined;
if (FULL.has(type) && process.env.CLAUDE_FULL_AGENT !== '1') {
  reply({
    permissionDecision: 'allow',
    permissionDecisionReason: `guard-agent: ${type ?? 'untyped'} agent runs as orchestrate-worker (lean tools, no MCP servers).`,
    updatedInput: { ...toolInput, subagent_type: 'orchestrate-worker' },
  });
}
