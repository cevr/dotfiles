#!/usr/bin/env bun
// Writes one agent per orchestrate role for each host, from protocol.md and
// loop/safety.md: Claude Code's agents/<role>.md and Codex's
// codex/agents/<role>.toml. A worker starts with its rules in its prompt
// instead of reading them. protocol.md stays the one copy.
// A file it wrote for a role it no longer has is removed, and --check fails on it.
// Usage: bun agents.ts [--check]
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dir;
const PROTOCOL = join(here, '..', 'protocol.md');
const SAFETY = join(here, '..', '..', 'loop', 'safety.md');
export const AGENTS = join(here, '..', '..', '..', 'agents');
export const CODEX_AGENTS = join(here, '..', '..', '..', 'codex', 'agents');
const TOOLS = 'Bash, Read, Edit, Write, Skill, Monitor, TaskStop, WebFetch, WebSearch';

export const ROLES = Object.freeze({
  planner: 'Writes one orchestrate unit\'s spec and its red acceptance law. Changes no product code.',
  implementor: 'The sole writer of one orchestrate unit: builds it until its acceptance law is green and hands back a stat block.',
  verifier: 'Runs what an orchestrate unit or batch built, on a clean checkout of its head, and files only failures a run proves.',
} as const);
export type Role = keyof typeof ROLES;

/** The Codex efforts in SKILL.md's role table; no file pins a model. A verifier runs at medium, always. */
const CODEX_EFFORT: Record<Role, string> = { planner: 'high', implementor: 'max', verifier: 'medium' };

/** protocol.md's `## ` sections by heading. */
const sections = (text: string) =>
  Object.fromEntries(text.split(/^## /m).slice(1).map((s) => [s.slice(0, s.indexOf('\n')).trim(), `## ${s.trim()}`]));

const WRITTEN = 'Written by skills/orchestrate/scripts/agents.ts from protocol.md and loop/safety.md. Edit those, then run it.';

/** A role's instructions: the safety rules, the shared section and its own section. */
export function instructions(role: Role, protocol: string, safety: string): string {
  const s = sections(protocol);
  const rules = safety.slice(safety.indexOf('SAFETY (mandatory')).trim();
  const own = s[role.charAt(0).toUpperCase() + role.slice(1)];
  if (!s['Every role'] || !own || !rules.startsWith('SAFETY')) throw new Error(`protocol.md or safety.md lost a section ${role} needs`);
  return `You are the ${role} of one orchestrate unit; your first message is its brief. This prompt carries the worker protocol and the safety rules.

# Safety

${rules}

# Worker protocol

${s['Every role']}

${own}
`;
}

/** The Claude Code agent file for a role. */
export const agentFile = (role: Role, protocol: string, safety: string): string => `---
name: ${role}
description: ${ROLES[role]} Its prompt carries the worker protocol.
${role === 'verifier' ? 'model: opus\n' : ''}tools: ${TOOLS}
# ${WRITTEN}
---
${instructions(role, protocol, safety)}`;

/** The Codex custom agent file for a role. */
export function codexFile(role: Role, protocol: string, safety: string): string {
  const text = role === 'verifier'
    ? `Verification runs on Claude Opus only, never Codex: tell the parent to start a Claude Opus verifier.\n\n${instructions(role, protocol, safety)}`
    : instructions(role, protocol, safety);
  if (text.includes("'''")) throw new Error("the instructions hold ''', which ends a TOML literal string");
  return `# ${WRITTEN}
name = "${role}"
description = "${ROLES[role]} Its instructions carry the worker protocol."
model_reasoning_effort = "${CODEX_EFFORT[role]}"
developer_instructions = '''
${text}'''
`;
}

/** Every file this script writes: each role's agent files. */
const built = () => {
  const protocol = readFileSync(PROTOCOL, 'utf8');
  const safety = readFileSync(SAFETY, 'utf8');
  return (Object.keys(ROLES) as Role[]).flatMap((role) => [
    [join(AGENTS, `${role}.md`), agentFile(role, protocol, safety)] as const,
    [join(CODEX_AGENTS, `${role}.toml`), codexFile(role, protocol, safety)] as const,
  ]);
};

/** Agent files this script wrote for a role it no longer has, or under a role's former name (`orchestrate-<role>`). */
export const retired = (dirs = [AGENTS, CODEX_AGENTS], roles = Object.keys(ROLES)) =>
  dirs.flatMap((dir) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch {}
    return names
      .filter((name) => /^[a-z-]+\.(md|toml)$/.test(name) && !roles.includes(name.slice(0, name.lastIndexOf('.'))))
      .map((name) => join(dir, name))
      .filter((path) => readFileSync(path, 'utf8').includes(WRITTEN));
  });

/** The agent files that differ from what protocol.md and safety.md make, and those of a retired role. */
export const stale = () => [
  ...built().filter(([path, text]) => { try { return readFileSync(path, 'utf8') !== text; } catch { return true; } }).map(([path]) => path),
  ...retired(),
];

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const old = stale();
    if (old.length) { console.error(`stale: ${old.join(', ')}; run bun agents.ts`); process.exit(1); }
  } else {
    mkdirSync(CODEX_AGENTS, { recursive: true });
    for (const [path, text] of built()) writeFileSync(path, text);
    for (const path of retired()) rmSync(path);
  }
}
