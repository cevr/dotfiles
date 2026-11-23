// The independent oracle the round policy is checked against (round-policy.ts is the renderer and evaluator; this
// file never imports its rows or verdicts):
//   model     an item's facts (the policy's `Facts`), the validity rules that reject a record, each with its
//             justification, and each state as a conjunction of conditions (PREDICATE), exclusive on every valid
//             record; `stateOf` gives the one state an item is in;
//   histories every history one item can have within a step, as sequences of events, and the records they reach
//             (batch 22v: every record the model rejects is one no history reaches, or one two definitions exclude);
//   evidence  `materialize` gives a reached record its content-bound evidence (distinct opaque ids, commands,
//             digests, receipts, heads, refusal scopes and forms, probes, wait refs), and `TRACE_EVENTS` evolve
//             a content snapshot (attempt start, completion, interruption, denial, a late older result, host and
//             wait open/close, duplicate and restart) whose `expected` evidence the tests compare with `due`.
// An item starts with one of two events and then takes any events whose precondition holds, in any order; the step
// may stop after any event, so every record along the way is reached. The obstacles are independent facts.
import { type Attempt, type Facts, type Field, type ItemRecord, type Provenance, type Role, type State } from './round-policy.ts';

export type Item = Facts;
export const OBSTACLE_FACTS = ['refused', 'hostCannot', 'wait'] as const;
export const PROVENANCES = ['none', 'unit', 'base'] as const;
export const ATTEMPTS = ['never', 'started', 'pass', 'fail', 'unclear'] as const;

/** Whether any obstacle holds the item now. */
export const obstructed = (item: Item): boolean => item.refused || item.hostCannot || item.wait;
const hasResult = (item: Item) => item.attempt === 'pass' || item.attempt === 'fail' || item.attempt === 'unclear';

export type Justification = { readonly kind: 'definition'; readonly cites: string } | { readonly kind: 'unreachable'; readonly why: string };
export interface Validity {
  readonly rule: string;
  readonly justification: Justification;
  readonly breaks: (role: Role, item: Item) => boolean;
}
export const VALIDITY: ReadonlyArray<Validity> = [
  {
    rule: "a provenance belongs only to a verifier's finding outside its assignment, and every such finding has one",
    justification: { kind: 'definition', cites: "`provenance` (defined only for a verifier's finding outside its assignment) against `assigned` = true and the other roles" },
    breaks: (role, item) => (role === 'verifier' && !item.assigned) !== (item.provenance !== 'none'),
  },
  {
    rule: 'work outside the assignment is a finding, not work this role runs: it is never attempted, settled as found, meets no obstacle, and is neither required nor optional',
    justification: { kind: 'definition', cites: "`assigned` = false (not this role's work) against `attempt`, `settled` and the obstacles (this role's work on it) and `required` (the assignment's)" },
    breaks: (_, item) => !item.assigned && (item.attempt !== 'never' || !item.settled || obstructed(item) || item.required),
  },
  {
    rule: 'only a verifier has optional work (a wider probe); every item of a spec or task is required',
    justification: { kind: 'definition', cites: "`required`: every spec item and the task are required; `optional` is defined as a verifier's wider probe" },
    breaks: (role, item) => item.assigned && !item.required && role !== 'verifier',
  },
  {
    rule: 'a settled item is settled by a result: it has one',
    justification: { kind: 'definition', cites: '`settled` (its last result decides it) against `never` and `started` (no result)' },
    breaks: (_, item) => item.assigned && item.settled && !hasResult(item),
  },
  {
    rule: "a planner's, implementor's or worker's item is settled only by its acceptance holding; a failed or unclear attempt leaves it to advance or to an obstacle",
    justification: { kind: 'definition', cites: '`settled` for their work is acceptance holding (`pass`); `fail` and `unclear` are acceptance not holding' },
    breaks: (role, item) => role !== 'verifier' && item.assigned && item.settled && item.attempt !== 'pass',
  },
  {
    rule: "a verifier's failed check is a proof, which settles it",
    justification: { kind: 'definition', cites: "`fail` for a verifier's check is a proof of a Blocker or Major; `settled` is a result no retry changes" },
    breaks: (role, item) => role === 'verifier' && item.attempt === 'fail' && !item.settled,
  },
  {
    rule: 'a refusal answers an attempt: a refused item was attempted',
    justification: { kind: 'definition', cites: '`refused` (a refusal stopped an attempt) against `never` (no attempt)' },
    breaks: (_, item) => item.refused && item.attempt === 'never',
  },
  {
    rule: 'a passed item stays settled within the step: nothing reopens it',
    justification: { kind: 'unreachable', why: 'every attempt of these histories that passes settles its item, and no event unsettles one' },
    breaks: (_, item) => item.attempt === 'pass' && !item.settled,
  },
  {
    rule: 'a settled item meets no obstacle: no further work on it is left for one to hold back',
    justification: { kind: 'unreachable', why: 'no obstacle event of these histories applies to a settled item' },
    breaks: (_, item) => item.settled && obstructed(item),
  },
];

