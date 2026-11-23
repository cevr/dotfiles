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
//             wait open/close, duplicate, restart and settling unclear) whose evidence the tests compare with `due`;
//   traces    `generateTraces` walks those abstract events and writes each history as the contract's own `Trace`
//             (`concrete`): the one trace type, emitted here and read by `fold`, with the snapshot model's record as
//             the answer the fold is checked against.
// An item starts with one of two events and then takes any events whose precondition holds, in any order; the step
// may stop after any event, so every record along the way is reached. The obstacles are independent facts.
import { type Attempt, type Facts, type Field, type ItemRecord, type Provenance, type Role, type State, type Trace, type TraceEvent as TraceStep } from './round-policy.ts';

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
 * answered by a refusal); `form` gives the refusal a printed `!` command, `allow` a printed allow rule (neither: it printed no remedy).
 */
export function materialize(id: string, facts: Facts, options: { readonly newer?: boolean; readonly form?: boolean; readonly allow?: boolean } = {}): ItemRecord {
  const fields: Field[] = [];
  const result = facts.attempt === 'pass' || facts.attempt === 'fail' || facts.attempt === 'unclear' ? facts.attempt : undefined;
  if (result !== undefined)
    fields.push({ field: 'completed', run: { id: `${id}-a1`, command: `cmd:${id}:check`, output: { kind: 'log', digest: `sha:${id}:a1` }, exit: result === 'pass' ? 0 : result === 'fail' ? 1 : 2, receipt: `rcpt:${id}:a1`, head: `head:${id}`, result } });
  // A refusal is of an attempt: of the newest one, which it denied (after a result, a retry that never started).
  if (facts.attempt === 'started' || facts.refused || (result !== undefined && options.newer === true && (!facts.settled || result === 'unclear')))
    fields.push({ field: 'current', attempt: { id: `${id}-a2`, command: `cmd:${id}:check`, status: facts.refused ? 'denied' : 'interrupted', output: facts.refused ? { kind: 'missing', why: 'not-started' } : { kind: 'partial', digest: `sha:${id}:a2-partial` } } });
  if (facts.refused) fields.push({ field: 'refused', refusal: { what: `action:${id}`, scope: `scope:${id}`, report: `report:${id}`, form: options.form === true ? { kind: 'named', form: `form:${id}` } : options.allow === true ? { kind: 'allow', allow: `allow:${id}` } : { kind: 'none' } } });
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
  | { readonly kind: 'restart' }
  | { readonly kind: 'settle' };

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
    case 'settle':
      if (role !== 'verifier' || at.facts.attempt !== 'unclear' || at.pending?.status === 'started' || !free) return at;
      return { ...at, facts: { ...at.facts, settled: true } };
  }
}

/** A snapshot as the record a step hands over: its facts and the evidence of its latest completed and newest pending attempts and live obstacles. */
export function recordOf(id: string, at: Snapshot): ItemRecord {
  const fields: Field[] = [];
  const run = latest(at.runs);
  if (run !== undefined)
    fields.push({ field: 'completed', run: { id: `${id}-r${run.rev}`, command: `cmd:${id}`, output: { kind: 'log', digest: `sha:${id}:r${run.rev}` }, exit: run.result === 'pass' ? 0 : 1, receipt: `rcpt:${id}:r${run.rev}`, head: `head:${id}`, result: run.result } });
  if (at.pending !== undefined && (run === undefined || at.pending.rev > run.rev))
    fields.push({ field: 'current', attempt: { id: `${id}-r${at.pending.rev}`, command: `cmd:${id}`, status: at.pending.status, output: at.pending.status === 'denied' ? { kind: 'missing', why: 'not-started' } : at.pending.status === 'interrupted' ? { kind: 'missing', why: 'interrupted' } : { kind: 'missing', why: 'missing-authenticated-evidence' } } });
  if (at.facts.refused && at.refusal !== undefined)
    fields.push({ field: 'refused', refusal: { what: `action:${id}:r${at.refusal.rev}`, scope: `scope:${id}`, report: `report:${id}`, form: at.refusal.form ? { kind: 'named', form: `form:${id}` } : { kind: 'none' } } });
  if (at.facts.hostCannot) fields.push({ field: 'cannot', absent: { tool: `tool:${id}`, probe: `probe:${id}`, output: { kind: 'log', digest: `sha:${id}:probe` } } });
  if (at.facts.wait) fields.push({ field: 'waits', ref: `ref:${id}` });
  return { id, facts: at.facts, fields };
}

// ---- traces: the contract's input, generated ------------------------------------------------------------------------

/**
 * An abstract history (`TraceEvent`, by revision) written as the contract's `Trace`: each event the snapshot model
 * takes (`step` changes the snapshot) becomes its concrete event, with the same content-bound values `recordOf`
 * writes; an event the item cannot take there is left out, as a step never records it. The abstract events stay the
 * generator's alphabet; `Trace` (round-policy.ts) is the one type the generator emits and the contract reads.
 */
