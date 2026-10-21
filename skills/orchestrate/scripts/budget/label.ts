#!/usr/bin/env bun
// Label this Claude session with the project it works on, for the budget's
// per-project shares and costs: one checkout can hold several projects (manna
// holds the hymnal, First the Blade and the film lab), so the session names
// its project, not its directory. The status mod runs this at session start.
//
// Usage: bun label.ts               label from the herdr workspace's name
//        bun label.ts --set <name>  fix the label; later defaults keep it
//        bun label.ts --all         label every live herdr Claude session
// Writes ~/.cache/orchestrate/labels/<session id>.json and prints the label.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Label = { project: string; source: 'herdr' | 'set' };

const dir = join(homedir(), '.cache', 'orchestrate', 'labels');
const args = process.argv.slice(2);

function herdr<T>(...argv: string[]): T | undefined {
  try {
    return JSON.parse(Bun.spawnSync(['herdr', ...argv], { timeout: 3e3 }).stdout.toString()).result as T;
  } catch {
    return undefined;
  }
}

const workspaces = (): Map<string, string> =>
  new Map(
    (herdr<{ workspaces: { workspace_id: string; label: string }[] }>('workspace', 'list')?.workspaces ?? []).map((w) => [
      w.workspace_id,
      w.label,
    ]),
  );

// A label the session set itself outlasts the workspace's name.
function write(id: string, next: Label): string {
  const path = join(dir, `${id}.json`);
  try {
    const current: Label = JSON.parse(readFileSync(path, 'utf8'));
    if (current.source === 'set' && next.source !== 'set') return current.project;
  } catch {}
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(next));
  return next.project;
}

if (args.includes('--all')) {
  const names = workspaces();
  type Agent = { agent: string; workspace_id: string; agent_session?: { value?: string } };
  for (const a of herdr<{ agents: Agent[] }>('agent', 'list')?.agents ?? []) {
    const label = names.get(a.workspace_id);
    if (a.agent === 'claude' && a.agent_session?.value && label) {
      console.log(`${a.agent_session.value} ${write(a.agent_session.value, { project: label, source: 'herdr' })}`);
    }
  }
  process.exit(0);
}

const id = process.env.CLAUDE_CODE_SESSION_ID;
if (!id) process.exit(0);
const set = args.indexOf('--set');
const label =
  set >= 0 && args[set + 1]
    ? args.slice(set + 1).join(' ')
    : process.env.HERDR_WORKSPACE_ID
      ? workspaces().get(process.env.HERDR_WORKSPACE_ID)
      : undefined;
if (label) console.log(write(id, { project: label, source: set >= 0 ? 'set' : 'herdr' }));
