#!/usr/bin/env bun
// Writes one Claude Code agent per orchestrate role (agents/orchestrate-<role>.md)
// from protocol.md and loop/safety.md, so a worker starts with its rules in its
// prompt instead of reading them, and each role is its own agent kind with its
// own tuned compaction window. protocol.md stays the one copy: Codex workers
// read it as a file. Usage: bun agents.ts [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dir;
const PROTOCOL = join(here, '..', 'protocol.md');
const SAFETY = join(here, '..', '..', 'loop', 'safety.md');
export const AGENTS = join(here, '..', '..', '..', 'agents');
const TOOLS = 'Bash, Read, Edit, Write, Skill, Monitor, TaskStop, WebFetch, WebSearch';

export const ROLES = {
  planner: 'Writes one orchestrate unit\'s spec and its red acceptance check. Changes no product code.',
  implementor: 'The sole writer of one orchestrate unit: builds its spec on the unit\'s branch and hands back a round request.',
  reviewer: 'Reviews one orchestrate unit\'s round through okra counsel, validates the claims, and writes the findings.',
  verifier: 'Proves one orchestrate unit\'s round works on a clean checkout of its head, and writes the verify report.',
} as const;
export type Role = keyof typeof ROLES;

/** protocol.md's `## ` sections by heading. */
const sections = (text: string) =>
  Object.fromEntries(text.split(/^## /m).slice(1).map((s) => [s.slice(0, s.indexOf('\n')).trim(), `## ${s.trim()}`]));

/** The agent file for a role. */
export function agentFile(role: Role, protocol: string, safety: string): string {
  const s = sections(protocol);
  const rules = safety.slice(safety.indexOf('SAFETY (mandatory')).trim();
  const own = s[role[0].toUpperCase() + role.slice(1)];
  if (!s['Ending a step'] || !s.Rounds || !own || !rules.startsWith('SAFETY')) throw new Error(`protocol.md or safety.md lost a section ${role} needs`);
  return `---
name: orchestrate-${role}
description: ${ROLES[role]} Its prompt carries the worker protocol.
tools: ${TOOLS}
# Written by skills/orchestrate/scripts/agents.ts from protocol.md and loop/safety.md. Edit those, then run it.
---
You are the ${role} of one orchestrate unit. Your first message names the unit's \`spec.md\` and the round. This prompt carries the worker protocol and the safety rules, so do not read \`protocol.md\` or \`safety.md\`.

# Safety

${rules}

# Worker protocol

${s['Ending a step']}

${s.Rounds}

${own}
`;
}

const built = () => {
  const protocol = readFileSync(PROTOCOL, 'utf8');
  const safety = readFileSync(SAFETY, 'utf8');
  return (Object.keys(ROLES) as Role[]).map((role) => [join(AGENTS, `orchestrate-${role}.md`), agentFile(role, protocol, safety)] as const);
};

/** The agent files that differ from what protocol.md and safety.md make. */
export const stale = () => built().filter(([path, text]) => { try { return readFileSync(path, 'utf8') !== text; } catch { return true; } }).map(([path]) => path);

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const old = stale();
    if (old.length) { console.error(`stale: ${old.join(', ')}; run bun agents.ts`); process.exit(1); }
  } else for (const [path, text] of built()) writeFileSync(path, text);
}