/** The first validity rule an item breaks for this role, or undefined when some history produces it. */
export const validity = (role: Role, item: Item, rules: ReadonlyArray<Validity> = VALIDITY): string | undefined => rules.find((one) => one.breaks(role, item))?.rule;

/** A predicate's one condition: a field with the value, or one of the values, it must have. */
export type Condition =
  | readonly ['assigned' | 'required' | 'settled' | 'refused' | 'hostCannot' | 'wait', boolean]
  | readonly ['attempt', ReadonlyArray<Attempt>]
  | readonly ['provenance', Provenance];
export type Predicates = Record<State, ReadonlyArray<Condition>>;
/** Each state as a conjunction of conditions, exclusive on every valid record (refused before host before wait). */
export const PREDICATE: Predicates = {
  done: [['assigned', true], ['attempt', ['pass']]],
  proven: [['assigned', true], ['attempt', ['fail']]],
  runnable: [['assigned', true], ['required', true], ['settled', false], ['refused', false], ['hostCannot', false], ['wait', false]],
  waits: [['assigned', true], ['required', true], ['refused', false], ['hostCannot', false], ['wait', true]],
  refused: [['assigned', true], ['refused', true]],
  cannot: [['assigned', true], ['required', true], ['refused', false], ['hostCannot', true]],
  unclear: [['assigned', true], ['required', true], ['attempt', ['unclear']], ['settled', true]],
  unproven: [['assigned', true], ['required', false], ['refused', false], ['attempt', ['never', 'started', 'unclear']]],
  discovery: [['assigned', false]],
  unitFinding: [['assigned', false], ['provenance', 'unit']],
  baseFinding: [['assigned', false], ['provenance', 'base']],
};

/** The states each role has: the oracle's own copy, compared with the policy's. */
export const ORACLE_STATES: Record<Role, ReadonlyArray<State>> = {
  planner: ['done', 'runnable', 'waits', 'refused', 'cannot', 'discovery'],
  implementor: ['done', 'runnable', 'waits', 'refused', 'cannot', 'discovery'],
  verifier: ['done', 'proven', 'runnable', 'waits', 'refused', 'cannot', 'unclear', 'unproven', 'unitFinding', 'baseFinding'],
  worker: ['done', 'runnable', 'waits', 'refused', 'cannot', 'discovery'],
};

export const meets = (item: Item, condition: Condition): boolean => {
  const [field, value] = condition;
  return field === 'attempt' ? (value as ReadonlyArray<Attempt>).includes(item.attempt) : item[field] === value;
};

/** Every state of the role whose predicate the item meets: exactly one for a valid item. */
export const matching = (role: Role, item: Item, predicates: Predicates = PREDICATE): State[] =>
  ORACLE_STATES[role].filter((state) => predicates[state].every((condition) => meets(item, condition)));

