#!/usr/bin/env bun
// Every orchestrate run dir touched since a date, one per line, for timing.ts.
// A unit dir holds a log.md with a transition line and no plan.md; its run dir is its parent.
// A test's fixture (a `log-*`, `timing-*`, `runs-*`, `request-*` or `agents-*` dir made right under a temp root) is no run,
// a removed Rift kept in a `.trash` is no run either, and a dir reached by two paths (a symlink, macOS's /tmp → /private/tmp) is listed once, by the first path that reached it.
// Usage: bun runs.ts [--since YYYY-MM-DD] [root...]   (roots: ~/Developer, /tmp, ~/.cache/orchestrate, ~/.cache/baton)
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { transitions } from './transition.ts';

const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };

/** The temp roots, where a test's fixtures live: /tmp and $TMPDIR. */
export const TEMP = ['/tmp', tmpdir()];
export const ROOTS = [join(homedir(), 'Developer'), '/tmp', join(homedir(), '.cache/orchestrate'), join(homedir(), '.cache/baton')];
/** The dirs the skill's own tests make with mkdtemp (the `*.test.ts` beside this file). */
const FIXTURE = /^(?:log|timing|runs|request|agents)-/;
const SKIP = new Set(['node_modules', '.git', '.next', '.turbo', 'target', 'DerivedData', 'Pods', '.venv', '.trash']);
const DEPTH = 9;

/** Every unit dir under the roots whose log.md changed since `since`, once per real path; `temp` are the roots whose fixtures are skipped. */
export function unitDirs(roots: string[], since: number, temp: string[] = TEMP): string[] {
  const out = new Map<string, string>();
  const temps = new Set(temp.flatMap((p) => [p.replace(/\/$/, ''), real(p)]));
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    const at = real(dir);
    if (seen.has(at)) return;
    seen.add(at);
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === 'log.md' && e.isFile()) && !existsSync(join(dir, 'plan.md'))) {
      const log = join(dir, 'log.md');
      try { if (statSync(log).mtimeMs >= since && transitions(readFileSync(log, 'utf8')).length) out.set(at, dir); } catch {}
    }
    const fixtures = temps.has(dir) || temps.has(at);
    if (depth < DEPTH) for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !(fixtures && FIXTURE.test(e.name))) walk(join(dir, e.name), depth + 1);
  };
  for (const root of roots) walk(root.replace(/\/$/, ''), 0);
  return [...out.values()].sort();
}

export const runDirs = (roots: string[], since: number, temp: string[] = TEMP) => [...new Set(unitDirs(roots, since, temp).map(dirname))].sort();

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--since');
  const since = at >= 0 ? Date.parse(args[at + 1]) : Date.now() - 7 * 86400e3;
  if (Number.isNaN(since)) { console.error('usage: bun runs.ts [--since YYYY-MM-DD] [root...]'); process.exit(2); }
  const roots = args.filter((a, i) => a !== '--since' && args[i - 1] !== '--since');
  for (const dir of runDirs(roots.length ? roots : ROOTS, since)) console.log(dir);
}
