#!/usr/bin/env bun
// Writes one agent per orchestrate role for each host, from protocol.md and
// loop/safety.md: Claude Code's agents/orchestrate-<role>.md and Codex's
// codex/agents/orchestrate-<role>.toml. A worker starts with its rules in its
// prompt instead of reading them, and on Claude Code each role is its own agent
// kind with its own tuned compaction window. protocol.md stays the one copy.
// Usage: bun agents.ts [--check]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dir;
const PROTOCOL = join(here, '..', 'protocol.md');
const SAFETY = join(here, '..', '..', 'loop', 'safety.md');
export const AGENTS = join(here, '..', '..', '..', 'agents');
export const CODEX_AGENTS = join(here, '..', '..', '..', 'codex', 'agents');
const TOOLS = 'Bash, Read, Edit, Write, Skill, Monitor, TaskStop, WebFetch, WebSearch';

export const ROLES = {
  planner: 'Writes one orchestrate unit\'s spec and its red acceptance check. Changes no product code.',
  implementor: 'The sole writer of one orchestrate unit: builds its spec on the unit\'s branch and hands back a round request.',
  reviewer: 'Reviews one orchestrate unit\'s round from the other model family, directly or through okra counsel, and writes the findings.',
  verifier: 'Proves one orchestrate unit\'s round works on a clean checkout of its head, and writes the verify report.',
} as const;
export type Role = keyof typeof ROLES;

// The Codex column of SKILL.md's role table. The model is the spawn's (the newest
// sol or luna), so no file pins one; an effort in the file wins over the spawn's.
const CODEX_EFFORT: Record<Role, string> = { planner: 'high', implementor: 'max', reviewer: 'max', verifier: 'medium' };

/** protocol.md's `## ` sections by heading. */
const sections = (text: string) =>
  Object.fromEntries(text.split(/^## /m).slice(1).map((s) => [s.slice(0, s.indexOf('\n')).trim(), `## ${s.trim()}`]));

const WRITTEN = 'Written by skills/orchestrate/scripts/agents.ts from protocol.md and loop/safety.md. Edit those, then run it.';

/** A role's instructions: the safety rules, the shared protocol sections and its own section. */
export function instructions(role: Role, protocol: string, safety: string): string {
  const s = sections(protocol);
  const rules = safety.slice(safety.indexOf('SAFETY (mandatory')).trim();
  const own = s[role[0].toUpperCase() + role.slice(1)];
  if (!s['Ending a step'] || !s.Rounds || !own || !rules.startsWith('SAFETY')) throw new Error(`protocol.md or safety.md lost a section ${role} needs`);
  return `You are the ${role} of one orchestrate unit. Your first message names the unit's \`spec.md\` and the round. This prompt carries the worker protocol and the safety rules, so do not read \`protocol.md\` or \`safety.md\`.

# Safety

${rules}

# Worker protocol

${s['Ending a step']}

${s.Rounds}

${own}
`;
}

/** The Claude Code agent file for a role. */
export const agentFile = (role: Role, protocol: string, safety: string): string => `---
name: orchestrate-${role}
description: ${ROLES[role]} Its prompt carries the worker protocol.
tools: ${TOOLS}
# ${WRITTEN}
---
${instructions(role, protocol, safety)}`;

/** The Codex custom agent file for a role. */
export function codexFile(role: Role, protocol: string, safety: string): string {
  const text = instructions(role, protocol, safety);
  if (text.includes("'''")) throw new Error("the instructions hold ''', which ends a TOML literal string");
  return `# ${WRITTEN}
name = "orchestrate-${role}"
description = "${ROLES[role]} Its instructions carry the worker protocol."
model_reasoning_effort = "${CODEX_EFFORT[role]}"
developer_instructions = '''
${text}'''
`;
}

const built = () => {
  const protocol = readFileSync(PROTOCOL, 'utf8');
  const safety = readFileSync(SAFETY, 'utf8');
  return (Object.keys(ROLES) as Role[]).flatMap((role) => [
    [join(AGENTS, `orchestrate-${role}.md`), agentFile(role, protocol, safety)] as const,
    [join(CODEX_AGENTS, `orchestrate-${role}.toml`), codexFile(role, protocol, safety)] as const,
  ]);
};

/** The agent files that differ from what protocol.md and safety.md make. */
export const stale = () => built().filter(([path, text]) => { try { return readFileSync(path, 'utf8') !== text; } catch { return true; } }).map(([path]) => path);

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const old = stale();
    if (old.length) { console.error(`stale: ${old.join(', ')}; run bun agents.ts`); process.exit(1); }
  } else {
    mkdirSync(CODEX_AGENTS, { recursive: true });
    for (const [path, text] of built()) writeFileSync(path, text);
  }
}
