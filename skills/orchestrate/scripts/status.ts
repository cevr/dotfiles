#!/usr/bin/env bun
// The run's status, derived from each unit's log.md rather than typed by hand:
// one row per unit with its current state, round, the time it entered that
// state, the file that caused the transition, and its batch cadence.
//
// Usage: bun status.ts <run dir>
//   Reads `<run dir>/<unit>/log.md`. A transition line holds an ISO time,
//   `<from> → <to>` (or `->`), the round as `r<N>` or `round <N>`, and the
//   file that caused it. Other lines (agent-cost receipts) are skipped.
//   The cadence (`3 ready or 30 min`) is the unit's spec.md `Batch cadence`
//   line over the plan.md one over the default (cadence.ts).
//   Warns when `<run dir>/plan.md` is over 40 KB.
//   A former state name shows as its current one (`review` as `verify`).
//   Under the table, the run's drift from the machine: the last drift line of `<run dir>/log.md`
//   (drift.ts), which the OpenCode orchestrate plugin writes at each verdict.
//
// Usage: bun status.ts --trend [--since YYYY-MM-DD] [root...]
//   Each run's drift across runs (run dirs as runs.ts finds them, default the last 30 days): its last
//   reading, its readings verdict by verdict, and whether the newer runs drift less than the older.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cadenceOf, formatCadence } from './cadence.ts';
import { driftRow, runReadings, trendTable } from './drift.ts';
import { ROOTS, runDirs } from './runs.ts';
import { currentState } from './transition.ts';

const args = process.argv.slice(2);
if (args[0] === '--trend') {
  const at = args.indexOf('--since');
  const since = at >= 0 ? Date.parse(args[at + 1] ?? '') : Date.now() - 30 * 86400e3;
  if (Number.isNaN(since)) {
    console.error('usage: bun status.ts --trend [--since YYYY-MM-DD] [root...]');
    process.exit(2);
  }
  const roots = args.slice(1).filter((a, i, all) => a !== '--since' && all[i - 1] !== '--since');
  console.log(trendTable(runDirs(roots.length ? roots : ROOTS, since)));
  process.exit(0);
}

const dir = args[0];
if (!dir || !existsSync(dir)) {
  console.error('usage: bun status.ts <run dir>\n       bun status.ts --trend [--since YYYY-MM-DD] [root...]');
  process.exit(2);
}

const STATE = String.raw`merged [0-9a-f]{6,40}|stuck\([a-z]+\)|waiting\(pr\)|[a-z]+(?:-[a-z]+)*`;
const TRANSITION = new RegExp(String.raw`(\S+)\s*(?:→|->)\s*(${STATE})`);

const plan = join(dir, 'plan.md');
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
const planText = read(plan);

const rows = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'log.md')))
  .map((d) => {
    const lines = readFileSync(join(dir, d.name, 'log.md'), 'utf8').split('\n');
    const cadence = formatCadence(cadenceOf(planText, read(join(dir, d.name, 'spec.md'))));
    let row = { unit: d.name, state: '?', round: '', since: '', cause: '', cadence };
    for (const line of lines) {
      const t = TRANSITION.exec(line);
      if (!t) continue;
      row = {
        unit: d.name,
        state: currentState(t[2]!),
        round: /\b(?:r|round )(\d+)\b/.exec(line)?.[1] ?? row.round,
        since: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z?/.exec(line)?.[0] ?? '',
        cause: line.match(/\S+\.(?:md|log)\b/g)?.pop() ?? '',
        cadence,
      };
    }
    return row;
  })
  .sort((a, b) => a.unit.localeCompare(b.unit));

console.log('| Unit | State | Round | Since | Cause | Cadence |');
console.log('| ---- | ----- | ----- | ----- | ----- | ------- |');
for (const r of rows) console.log(`| ${r.unit} | ${r.state} | ${r.round} | ${r.since} | ${r.cause} | ${r.cadence} |`);

const drift = runReadings(dir).at(-1);
if (drift) console.log(`\n${driftRow(drift)}`);

// The root re-reads plan.md after every compaction; a large one costs every re-read.
const planKb = existsSync(plan) ? statSync(plan).size / 1024 : 0;
if (planKb > 40) console.log(`\nplan.md: ${Math.round(planKb)} KB; archive closed sections`);
