#!/usr/bin/env bun
// The run's status, derived on every call from each unit's files and git, never kept: one row per
// open unit with its state, round, the time it entered that state, the file that caused it, and
// the newest verdict.
//
// Usage: bun status.ts <run dir> [--repo <checkout>] [--all]
//   A unit is a directory of the run dir holding log.md. Its state:
//   - `dropped` when its log's last state is `dropped`;
//   - `merged` when its log says so, or when the head its newest `round-N-request.md` names
//     (request.ts `headOf`) is an ancestor of the repository's default branch, whatever its log
//     says (`merged <head>`); the default branch is origin's (`origin/HEAD`), else the checkout's
//     own `main`, else `master`, local refs as they are;
//   - otherwise its log's last state (a former name as its current one: `review` as `verify`).
//   Verdict: the first line's verdict of its newest `round-N-findings.md`, with its round
//   (`changes r1`). The repository is `--repo`, else the git checkout holding the run dir; with
//   none, or no default branch, a unit keeps its log's state. git runs once per open unit at most.
//   Merged and dropped units are left out unless `--all`.
//   Warns when `<run dir>/plan.md` is over 40 KB.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { headOf } from './request.ts';
import { currentState } from './transition.ts';

const STATE = String.raw`merged [0-9a-f]{6,40}|stuck\([a-z]+\)|waiting\(pr\)|[a-z]+(?:-[a-z]+)*`;
const TRANSITION = new RegExp(String.raw`(\S+)\s*(?:→|->)\s*(${STATE})`);

export interface Row {
  readonly unit: string;
  readonly state: string;
  readonly round: string;
  readonly since: string;
  readonly cause: string;
  readonly verdict: string;
}

/** The unit's row as its log.md alone says it: its last transition's state, round, time and cause. */
export function logRow(unit: string, log: string): Omit<Row, 'verdict'> {
  let row = { unit, state: '?', round: '', since: '', cause: '' };
  for (const line of log.split('\n')) {
    const t = TRANSITION.exec(line);
    if (!t) continue;
    row = {
      unit,
      state: currentState(t[2]!),
      round: /\b(?:r|round )(\d+)\b/.exec(line)?.[1] ?? row.round,
      since: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z?/.exec(line)?.[0] ?? '',
      cause: line.match(/\S+\.(?:md|log)\b/g)?.pop() ?? '',
    };
  }
  return row;
}

/** The unit dir's newest `round-N-<kind>.md`: its round and path. */
export function newest(dir: string, kind: 'request' | 'findings'): { round: number; path: string } | undefined {
  const pattern = new RegExp(`^round-(\\d+)-${kind}\\.md$`);
  let found: { round: number; path: string } | undefined;
  for (const name of readdirSync(dir)) {
    const n = pattern.exec(name)?.[1];
    if (n !== undefined && (!found || Number(n) > found.round)) found = { round: Number(n), path: join(dir, name) };
  }
  return found;
}

/** The verdict a findings file's first non-blank line states, lowercased. */
export function verdictOf(text: string): string | undefined {
  const first = text.split('\n').find((line) => line.trim() !== '') ?? '';
  return /\b(accepted|changes|stuck)\b/i.exec(first)?.[1]?.toLowerCase();
}

/** One git command in `repo`: its exit code and trimmed output. */
const git = (repo: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'ignore' });
  return { code: run.exitCode, out: run.stdout.toString().trim() };
};

/** The checkout holding `dir`, if any. */
export function checkoutOf(dir: string): string | undefined {
  const top = git(dir, 'rev-parse', '--show-toplevel');
  return top.code === 0 && top.out !== '' ? top.out : undefined;
}

/** The commit of the repository's default branch: origin's, else `main`, else `master`; none outside a repository. */
export function defaultHead(repo: string): string | undefined {
  if (!existsSync(repo)) return undefined;
  for (const ref of ['refs/remotes/origin/HEAD', 'refs/heads/main', 'refs/heads/master']) {
    const at = git(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    if (at.code === 0 && /^[0-9a-f]{40}$/.test(at.out)) return at.out;
  }
  return undefined;
}

const CLOSED = (state: string) => state === 'dropped' || /^merged\b/.test(state);

/** Every unit's row in `dir`, derived from its files and, with `repo`, git. */
export function rows(dir: string, repo: string | undefined): Row[] {
  let main: string | undefined | null = null; // read once, on the first unit that needs it
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'log.md')))
    .map((d): Row => {
      const unitDir = join(dir, d.name);
      const row = logRow(d.name, readFileSync(join(unitDir, 'log.md'), 'utf8'));
      const findings = newest(unitDir, 'findings');
      const said = findings ? verdictOf(readFileSync(findings.path, 'utf8')) : undefined;
      const verdict = findings && said ? `${said} r${findings.round}` : '';
      if (CLOSED(row.state) || repo === undefined) return { ...row, verdict };
      const request = newest(unitDir, 'request');
      const head = request ? headOf(readFileSync(request.path, 'utf8')) : undefined;
      if (head === undefined) return { ...row, verdict };
      if (main === null) main = defaultHead(repo);
      if (main === undefined) return { ...row, verdict };
      const merged = git(repo, 'merge-base', '--is-ancestor', head, main).code === 0;
      return { ...row, state: merged ? `merged ${head.slice(0, 7)}` : row.state, verdict };
    })
    .sort((a, b) => a.unit.localeCompare(b.unit));
}

/** The table status prints: open units, or every unit with `all`. */
export function table(list: ReadonlyArray<Row>, all: boolean): string {
  const shown = list.filter((r) => all || !CLOSED(r.state));
  return [
    '| Unit | State | Round | Since | Cause | Verdict |',
    '| ---- | ----- | ----- | ----- | ----- | ------- |',
    ...shown.map((r) => `| ${r.unit} | ${r.state} | ${r.round} | ${r.since} | ${r.cause} | ${r.verdict} |`),
  ].join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const at = args.indexOf('--repo');
  const given = at >= 0 ? args[at + 1] : undefined;
  const dir = args.find((arg, i) => !arg.startsWith('--') && (at < 0 || i !== at + 1));
  if (!dir || !existsSync(dir) || (at >= 0 && !given)) {
    console.error('usage: bun status.ts <run dir> [--repo <checkout>] [--all]');
    process.exit(2);
  }
  const repo = given ?? checkoutOf(dir);
  console.log(table(rows(dir, repo), all));
  // The root re-reads plan.md after every compaction; a large one costs every re-read.
  const plan = join(dir, 'plan.md');
  const planKb = existsSync(plan) ? statSync(plan).size / 1024 : 0;
  if (planKb > 40) console.log(`\nplan.md: ${Math.round(planKb)} KB; archive closed sections`);
}
