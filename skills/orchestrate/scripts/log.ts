#!/usr/bin/env bun
// The only writer of a unit's transitions: appends one checked line to `<unit dir>/log.md`
// in the form timing.ts and status.ts read. It refuses an unknown state, a `from` that is not
// the unit's current state, and a round below the last one (a rewrite's decide → r1 excepted).
// Usage: bun log.ts <unit dir> <from> <to> r<N> [note...]
//   The unit's first line comes from `new`. `merged` takes the merge commit as the note's first word.
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { transitions } from './transition.ts';

export const STATES = ['plan', 'implement', 'review', 'verify', 'decide', 'waiting(pr)', 'merged', 'blocked', 'stuck', 'stuck(quota)', 'stuck(size)', 'dropped'];
const MAX = 200;

/** The line to append to a unit's log, or the reason it is refused. */
export function transitionLine(log: string, from: string, to: string, round: string, note: string, now = new Date()): { line: string } | { refused: string } {
  const last = transitions(log).at(-1);
  if (!STATES.includes(to)) return { refused: `unknown state ${to}; one of ${STATES.join(', ')}` };
  if (from !== 'new' && !STATES.includes(from)) return { refused: `unknown state ${from}; one of new, ${STATES.join(', ')}` };
  if (from === 'new' && last) return { refused: `the unit is in ${last.state}; new starts a unit's first line` };
  if (from !== 'new' && !last) return { refused: `the log has no transition; the first line comes from new` };
  if (last && STATES.includes(last.state) && from !== last.state) return { refused: `the unit is in ${last.state}, not ${from}` };
  const n = /^r(\d+)$/.exec(round)?.[1];
  if (n === undefined) return { refused: `round ${round} is not r<N>` };
  const rewrite = from === 'decide' && n === '1' && (to === 'plan' || to === 'implement');
  if (last && Number(n) < last.round && !rewrite) return { refused: `round r${n} is below the last round r${last.round}; only a rewrite (decide → plan or implement r1) starts over` };
  let rest = note.trim();
  let state = to;
  if (to === 'merged') {
    const sha = /^[0-9a-f]{7,40}\b/.exec(rest)?.[0];
    if (!sha) return { refused: 'merged takes the merge commit as the first word of the note' };
    state = `merged ${sha}`;
    rest = rest.slice(sha.length).trim();
  }
  if (/[\r\n]/.test(rest)) return { refused: 'the note is one line' };
  const line = `${now.toISOString().slice(0, 16)}Z ${from} → ${state} r${n}${rest ? ` ${rest}` : ''}`;
  if (line.length > MAX) return { refused: `the line is ${line.length} characters; keep it under ${MAX}` };
  return { line };
}

if (import.meta.main) {
  const [dir, from, to, round, ...note] = process.argv.slice(2);
  if (!dir || !from || !to || !round || !existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error('usage: bun log.ts <unit dir> <from> <to> r<N> [note...]');
    process.exit(2);
  }
  const path = join(dir, 'log.md');
  const log = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const r = transitionLine(log, from, to, round, note.join(' '));
  if ('refused' in r) { console.error(`log.ts refused: ${r.refused}`); process.exit(1); }
  appendFileSync(path, `${log && !log.endsWith('\n') ? '\n' : ''}${r.line}\n`);
  console.log(r.line);
}
