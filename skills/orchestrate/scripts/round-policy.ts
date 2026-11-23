// The round policy's host projection: the canonical source is opencode/mods/orchestrate/round-policy.ts (shipped
// with the installed plugin, read by role.ts); this file only places it. It writes protocol.md's pointer block and
// end-of-step.md, and reads each host's envelope back to the prompt the model receives: Claude Code's agent
// Markdown (front matter stripped), Codex's TOML (`developer_instructions`) and OpenCode's agents.json (`system`).
// Eleven renders ship: planner, implementor and verifier on all three hosts, the lean worker on Claude Code and
// OpenCode (no Codex lean-worker runtime, and the Codex implementor file is a parity case, never a route).
// Edit the canonical source, then run agents.ts (and opencode's `bun run agents`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { block, END, header, HOSTS_OF, type Host, policyFaults, project, ROLES, type Role, STATE_NAME, type Stop, STOP_TEXT, writesText } from '../../../opencode/mods/orchestrate/round-policy.ts';

export * from '../../../opencode/mods/orchestrate/round-policy.ts';

export const ROOT = join(import.meta.dir, '../../..');

/** protocol.md's block: where each role's policy goes, and where all of them are. */
export const PROTOCOL_BLOCK = [
  header('protocol'),
  "How a step ends is one versioned round policy: an item's facts give its rule, state, label and evidence fields, and the item states present give the verdict, what it writes and the stop's evidence fields: [`end-of-step.md`](end-of-step.md). Each role's prompt carries its own policy here.",
  END,
].join('\n');

/** Every role's policy, as end-of-step.md holds it. */
export function document(): string {
  const parts = [
    '# How a step ends',
    '',
    "Generated from `opencode/mods/orchestrate/round-policy.ts`, the one round policy: edit that, then run `scripts/agents.ts`. Each role's prompt carries its own block, as below; `decodeBlock` reads a delivered block back and `policyFaults` compares it with the source. A stop field with no value is left out, never written as a placeholder (`nothing`, `none`, `n/a`): the contract derives each value from the step's persisted history (each item's events, and the step's own: the limit passing, a refused write of its own file), so a placeholder is a value that differs from it.",
  ];
  for (const role of ROLES) parts.push('', `## ${role}`, '', block(role).split('\n').slice(1, -1).join('\n'));
  return `${parts.join('\n')}\n`;
}

/** Each render that ships: its role, host and file (repo-relative). */
export interface Render {
  readonly role: Role;
  readonly host: Host;
  readonly path: string;
}
export const RENDERS: ReadonlyArray<Render> = ROLES.flatMap((role) =>
  HOSTS_OF[role].map((host): Render => ({ role, host, path: host === 'claude' ? `agents/${role}.md` : host === 'codex' ? `codex/agents/${role}.toml` : 'opencode/mods/orchestrate/agents.json' })),
);

/** The prompt a host gives the model, from its file's text. */
export function hostPrompt(host: Host, role: Role, file: string): string {
  if (host === 'claude') return file.replace(/^---\n[\s\S]*?\n---\n/, '');
  if (host === 'codex') {
    const found = /developer_instructions = '''\n([\s\S]*?)\n'''/.exec(file);
    if (found === null) throw new Error(`${role} codex: no developer_instructions`);
    return found[1] ?? '';
  }
  const json = JSON.parse(file) as { agents: Record<string, { system: string }> };
  const agent = json.agents[role];
  if (agent === undefined) throw new Error(`${role} opencode: no agent`);
  return agent.system;
}

/** Every shipped render's faults against the source, read from the files under `root`. */
export const renderFaults = (root: string = ROOT): ReadonlyArray<string> =>
  RENDERS.flatMap(({ role, host, path }) => policyFaults(role, hostPrompt(host, role, readFileSync(join(root, path), 'utf8'))).map((line) => `${host} ${line}`));

/** A stop's evidence, in words, for a role (what retention names as `F2 <role> evidence <stop>`). */
export const evidence = (role: Role, stop: Stop): string =>
  project(role)
    .stops.filter((one) => one.stop === stop)
    .flatMap((one) => one.fields.map((field) => field.text))
    .join('; ');

/** What a verdict writes, in words, for a role (what retention names as `F2 <role> <verdict>`). */
export const written = (role: Role, verdict: string): string | undefined => {
  const rule = project(role).verdicts.find((one) => one.verdict === verdict);
  return rule === undefined ? undefined : writesText(rule.writes);
};

/** A state's label for a role (what retention names as `F1 <role> <state>`): the first row giving that state. */
export const labelOf = (role: Role, state: keyof typeof STATE_NAME): string | undefined => project(role).rows.find((row) => row.state === state)?.label;

export { STOP_TEXT };
