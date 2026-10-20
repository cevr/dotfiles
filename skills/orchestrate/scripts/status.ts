#!/usr/bin/env bun
// The run's status, derived from each unit's log.md rather than typed by hand:
// one row per unit with its current state, round, the time it entered that
// state, and the file that caused the transition.
//
// Usage: bun status.ts <run dir>
//   Reads `<run dir>/<unit>/log.md`. A transition line holds an ISO time,
//   `<from> → <to>` (or `->`), the round as `r<N>` or `round <N>`, and the
//   file that caused it. Other lines (agent-cost receipts) are skipped.
//   Warns when `<run dir>/plan.md` is over 40 KB.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error('usage: bun status.ts <run dir>');
  process.exit(2);
}

const STATE = String.raw`merged [0-9a-f]{6,40}|stuck\(quota\)|[a-z]+`;
const TRANSITION = new RegExp(String.raw`(\S+)\s*(?:→|->)\s*(${STATE})`);

const rows = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'log.md')))
  .map((d) => {
    const lines = readFileSync(join(dir, d.name, 'log.md'), 'utf8').split('\n');
    let row = { unit: d.name, state: '?', round: '', since: '', cause: '' };
    for (const line of lines) {
      const t = TRANSITION.exec(line);
      if (!t) continue;
      row = {
        unit: d.name,
        state: t[2]!,
        round: /\b(?:r|round )(\d+)\b/.exec(line)?.[1] ?? row.round,
        since: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z?/.exec(line)?.[0] ?? '',
        cause: line.match(/\S+\.(?:md|log)\b/g)?.pop() ?? '',
      };
    }
    return row;
  })
  .sort((a, b) => a.unit.localeCompare(b.unit));

console.log('| Unit | State | Round | Since | Cause |');
console.log('| ---- | ----- | ----- | ----- | ----- |');
for (const r of rows) console.log(`| ${r.unit} | ${r.state} | ${r.round} | ${r.since} | ${r.cause} |`);

// The root re-reads plan.md after every compaction; a large one costs every re-read.
const plan = join(dir, 'plan.md');
const planKb = existsSync(plan) ? statSync(plan).size / 1024 : 0;
if (planKb > 40) console.log(`\nplan.md: ${Math.round(planKb)} KB; archive closed sections`);
