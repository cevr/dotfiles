// One unit transition in its log.md: `<time> <from> → <to> r<N> <note>`, written by log.ts.
// `to` is the state's kind (`stuck(quota)` is `stuck`, `merged <sha>` is `merged`); `state` keeps
// the qualifier. Other lines (notes, receipts) are not transitions.
// A state's former name reads as its current one: `review` is `verify`. An older run's
// `verify` (its separate check, before review and the check became one role) reads as
// verify too, so its time and bounces count under the one role that runs both now.
// `integration-check` (a unit merging today's main before its own merge) is `ready`: since
// units land in batches, that wait is the time a unit spends waiting for its batch.
const LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\dZ?)\S*\s+(\S+)\s*(?:→|->)\s*(([a-z]+(?:-[a-z]+)*)(?:\([a-z]+\))?)/;

export const RENAMED: Record<string, string> = { review: 'verify', 'integration-check': 'ready' };
export const currentState = (state: string): string => RENAMED[state] ?? state;

export type Transition = { at: number; from: string; to: string; state: string; round: number };

/** A log line's transition, or undefined. The round is the first `r<N>` after the time, in either case (`R4` is round 4); none is round 0. */
export function parseTransition(line: string): Transition | undefined {
  const m = LINE.exec(line);
  if (!m) return undefined;
  const round = /\sr(\d+)\b/i.exec(line.slice(m[1].length));
  return { at: Date.parse(m[1].endsWith('Z') ? m[1] : m[1] + 'Z'), from: currentState(m[2]), to: currentState(m[4]), state: currentState(m[3]), round: round ? Number(round[1]) : 0 };
}

export const transitions = (log: string) => log.split('\n').flatMap((l) => parseTransition(l) ?? []);
