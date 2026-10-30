// One unit transition in its log.md: `<time> <from> → <to> r<N> <note>`, written by log.ts.
// `to` is the state's kind (`stuck(quota)` is `stuck`, `merged <sha>` is `merged`); `state` keeps
// the qualifier. Other lines (notes, receipts) are not transitions.
const LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\dZ?)\S*\s+(\S+)\s*(?:→|->)\s*(([a-z]+)(?:\([a-z]+\))?)/;

export type Transition = { at: number; from: string; to: string; state: string; round: number };

/** A log line's transition, or undefined. The round is the first `r<N>` after the time, in either case (`R4` is round 4); none is round 0. */
export function parseTransition(line: string): Transition | undefined {
  const m = LINE.exec(line);
  if (!m) return undefined;
  const round = /\sr(\d+)\b/i.exec(line.slice(m[1].length));
  return { at: Date.parse(m[1].endsWith('Z') ? m[1] : m[1] + 'Z'), from: m[2], to: m[4], state: m[3], round: round ? Number(round[1]) : 0 };
}

export const transitions = (log: string) => log.split('\n').flatMap((l) => parseTransition(l) ?? []);
