#!/usr/bin/env bun
// Every orchestrate run dir touched since a date, one per line, for timing.ts.
// A unit dir holds a log.md with a transition line and no plan.md; its run dir is its parent.
// Usage: bun runs.ts [--since YYYY-MM-DD] [root...]   (roots: ~/Developer, /tmp, ~/.cache/orchestrate)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { transitions } from './transition.ts';

export const ROOTS = [join(homedir(), 'Developer'), '/tmp', join(homedir(), '.cache/orchestrate')];
const SKIP = new Set(['node_modules', '.git', '.next', '.turbo', 'target', 'DerivedData', 'Pods', '.venv']);
const DEPTH = 9;

/** Every unit dir under the roots whose log.md changed since `since`. */
export function unitDirs(roots: string[], since: number): string[] {
  const out = new Set<string>();
  const walk = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === 'log.md' && e.isFile()) && !existsSync(join(dir, 'plan.md'))) {
      const log = join(dir, 'log.md');
      try { if (statSync(log).mtimeMs >= since && transitions(readFileSync(log, 'utf8')).length) out.add(dir); } catch {}
    }
    if (depth < DEPTH) for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name)) walk(join(dir, e.name), depth + 1);
  };
  for (const root of roots) walk(root.replace(/\/$/, ''), 0);
  return [...out].sort();
}

export const runDirs = (roots: string[], since: number) => [...new Set(unitDirs(roots, since).map(dirname))].sort();

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--since');
  const since = at >= 0 ? Date.parse(args[at + 1]) : Date.now() - 7 * 86400e3;
  if (Number.isNaN(since)) { console.error('usage: bun runs.ts [--since YYYY-MM-DD] [root...]'); process.exit(2); }
  const roots = args.filter((a, i) => a !== '--since' && args[i - 1] !== '--since');
  for (const dir of runDirs(roots.length ? roots : ROOTS, since)) console.log(dir);
}