/** The one state of a valid item; throws on an invalid item, or on none or several (a predicate fault). */
export function stateOf(role: Role, item: Item, predicates: Predicates = PREDICATE): State {
  const bad = validity(role, item);
  if (bad !== undefined) throw new Error(`ill-formed item: ${bad}`);
  const found = matching(role, item, predicates);
  if (found.length !== 1) throw new Error(`${role} item in ${found.length} states: ${found.join(', ')}`);
  return found[0] as State;
}

/** Every record, valid or not: assigned × required × attempt × settled × each obstacle × provenance. */
export function allItems(): Item[] {
  const out: Item[] = [];
  const both = [true, false];
  for (const assigned of both)
    for (const required of both)
      for (const attempt of ATTEMPTS)
        for (const settled of both)
          for (const refused of both)
            for (const hostCannot of both) for (const wait of both) for (const provenance of PROVENANCES) out.push({ assigned, required, attempt, settled, refused, hostCannot, wait, provenance });
  return out;
}

// ---- histories -----------------------------------------------------------------------------------------------------

export interface Event {
  readonly name: string;
  /** The record after the event, or undefined when its precondition does not hold. */
  readonly apply: (role: Role, item: Item) => Item | undefined;
}

const open = (item: Item, when: boolean, next: Partial<Item>): Item | undefined => (item.assigned && !item.settled && when ? { ...item, ...next } : undefined);
const settles = (role: Role, result: Attempt) => result === 'pass' || (result === 'fail' && role === 'verifier');

export const EVENTS: ReadonlyArray<Event> = [
  ...(['started', 'pass', 'fail', 'unclear'] as const).map(
    (result): Event => ({ name: `attempt → ${result === 'started' ? 'no result yet' : result}`, apply: (role, item) => open(item, !obstructed(item), { attempt: result, settled: settles(role, result) }) }),
  ),
  { name: 'retry becomes unavailable', apply: (role, item) => open(item, role === 'verifier' && item.attempt === 'unclear' && !obstructed(item), { settled: true }) },
  { name: 'wait opens', apply: (_, item) => open(item, !item.wait, { wait: true }) },
  { name: 'wait closes', apply: (_, item) => open(item, item.wait, { wait: false }) },
  { name: 'refusal', apply: (_, item) => open(item, !item.refused, { refused: true, attempt: item.attempt === 'never' ? 'started' : item.attempt }) },
  { name: 'refusal lifted', apply: (_, item) => open(item, item.refused, { refused: false }) },
  { name: 'host probe fails', apply: (_, item) => open(item, !item.hostCannot, { hostCannot: true }) },
  { name: 'host recovers', apply: (_, item) => open(item, item.hostCannot, { hostCannot: false }) },
];

/** The records an item starts as. */
export function starts(role: Role): Item[] {
  const fresh = { attempt: 'never' as const, settled: false, refused: false, hostCannot: false, wait: false, provenance: 'none' as const };
  const assigned: Item[] = [{ assigned: true, required: true, ...fresh }, ...(role === 'verifier' ? [{ assigned: true, required: false, ...fresh }] : [])];
  const found: ReadonlyArray<Provenance> = role === 'verifier' ? ['unit', 'base'] : ['none'];
  return [...assigned, ...found.map((provenance): Item => ({ ...fresh, assigned: false, required: false, settled: true, provenance }))];
}

export const recordKey = (item: Item) =>
  `${item.assigned}/${item.required}/${item.attempt}/${item.settled ? 'settled' : 'open'}/${[item.refused ? 'refused' : '', item.hostCannot ? 'hostCannot' : '', item.wait ? 'wait' : ''].filter(Boolean).join('+') || 'free'}/${item.provenance}`;

/** Every record some history reaches, with one shortest history that reaches each. */
export function reachable(role: Role, events: ReadonlyArray<Event> = EVENTS): Map<string, { item: Item; history: string[] }> {
  const seen = new Map<string, { item: Item; history: string[] }>();
  const queue = starts(role).map((item) => ({ item, history: [item.assigned ? `assign(${item.required ? 'required' : 'optional'})` : `discover(${item.provenance})`] }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(recordKey(next.item))) continue;
    seen.set(recordKey(next.item), next);
    for (const event of events) {
      const item = event.apply(role, next.item);
      if (item !== undefined && !seen.has(recordKey(item))) queue.push({ item, history: [...next.history, event.name] });
    }
  }
  return seen;
}