export function concrete(role: Role, id: string, events: ReadonlyArray<TraceEvent>, required = true): { readonly trace: Trace; readonly snapshot: Snapshot } {
  const out: TraceStep[] = [];
  let at = freshSnapshot(required);
  for (const event of events) {
    const next = step(role, at, event);
    if (next !== at && changed(at, next)) out.push(...concreteOf(id, at, next, event));
    at = next;
  }
  return { trace: { id, assignment: { kind: 'assigned', required }, events: out }, snapshot: at };
}

const changed = (a: Snapshot, b: Snapshot): boolean => JSON.stringify(a) !== JSON.stringify(b);
const attemptId = (id: string, rev: number) => `${id}-r${rev}`;

function concreteOf(id: string, at: Snapshot, next: Snapshot, event: TraceEvent): TraceStep[] {
  switch (event.kind) {
    case 'begin':
      return [{ kind: 'begin', attempt: attemptId(id, event.rev), command: `cmd:${id}` }];
    case 'finish':
      return [{ kind: 'finish', attempt: attemptId(id, event.rev), result: event.result, exit: event.result === 'pass' ? 0 : 1, output: { kind: 'log', digest: `sha:${id}:r${event.rev}` }, receipt: `rcpt:${id}:r${event.rev}`, head: `head:${id}` }];
    case 'interrupt':
      return [{ kind: 'interrupt', attempt: attemptId(id, event.rev), output: { kind: 'missing', why: 'interrupted' } }];
    case 'deny':
      return [{ kind: 'deny', attempt: attemptId(id, event.rev), command: `cmd:${id}`, refusal: { what: `action:${id}:r${event.rev}`, scope: `scope:${id}`, report: `report:${id}`, form: event.form ? { kind: 'named', form: `form:${id}` } : { kind: 'none' } } }];
    case 'lift':
      return [{ kind: 'lift' }];
    case 'host':
      if (at.facts.hostCannot === next.facts.hostCannot) return [];
      return [event.open ? { kind: 'hostLost', absent: { tool: `tool:${id}`, probe: `probe:${id}`, output: { kind: 'log', digest: `sha:${id}:probe` } } } : { kind: 'hostBack' }];
    case 'wait':
      if (at.facts.wait === next.facts.wait) return [];
      return [event.open ? { kind: 'waitOpen', ref: `ref:${id}` } : { kind: 'waitClose' }];
    case 'settle':
      return [{ kind: 'settle' }];
    case 'restart':
      return [];
  }
}

/** The abstract events an item could take next, revisions up to `maxRev`. */
function alphabet(at: Snapshot, maxRev: number): TraceEvent[] {
  const top = Math.max(0, ...at.runs.map((run) => run.rev), at.pending?.rev ?? 0);
  const revs = [at.pending?.rev ?? 0, top + 1].filter((rev) => rev > 0 && rev <= maxRev);
  return [
    ...revs.flatMap((rev): TraceEvent[] => [
      { kind: 'begin', rev },
      ...(['pass', 'fail', 'unclear'] as const).map((result): TraceEvent => ({ kind: 'finish', rev, result })),
      { kind: 'interrupt', rev },
      { kind: 'deny', rev, form: false },
      { kind: 'deny', rev, form: true },
    ]),
    { kind: 'lift' },
    { kind: 'host', open: true },
    { kind: 'host', open: false },
    { kind: 'wait', open: true },
    { kind: 'wait', open: false },
    { kind: 'settle' },
  ];
}

export interface Generated {
  readonly role: Role;
  readonly trace: Trace;
  /** The record the snapshot model leaves: the oracle's own answer, independent of the contract's fold. */
  readonly record: ItemRecord;
}

/**
 * Every legal trace of one item up to `depth` events (revisions up to `maxRev`), one per distinct record and
 * history, with the record the snapshot model leaves; and the found items, which take no event.
 */
export function generateTraces(role: Role, depth = 6, maxRev = 3): Generated[] {
  const out = new Map<string, Generated>();
  const requireds = role === 'verifier' ? [true, false] : [true];
  for (const required of requireds) {
    let frontier: TraceEvent[][] = [[]];
    for (let size = 0; size <= depth; size++) {
      const next: TraceEvent[][] = [];
      for (const events of frontier) {
        const { trace, snapshot } = concrete(role, 'item', events, required);
        const key = JSON.stringify(trace);
        if (out.has(key)) continue;
        out.set(key, { role, trace: { ...trace }, record: recordOf('item', snapshot) });
        if (size === depth) continue;
        for (const event of alphabet(snapshot, maxRev)) {
          const after = step(role, snapshot, event);
          if (after !== snapshot && changed(snapshot, after)) next.push([...events, event]);
        }
      }
      frontier = next;
    }
  }
  const found: ReadonlyArray<Provenance> = role === 'verifier' ? ['unit', 'base'] : ['none'];
  for (const provenance of found) {
    const trace: Trace = { id: 'item', assignment: { kind: 'found', provenance }, events: [] };
    const facts: Facts = { assigned: false, required: false, attempt: 'never', settled: true, refused: false, hostCannot: false, wait: false, provenance };
    out.set(JSON.stringify(trace), { role, trace, record: { id: 'item', facts, fields: [] } });
  }
  return [...out.values()];
}
