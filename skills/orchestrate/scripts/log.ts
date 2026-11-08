#!/usr/bin/env bun
// The only writer of a unit's transitions: appends one checked line to `<unit dir>/log.md`
// in the form timing.ts and status.ts read. It refuses an unknown state, a `from` that is not
// the unit's current state, and a round below the last one (a rewrite's decide → r1 excepted).
// A former state name (`review`, which a session that read the skill before the rename still
// writes; `integration-check`, from before batches) is recorded as its current one (`verify`;
// `ready`), as transition.ts reads it.
// Usage: bun log.ts <unit dir> <from> <to> r<N> [note...]
//        bun log.ts --current <unit dir> <to> r<N> [note...]
//   The unit's first line comes from `new`. `merged` takes the merge commit as the note's first word.
//   The moves follow SKILL.md's machine: implement → ready (focused gate green), ready → verify
//   (its batch landed), verify → merged, waiting(pr) or implement r<N+1>; this script checks the
//   states and rounds, not which move follows which.
//   `--current` moves from the unit's current state (`new` with no log) and writes nothing when the
//   unit is already in `to` at round N: the OpenCode orchestrate plugin writes a role's start and
//   hand-back this way, so a move the orchestrator logged first is not logged twice.
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { currentState, transitions } from './transition.ts';

export const STATES = ['plan', 'implement', 'verify', 'decide', 'ready', 'waiting(pr)', 'merged', 'blocked', 'stuck', 'stuck(quota)', 'stuck(size)', 'dropped'];
const MAX = 200;

/** The line to append to a unit's log, or the reason it is refused. */
export function transitionLine(log: string, asked: string, askedTo: string, round: string, note: string, now = new Date()): { line: string } | { refused: string } {
  const from = currentState(asked), to = currentState(askedTo);
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

/** The line moving the unit from its current state to `to`, none when it is already there in that round, or the reason it is refused. */
export function currentLine(log: string, to: string, round: string, note: string, now = new Date()): { line: string } | { refused: string } | { already: string } {
  const last = transitions(log).at(-1);
  if (last && last.state === currentState(to) && `r${last.round}` === round) return { already: `the unit is in ${last.state} r${last.round}` };
  return transitionLine(log, last?.state ?? 'new', to, round, note, now);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const current = args[0] === '--current';
  const [dir, from, to, round, ...note] = current ? [args[1], 'current', ...args.slice(2)] : args;
  if (!dir || !from || !to || !round || !existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error('usage: bun log.ts <unit dir> <from> <to> r<N> [note...]\n       bun log.ts --current <unit dir> <to> r<N> [note...]');
    process.exit(2);
  }
  const path = join(dir, 'log.md');
  const log = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const r = current ? currentLine(log, to, round, note.join(' ')) : transitionLine(log, from, to, round, note.join(' '));
  if ('already' in r) { console.log(`unchanged: ${r.already}`); process.exit(0); }
  if ('refused' in r) { console.error(`log.ts refused: ${r.refused}`); process.exit(1); }
  appendFileSync(path, `${log && !log.endsWith('\n') ? '\n' : ''}${r.line}\n`);
  console.log(r.line);
}