// ---- evidence ------------------------------------------------------------------------------------------------------

/**
 * A record with its facts' content-bound evidence: distinct opaque values derived from `id` (redacted shapes, never
 * a real command, path or log). `newer` adds a `current` attempt beside a finished one (a retry interrupted or
 * answered by a refusal); `form` names the refusal's accepted form.
 */
export function materialize(id: string, facts: Facts, options: { readonly newer?: boolean; readonly form?: boolean } = {}): ItemRecord {
  const fields: Field[] = [];
  const result = facts.attempt === 'pass' || facts.attempt === 'fail' || facts.attempt === 'unclear' ? facts.attempt : undefined;
  if (result !== undefined)
    fields.push({ field: 'completed', run: { id: `${id}-a1`, command: `cmd:${id}:check`, output: { kind: 'log', digest: `sha:${id}:a1` }, exit: result === 'pass' ? 0 : result === 'fail' ? 1 : 2, receipt: `rcpt:${id}:a1`, head: `head:${id}`, result } });
  if (facts.attempt === 'started' || (result !== undefined && options.newer === true))
    fields.push({ field: 'current', attempt: { id: `${id}-a2`, command: `cmd:${id}:check`, status: facts.refused ? 'denied' : 'interrupted', output: facts.refused ? { kind: 'missing', why: 'not-started' } : { kind: 'partial', digest: `sha:${id}:a2-partial` } } });
  if (facts.refused) fields.push({ field: 'refused', refusal: { what: `action:${id}`, scope: `scope:${id}`, report: `report:${id}`, form: options.form === true ? { kind: 'named', form: `form:${id}` } : { kind: 'none' } } });
  if (facts.hostCannot) fields.push({ field: 'cannot', absent: { tool: `tool:${id}`, probe: `probe:${id}`, output: { kind: 'log', digest: `sha:${id}:probe` } } });
  if (facts.wait) fields.push({ field: 'waits', ref: `ref:${id}` });
  return { id, facts, fields };
}

/**
 * The content events of one item's step, applied to a snapshot: each carries its own ids, so a duplicate or a late
 * older delivery is visible. `expected` is what a correct snapshot holds, tracked independently of the snapshot
 * (the latest completed attempt by revision, the newest unfinished one, and each obstacle's evidence).
 */
export type TraceEvent =
  | { readonly kind: 'begin'; readonly rev: number }
  | { readonly kind: 'finish'; readonly rev: number; readonly result: 'pass' | 'fail' | 'unclear' }
  | { readonly kind: 'interrupt'; readonly rev: number }
  | { readonly kind: 'deny'; readonly rev: number; readonly form: boolean }
  | { readonly kind: 'lift' }
  | { readonly kind: 'host'; readonly open: boolean }
  | { readonly kind: 'wait'; readonly open: boolean }
  | { readonly kind: 'restart' };

export interface Snapshot {
  readonly facts: Facts;
  readonly runs: ReadonlyArray<{ readonly rev: number; readonly result: 'pass' | 'fail' | 'unclear' }>;
  readonly pending: { readonly rev: number; readonly status: 'started' | 'interrupted' | 'denied' } | undefined;
  readonly refusal: { readonly rev: number; readonly form: boolean } | undefined;
}

export const freshSnapshot = (required: boolean): Snapshot => ({
  facts: { assigned: true, required, attempt: 'never', settled: false, refused: false, hostCannot: false, wait: false, provenance: 'none' },
  runs: [],
  pending: undefined,
  refusal: undefined,
});

const latest = (runs: Snapshot['runs']) => runs.reduce<Snapshot['runs'][number] | undefined>((best, run) => (best === undefined || run.rev > best.rev ? run : best), undefined);

/** One event on a snapshot, or the snapshot unchanged when its precondition does not hold (an event the item cannot take). */
export function step(role: Role, at: Snapshot, event: TraceEvent): Snapshot {
  const free = !at.facts.refused && !at.facts.hostCannot && !at.facts.wait;
  const live = at.facts.assigned && !at.facts.settled;
  if (!live || event.kind === 'restart') return at;
  switch (event.kind) {
    case 'begin':
      if (!free || at.pending?.status === 'started' || Math.max(latest(at.runs)?.rev ?? 0, at.pending?.rev ?? 0) >= event.rev) return at;
      return { ...at, pending: { rev: event.rev, status: 'started' }, facts: { ...at.facts, attempt: at.runs.length === 0 ? 'started' : at.facts.attempt } };
    case 'finish': {
      if (at.pending === undefined || at.pending.rev !== event.rev || at.pending.status === 'denied') return at;
      const runs = [...at.runs, { rev: event.rev, result: event.result }];
      // A result that settles the item leaves nothing for a host loss or a wait opened during the run to hold back.
      const settled = settles(role, event.result);
      const obstacles = settled ? { hostCannot: false, wait: false } : {};
      return { ...at, runs, pending: undefined, facts: { ...at.facts, ...obstacles, attempt: event.result, settled } };
    }
    case 'interrupt':
      if (at.pending === undefined || at.pending.rev !== event.rev || at.pending.status !== 'started') return at;
      return { ...at, pending: { rev: event.rev, status: 'interrupted' } };
    case 'deny':
      if (at.facts.refused) return at;
      if (!(at.pending?.status === 'started' && at.pending.rev === event.rev) && !(at.pending?.status !== 'started' && event.rev > Math.max(latest(at.runs)?.rev ?? 0, at.pending?.rev ?? 0))) return at;
      return { ...at, pending: { rev: event.rev, status: 'denied' }, refusal: { rev: event.rev, form: event.form }, facts: { ...at.facts, refused: true, attempt: at.runs.length === 0 ? 'started' : at.facts.attempt } };
    case 'lift':
      if (!at.facts.refused) return at;
      return { ...at, refusal: undefined, facts: { ...at.facts, refused: false } };
    case 'host':
      return { ...at, facts: { ...at.facts, hostCannot: event.open } };
    case 'wait':
      return { ...at, facts: { ...at.facts, wait: event.open } };
  }
}

/** A snapshot as the record a step hands over: its facts and the evidence of its latest completed and newest pending attempts and live obstacles. */
export function recordOf(id: string, at: Snapshot): ItemRecord {
  const fields: Field[] = [];
  const run = latest(at.runs);
  if (run !== undefined)
    fields.push({ field: 'completed', run: { id: `${id}-r${run.rev}`, command: `cmd:${id}`, output: { kind: 'log', digest: `sha:${id}:r${run.rev}` }, exit: run.result === 'pass' ? 0 : 1, receipt: `rcpt:${id}:r${run.rev}`, head: `head:${id}`, result: run.result } });
  if (at.pending !== undefined && (run === undefined || at.pending.rev > run.rev))
    fields.push({ field: 'current', attempt: { id: `${id}-r${at.pending.rev}`, command: `cmd:${id}`, status: at.pending.status, output: at.pending.status === 'denied' ? { kind: 'missing', why: 'not-started' } : { kind: 'missing', why: 'interrupted' } } });
  if (at.facts.refused && at.refusal !== undefined)
    fields.push({ field: 'refused', refusal: { what: `action:${id}:r${at.refusal.rev}`, scope: `scope:${id}`, report: `report:${id}`, form: at.refusal.form ? { kind: 'named', form: `form:${id}` } : { kind: 'none' } } });
  if (at.facts.hostCannot) fields.push({ field: 'cannot', absent: { tool: `tool:${id}`, probe: `probe:${id}`, output: { kind: 'log', digest: `sha:${id}:probe` } } });
  if (at.facts.wait) fields.push({ field: 'waits', ref: `ref:${id}` });
  return { id, facts: at.facts, fields };
}
