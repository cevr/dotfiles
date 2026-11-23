// How a step ends, as two independent total functions (batch 22t: "the stopping event and each outstanding
// item's status are distinct facts"), over one explicit item model (batch 22u: the states are predicates over an
// item's facts, proven a partition by enumeration; batch 22v: what an item's attempts printed and what it can do now
// are separate facts, and every record the model rejects is justified):
//   model   an Item is its assignment, its ATTEMPT history (the last attempt's result), whether a result settles it,
//           and its current OBSTACLES as a set (batch 23b: refused, host cannot run, a live wait can hold together);
//           `validity` rejects a record, each rule with its justification (VALIDITY): either two
//           definitions exclude each other, or no history reaches it (item-histories.ts generates every history and
//           the test compares the reachable records with the valid ones, both ways);
//   states  each state is a conjunction of conditions (PREDICATE), exclusive on every valid record; `stateOf` gives
//           the one state an item is in;
//   F1  label(role, state, attempt) the state, and for runnable work whether it was attempted, give the item's label,
//                                   whatever stopped the step;
//   list    the prompt carries F1 as an ORDERED decision list (DECISIONS: take the first row true of the item, the last
//           row a catch-all), each row's condition written in one grammar (ATOMS: `condition` emits it, `parseCondition`
//           reads it back) and read as generously as its English allows (READS). Batch 22w: independent English rows
//           can always overlap, so the rows are ordered instead; the test computes every pair of rows true together
//           on a reachable record and ORDER pins each one's winner with the evidence that must survive; the attempt
//           history (ATTEMPT_NOTE) and any other obstacle that holds (OTHER_OBSTACLES_NOTE) are separate
//           instructions, never competing rows, and `handBackFrom` derives from a prompt's words the hand-back due;
//   F2  outcome(role, stop, states) the multiset of the REQUIRED items' states (an optional probe's state never
//                                   changes it, save a refused one: a refusal stops the step whatever the item) gives the verdict, by a stated precedence, and the files; the stop
//                                   event gives the evidence they hold.
// An input no step can produce is rejected as ill-formed, never answered.
// agents.ts renders a role's two tables into its prompt between BEGIN and END, every role's into end-of-step.md.
// Edit here, then run agents.ts (and opencode's `bun run agents`).

export const ROLES = ['planner', 'implementor', 'verifier', 'worker'] as const;
export type Role = (typeof ROLES)[number];

// ---- the item model ------------------------------------------------------------------------------------------------

/** The attempt history: never attempted, or attempted with its LAST result (none yet, pass, fail, uninterpretable). */
export const ATTEMPTS = ['never', 'started', 'pass', 'fail', 'unclear'] as const;
export type Attempt = (typeof ATTEMPTS)[number];
/** The obstacles that can hold an item now, any subset of them at once (batch 23b). */
export const OBSTACLE_FACTS = ['refused', 'hostCannot', 'wait'] as const;
export type Obstacle = (typeof OBSTACLE_FACTS)[number];
export const PROVENANCES = ['none', 'unit', 'base'] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** One item, as its own history decides it before it is classified. */
export interface Item {
  /** Part of the role's assignment (`ASSIGNMENT`): spec items, or the lean worker's first-message task. */
  readonly assigned: boolean;
  /** Required by the assignment, or an optional wider probe; decided before classification. */
  readonly required: boolean;
  /**
   * What its attempts printed: `never` attempted; `started` (attempted, no result yet: interrupted, or answered by a
   * refusal); or the last attempt's result: `pass` (its acceptance holds; for a verifier's check, it passed), `fail`
   * (for a verifier's check, a proof of a Blocker or Major; for other work, acceptance that did not hold), `unclear` (a
   * result that settles neither pass nor fail).
   */
  readonly attempt: Attempt;
  /** Its last result decides it here: no retry or further work can change it. Otherwise it can still advance, once no obstacle holds it. */
  readonly settled: boolean;
  /**
   * The current obstacles, each its own fact, so two or three can hold at once (batch 23b: a refusal and a missing
   * tool; a missing tool and a live wait): `refused` (a refusal stopped it), `hostCannot` (this host cannot run it:
   * its check or tool is absent or will not start), `wait` (a live wait on an id: an open unit, question,
   * commitment, or two spec lines that contradict).
   */
  readonly refused: boolean;
  readonly hostCannot: boolean;
  readonly wait: boolean;
  /** For a verifier's finding outside its assignment: `unit` if the unit's change introduced it, `base` if the base head shows it too. */
  readonly provenance: Provenance;
}

/** What each role is assigned: discovery is relative to it (A3). */
export const ASSIGNMENT: Record<Role, string> = {
  planner: 'the spec items',
  implementor: 'the spec items',
  verifier: 'the checks of step 1, which are required, and the wider probes you run, which are optional',
  worker: 'the task in your first message',
};

/**
 * A validity rule rejects records, and every rejection is a claim that no history reaches them, so each carries its
 * justification: `definition` (two definitions above exclude each other: `cites` names them) or `unreachable` (no
 * history item-histories.ts generates reaches it; the test checks that the valid records are exactly the reachable
 * ones). A rule only `unreachable` could justify, which a history does reach, is deleted and its records given a state.
 */
export type Justification = { readonly kind: 'definition'; readonly cites: string } | { readonly kind: 'unreachable'; readonly why: string };
export interface Validity {
  readonly rule: string;
  readonly justification: Justification;
  readonly breaks: (role: Role, item: Item) => boolean;
}
const hasResult = (item: Item) => item.attempt === 'pass' || item.attempt === 'fail' || item.attempt === 'unclear';
/** Whether any obstacle holds the item now. */
export const obstructed = (item: Item): boolean => item.refused || item.hostCannot || item.wait;
export const VALIDITY: ReadonlyArray<Validity> = [
  {
    rule: "a provenance belongs only to a verifier's finding outside its assignment, and every such finding has one",
    justification: { kind: 'definition', cites: '`provenance` (defined only for a verifier\'s finding outside its assignment) against `assigned` = true and the other roles' },
    breaks: (role, item) => (role === 'verifier' && !item.assigned) !== (item.provenance !== 'none'),
  },
  {
    rule: 'work outside the assignment is a finding, not work this role runs: it is never attempted, settled as found, meets no obstacle, and is neither required nor optional',
    justification: { kind: 'definition', cites: '`assigned` = false (not this role\'s work) against `attempt`, `settled` and the obstacles (this role\'s work on it) and `required` (the assignment\'s)' },
    breaks: (_, item) => !item.assigned && (item.attempt !== 'never' || !item.settled || obstructed(item) || item.required),
  },
  {
    rule: 'only a verifier has optional work (a wider probe); every item of a spec or task is required',
    justification: { kind: 'definition', cites: '`required`: every spec item and the task are required; `optional` is defined as a verifier\'s wider probe' },
    breaks: (role, item) => item.assigned && !item.required && role !== 'verifier',
  },
  {
    rule: 'a settled item is settled by a result: it has one',
    justification: { kind: 'definition', cites: '`settled` (its last result decides it) against `never` and `started` (no result)' },
    breaks: (_, item) => item.assigned && item.settled && !hasResult(item),
  },
  {
    rule: "a planner's, implementor's or worker's item is settled only by its acceptance holding; a failed or unclear attempt leaves it to advance or to an obstacle",
    justification: { kind: 'definition', cites: "`settled` for their work is acceptance holding (`pass`); `fail` and `unclear` are acceptance not holding" },
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
    justification: { kind: 'unreachable', why: 'every attempt of item-histories.ts that passes settles its item, and no event unsettles one' },
    breaks: (_, item) => item.attempt === 'pass' && !item.settled,
  },
  {
    rule: 'a settled item meets no obstacle: no further work on it is left for one to hold back',
    justification: { kind: 'unreachable', why: 'no obstacle event of item-histories.ts applies to a settled item' },
    breaks: (_, item) => item.settled && obstructed(item),
  },
];

/** The first validity rule an item breaks for this role, or undefined when some history produces it. */
export const validity = (role: Role, item: Item, rules: ReadonlyArray<Validity> = VALIDITY): string | undefined => rules.find((one) => one.breaks(role, item))?.rule;

/** Every state an item can be in, across roles; STATES_OF says which a role has. */
export const ALL_STATES = ['done', 'proven', 'runnable', 'waits', 'refused', 'cannot', 'unclear', 'unproven', 'discovery', 'unitFinding', 'baseFinding'] as const;
export type State = (typeof ALL_STATES)[number];

/** Every stop event, across roles; STOPS_OF says which a role has. */
export const ALL_STOPS = ['refusalForm', 'refusalNone', 'limit', 'idle'] as const;
export type Stop = (typeof ALL_STOPS)[number];

export const STATES_OF: Record<Role, ReadonlyArray<State>> = {
  planner: ['done', 'runnable', 'waits', 'refused', 'cannot', 'discovery'],
  implementor: ['done', 'runnable', 'waits', 'refused', 'cannot', 'discovery'],
  verifier: ['done', 'proven', 'runnable', 'waits', 'refused', 'cannot', 'unclear', 'unproven', 'unitFinding', 'baseFinding'],
  worker: ['done', 'runnable', 'waits', 'refused', 'cannot', 'discovery'],
};
export const STOPS_OF: Record<Role, ReadonlyArray<Stop>> = {
  planner: ['refusalForm', 'refusalNone', 'limit', 'idle'],
  implementor: ['refusalForm', 'refusalNone', 'limit', 'idle'],
  verifier: ['refusalForm', 'refusalNone', 'idle'],
  worker: ['refusalForm', 'refusalNone', 'idle'],
};

/** A predicate's one condition: a field with the value, or one of the values, it must have. */
export type Condition =
  | readonly ['assigned' | 'required' | 'settled' | Obstacle, boolean]
  | readonly ['attempt', ReadonlyArray<Attempt>]
  | readonly ['provenance', Provenance];
/**
 * Each state as a conjunction of conditions over the item, exclusive on every valid record. Where obstacles hold
 * together, the state is the first of refused, cannot run, waiting that holds: the order ORDER pins and the list
 * renders.
 */
export type Predicates = Record<State, ReadonlyArray<Condition>>;
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

export const meets = (item: Item, condition: Condition): boolean => {
  const [field, value] = condition;
  return field === 'attempt' ? (value as ReadonlyArray<Attempt>).includes(item.attempt) : item[field] === value;
};

/** Every state of the role whose predicate the item meets: exactly one for a valid item. */
export const matching = (role: Role, item: Item, predicates: Predicates = PREDICATE): State[] =>
  STATES_OF[role].filter((state) => predicates[state].every((condition) => meets(item, condition)));

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

/** Each state's name, as the tables and the verdict rules say it. */
export const STATE_NAME: Record<State, string> = {
  done: 'done',
  proven: 'proven',
  runnable: 'runnable',
  waits: 'waiting',
  refused: 'refused',
  cannot: 'cannot run',
  unclear: 'ran unclear',
  unproven: 'unproven',
  discovery: 'a discovery',
  unitFinding: 'a unit finding',
  baseFinding: 'a base finding',
};

// ---- F1: (state, attempt) → label ----------------------------------------------------------------------------------

const CONTINUES = "`continues next round`: this unit's work, in its next round (or its rewrite after the failure cap); never a follow-up";
const WAITS = '`waits on <id>`';
const REFUSED = "`refused: <what>`, adding `; form: <the form it named>` only when the refusal named one: this unit's work, never a follow-up, never tried another way";
const CANNOT = '`cannot run here: <check or tool>`, with its command and output';

/** A label, or a pair of them where the label itself differs by whether the item was attempted (a verifier's check). */
export type Label = string | null | { readonly never: string; readonly attempted: string };

/** F1. The label of each state, per role: null for `done`, which is no item left. */
export const LABEL: Record<Role, Partial<Record<State, Label>>> = {
  planner: {
    done: null,
    runnable: CONTINUES,
    waits: WAITS,
    refused: REFUSED,
    cannot: CANNOT,
    discovery: '`finding outside the unit`, under Follow-ups in your file',
  },
  implementor: {
    done: null,
    runnable: CONTINUES,
    waits: WAITS,
    refused: REFUSED,
    cannot: CANNOT,
    discovery: '`finding outside the unit`, in `state.md` under Follow-ups',
  },
  verifier: {
    done: null,
    proven: 'a Blocker or Major, filed with its proof',
    runnable: { never: '`not run`, named under Check', attempted: '`retry: <check>`, named under Check; it continues to a result' },
    waits: WAITS,
    refused: REFUSED.replace("this unit's work, never a follow-up, ", ''),
    cannot: CANNOT,
    unclear: '`ran unclear: <check>`, with its command and the output that settles nothing',
    unproven: '`unproven: <probe>`, under Unproven with the probe that would settle it; it never changes the verdict',
    unitFinding: 'marked `unit`: the same lane closes it in its next round',
    baseFinding: 'marked `base`: a follow-up unit',
  },
  worker: {
    done: null,
    runnable: '`left`, named in your result',
    waits: WAITS,
    refused: '`refused: <what>`, adding `; form: <the form it named>` only when the refusal named one: never tried another way',
    cannot: CANNOT,
    discovery: '`outside the task`, named in your result',
  },
};

/** F1 as a function: the one label of an item in `state` with that attempt history; it takes no stop. */
export function label(role: Role, state: State, attempt: Attempt = 'never', labels: typeof LABEL = LABEL): string | null {
  if (!STATES_OF[role].includes(state)) throw new Error(`${role} has no state ${state}`);
  const found = labels[role][state];
  if (found === undefined) throw new Error(`no label for ${role} × ${state}`);
  if (found === null || typeof found === 'string') return found;
  return attempt === 'never' ? found.never : found.attempted;
}

/** The attempt history, as its own instruction beside the list: it adds evidence and never picks a row. */
export const ATTEMPT_NOTE =
  "Whatever the row, if the item was attempted, also give what its last attempt printed, with its command: an earlier result stays as evidence and never stands in for the row's own.";

// ---- the list the prompt carries: F1 as ordered rows, in one grammar -------------------------------------------------

/** The atoms a row's condition is written in. */
export const ATOM_IDS = ['assigned', 'notAssigned', 'required', 'optional', 'refused', 'hostCannot', 'wait', 'pass', 'fail', 'unclear', 'noRetry', 'attempted', 'advance', 'unit', 'base'] as const;
export type Atom = (typeof ATOM_IDS)[number];

/** How each atom reads in a role's prompt: the one vocabulary both `condition` and `parseCondition` use. */
export function atomWords(role: Role, atom: Atom): string {
  const words: Record<Atom, string> = {
    assigned: 'assigned',
    notAssigned: 'not assigned',
    required: 'required',
    optional: 'optional (a wider probe)',
    refused: 'a refusal stopped it',
    hostCannot: 'this host cannot run it (its check or tool is absent or will not start)',
    wait: 'waits on an open unit, question, commitment or two contradicting spec lines',
    pass: role === 'verifier' ? 'ran and passed' : 'its acceptance holds',
    fail: 'ran and proves a Blocker or Major',
    unclear: 'ran, with a result that settles neither pass nor fail',
    noRetry: 'no retry can settle it here',
    attempted: 'attempted (it ran at least once)',
    advance: role === 'worker' ? 'can still advance' : 'can still advance in this lane',
    unit: "the unit's change introduced it, shown by measured attribution (whether or not a spec item names it)",
    base: 'shown on the base head too',
  };
  return words[atom];
}

/**
 * What a reader can take each atom to say of an item: true wherever its words could be read as true, not only where
 * the model's field has that value. "no retry can settle it here" is true of a refused, unrunnable or waiting item as
 * much as of a settled one, and "can still advance" of anything not settled. The list is checked under these
 * readings, so an overlap a reader could see is an overlap the test sees.
 */
export const READS: Record<Atom, (item: Item) => boolean> = {
  assigned: (item) => item.assigned,
  notAssigned: (item) => !item.assigned,
  required: (item) => item.assigned && item.required,
  optional: (item) => item.assigned && !item.required,
  refused: (item) => item.refused,
  hostCannot: (item) => item.hostCannot,
  wait: (item) => item.wait,
  pass: (item) => item.attempt === 'pass',
  fail: (item) => item.attempt === 'fail',
  unclear: (item) => item.attempt === 'unclear',
  noRetry: (item) => item.settled || obstructed(item),
  attempted: (item) => item.attempt !== 'never',
  advance: (item) => !item.settled,
  unit: (item) => item.provenance === 'unit',
  base: (item) => item.provenance === 'base',
};

/** A row's condition: every atom true of the item, or the catch-all. */
export type When = ReadonlyArray<Atom> | 'otherwise';
export const OTHERWISE = 'otherwise';
/** A condition in words: its atoms joined by ", ", or "otherwise". */
export const condition = (role: Role, when: When): string => (when === 'otherwise' ? OTHERWISE : when.map((atom) => atomWords(role, atom)).join(', '));
/** A condition read back from its words, or an error naming what does not parse: the grammar `condition` writes. */
export function parseCondition(role: Role, text: string): When {
  if (text === OTHERWISE) return 'otherwise';
  const vocabulary = ATOM_IDS.map((atom) => [atom, atomWords(role, atom)] as const).sort((a, b) => b[1].length - a[1].length);
  const out: Atom[] = [];
  let rest = text;
  while (rest.length > 0) {
    const found = vocabulary.find(([, words]) => rest.startsWith(words) && (rest.length === words.length || rest.startsWith(', ', words.length)));
    if (found === undefined) throw new Error(`${role}: no atom reads "${rest}"`);
    out.push(found[0]);
    rest = rest.slice(found[1].length).replace(/^, /, '');
  }
  return out;
}
/** Whether a condition is true of an item, read generously (READS). */
export const holds = (when: When, item: Item): boolean => when === 'otherwise' || when.every((atom) => READS[atom](item));

/** One row of the list: the state it gives and its condition; its label is F1's for that state (see `rowLabel`). */
export interface Decision {
  readonly id: string;
  readonly state: State;
  readonly when: When;
}
const FINDINGS: ReadonlyArray<Decision> = [{ id: 'discovery', state: 'discovery', when: ['notAssigned'] }];
/**
 * The obstacle rows. A refusal is authority, whatever the item: the Refusals paragraph stops the step on it and has
 * its form reported, so its row needs no `required` and an optional probe that was refused is `refused`, never a
 * quiet `unproven`. A missing tool or a wait on an optional probe does not stop the step: the probe stays
 * `unproven`, and OTHER_OBSTACLES_NOTE has the hand-back name what held it.
 */
const OBSTACLES = (required: ReadonlyArray<Atom>): ReadonlyArray<Decision> => [
  { id: 'refused', state: 'refused', when: ['refused'] },
  { id: 'cannot', state: 'cannot', when: [...required, 'hostCannot'] },
  { id: 'waits', state: 'waits', when: [...required, 'wait'] },
];
const SPEC_WORK: ReadonlyArray<Decision> = [...FINDINGS, ...OBSTACLES([]), { id: 'done', state: 'done', when: ['pass'] }, { id: 'runnable', state: 'runnable', when: 'otherwise' }];

/**
 * F1 as the prompt carries it: rows in order, the first true of an item giving its state and label. The order is
 * what governs now: first whether the item is this role's work at all (a finding is outside it, whatever else holds);
 * then the current obstacle, refusal before host before wait; then a terminal result; then work that can be retried;
 * last, the catch-all, work never attempted. ORDER gives each overlap this order resolves, and why.
 */
export const DECISIONS: Record<Role, ReadonlyArray<Decision>> = {
  planner: SPEC_WORK,
  implementor: SPEC_WORK,
  verifier: [
    { id: 'unitFinding', state: 'unitFinding', when: ['notAssigned', 'unit'] },
    { id: 'baseFinding', state: 'baseFinding', when: ['notAssigned', 'base'] },
    ...OBSTACLES(['required']),
    { id: 'proven', state: 'proven', when: ['fail'] },
    { id: 'done', state: 'done', when: ['pass'] },
    { id: 'unclear', state: 'unclear', when: ['required', 'unclear', 'noRetry'] },
    { id: 'unproven', state: 'unproven', when: ['optional'] },
    { id: 'retry', state: 'runnable', when: ['required', 'attempted', 'advance'] },
    { id: 'notRun', state: 'runnable', when: 'otherwise' },
  ],
  worker: SPEC_WORK,
};

/** A row's label: F1's for its state; where F1 has a pair, the row that asks `attempted` takes the attempted one. */
export function rowLabel(role: Role, row: Decision, labels: typeof LABEL = LABEL): string {
  const found = labels[role][row.state];
  if (found === undefined) throw new Error(`no label for ${role} × ${row.state}`);
  if (found === null) return 'none: it is no item left';
  if (typeof found === 'string') return found;
  return row.when !== 'otherwise' && row.when.includes('attempted') ? found.attempted : found.never;
}

/** The first row of a list true of an item. */
export const decide = (rows: ReadonlyArray<Decision>, item: Item): Decision | undefined => rows.find((row) => holds(row.when, item));

/**
 * The pinned winner of every pair of rows that can both be true of one reachable record (READS), whatever their
 * places, with the evidence that must survive. The pairs are not written from a list of cases: the test computes
 * them from every reachable record of item-histories.ts, two or three obstacles at once included, and fails on a
 * computed pair with no entry here, on an entry no record produces, and on a list whose order disagrees with a
 * winner. The catch-all is true of every item and stands last, so it is in no pair.
 */
export interface Pinned {
  readonly pair: readonly [string, string];
  readonly winner: string;
  readonly why: string;
}
const OBSTACLE_PAIRS: ReadonlyArray<Pinned> = [
  { pair: ['refused', 'cannot'], winner: 'refused', why: 'the refusal form must survive: only it lets the orchestrator act; the missing tool is named after it (OTHER_OBSTACLES_NOTE)' },
  { pair: ['refused', 'waits'], winner: 'refused', why: 'the refusal form must survive: the wait closes by itself, the refusal never does; the wait is named after it' },
  { pair: ['cannot', 'waits'], winner: 'cannot', why: "the missing tool and its probe must survive: no retry here changes the host, while the wait's id is already recorded; the wait is named after it" },
];
export const ORDER: Record<Role, ReadonlyArray<Pinned>> = {
  planner: OBSTACLE_PAIRS,
  implementor: OBSTACLE_PAIRS,
  worker: OBSTACLE_PAIRS,
  verifier: [
    ...OBSTACLE_PAIRS,
    { pair: ['refused', 'unclear'], winner: 'refused', why: 'the refusal form must survive; the unclear output stays as attempt evidence' },
    { pair: ['cannot', 'unclear'], winner: 'cannot', why: 'the missing tool and its probe must survive; the unclear output stays as attempt evidence' },
    { pair: ['waits', 'unclear'], winner: 'waits', why: "the wait's id must survive: it is how the check reopens; the unclear output stays as attempt evidence" },
    { pair: ['refused', 'retry'], winner: 'refused', why: 'the refusal form must survive: a retry it stops will not run; what the attempt printed stays as its evidence' },
    { pair: ['cannot', 'retry'], winner: 'cannot', why: 'the missing tool and its probe must survive: a retry here would not start' },
    { pair: ['waits', 'retry'], winner: 'waits', why: "the wait's id must survive: the retry runs only once it closes" },
    { pair: ['unclear', 'retry'], winner: 'unclear', why: 'both hold only under an obstacle, which governs them both; between the two, the output that settles nothing survives as ran unclear' },
    { pair: ['proven', 'unproven'], winner: 'proven', why: 'the proof must survive: an optional probe that proves a Blocker or Major is filed as one' },
    { pair: ['refused', 'unproven'], winner: 'refused', why: 'the refusal form must survive: a refusal stops the step whatever the item (the Refusals paragraph), so a refused optional probe is reported as refused, never left a quiet unproven' },
    { pair: ['done', 'unproven'], winner: 'done', why: 'an optional probe that passed leaves nothing to prove; its command and output survive as attempt evidence' },
  ],
};

/** The obstacle rows, whose evidence a hand-back gives for the governing one and names for every other that holds. */
export const OBSTACLE_ROWS = ['refused', 'cannot', 'waits'] as const;
export type ObstacleRow = (typeof OBSTACLE_ROWS)[number];
/** Each obstacle's evidence: what a hand-back must hold for it, whether it governs or is named after the label. */
export const OBSTACLE_EVIDENCE: Record<ObstacleRow, string> = {
  refused: 'what was refused, as the refusal said it, and the form it named if any',
  cannot: 'the check or tool, with the probe that found it absent: its command and output',
  waits: 'the id it waits on',
};
const listOf = (items: ReadonlyArray<string>) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);
/**
 * The second instruction beside the list: every obstacle holding the item that its label does not give is named,
 * required or optional, never lost behind the label (batch 23b); an unproven probe so says why it did not run, which
 * the probe that would settle it needs.
 */
export const OTHER_OBSTACLES_NOTE = `Also name each obstacle of ${listOf(OBSTACLE_ROWS.map((row) => STATE_NAME[row]))} that holds the item, required or optional, and is not the one its label gives, after the label's evidence, with its own evidence (${OBSTACLE_ROWS.map((row) => `${STATE_NAME[row]}: ${OBSTACLE_EVIDENCE[row]}`).join('; ')}), so lifting one obstacle does not leave the item stopped by another and an unproven probe says what kept it from running.`;
/** The obstacle rows the rendered instruction names, read back from its words. */
export function parseOtherObstacles(text: string): ObstacleRow[] {
  const found = /Also name each obstacle of (.+?) that holds the item, required or optional, and is not the one its label gives, after the label's evidence/.exec(text);
  if (found === null) throw new Error("the other obstacles' instruction is missing");
  const byName = new Map(OBSTACLE_ROWS.map((row) => [STATE_NAME[row], row] as const));
  return (found[1] ?? '').split(/, | or /).map((name) => {
    const row = byName.get(name);
    if (row === undefined) throw new Error(`no obstacle row is named "${name}"`);
    return row;
  });
}

/**
 * What a hand-back must hold for one item, field by field: its label (the first true row's), the governing
 * obstacle's evidence, every other obstacle that holds with its own evidence, and whether what its last attempt
 * printed (command and output) is due: exactly when it was attempted, a passing attempt and a probe displaced by an
 * obstacle included.
 */
export interface HandBack {
  readonly state: State;
  readonly label: string;
  readonly evidence: ObstacleRow | null;
  readonly others: ReadonlyArray<ObstacleRow>;
  readonly lastAttempt: boolean;
}

// ---- F2: (stop, states) → verdict and files ----------------------------------------------------------------------

/** The verdict rules, first that holds: `any` of these states present, or `only` these states present, or `else`. */
export type Rule = { readonly verdict: string } & ({ readonly any: ReadonlyArray<State> } | { readonly only: ReadonlyArray<State> } | { readonly else: true });
export const VERDICT: Record<Role, ReadonlyArray<Rule>> = {
  planner: [{ verdict: 'ready', only: ['done', 'discovery'] }, { verdict: 'blocked', else: true }],
  implementor: [{ verdict: 'ready', only: ['done', 'discovery'] }, { verdict: 'blocked', else: true }],
  verifier: [
    { verdict: 'stuck', any: ['runnable', 'waits', 'refused', 'cannot', 'unclear'] },
    { verdict: 'changes', any: ['proven'] },
    { verdict: 'accepted', else: true },
  ],
  worker: [{ verdict: 'none', else: true }],
};

/** Every pair of verdict rules both true of some well-formed step, the earlier governing, with why (the catch-all is in none). */
export const VERDICT_ORDER: Record<Role, ReadonlyArray<{ readonly earlier: string; readonly later: string; readonly why: string }>> = {
  planner: [],
  implementor: [],
  verifier: [
    {
      earlier: 'stuck',
      later: 'changes',
      why: 'a proven Blocker and a required check with no result: the verdict waits for every required check, and the proof is still filed under its own label',
    },
  ],
  worker: [],
};

/** What a stop event's evidence is, written where the role's files say; a role may say it its own way. */
const EVIDENCE: Record<Stop, string> = {
  refusalForm: 'what was refused and the form it named (the exact `!` command or allow rule, as Refusals says)',
  refusalNone: 'what was refused, as the refusal said it, and an allow rule only if one exists',
  limit: 'the clock (the timebox) or the count (the failure cap)',
  idle: 'what you tried for each item that holds the step back, the options and your pick',
};
const EVIDENCE_OF: Record<Role, Partial<Record<Stop, string>>> = {
  planner: {},
  implementor: {},
  verifier: { idle: 'each check that holds the verdict back, with its command and exit code' },
  worker: { refusalForm: 'what was refused and the form it named', refusalNone: 'what was refused, as the refusal said it', idle: 'what holds back each item left' },
};
export const evidence = (role: Role, stop: Stop): string => EVIDENCE_OF[role][stop] ?? EVIDENCE[stop];

export const STOP_TEXT: Record<Stop, string> = {
  refusalForm: 'a refusal named an accepted form',
  refusalNone: 'a refusal named no accepted form',
  limit: "the round's limit passed",
  idle: 'no runnable item is left',
};

/** The files each verdict writes: `<evidence>` is the stop event's, `<items>` each item left with its label. */
export const FILES: Record<Role, Record<string, string>> = {
  planner: {
    ready: '`<unit dir>/spec.md`',
    blocked: '`<unit dir>/state.md` current (even with no commit since) and `<unit dir>/blocked.md`: <evidence>, and <items>',
  },
  implementor: {
    ready: '`<unit dir>/round-N-request.md`, committed, once `request.ts` exits 0',
    blocked: '`<unit dir>/state.md` current (even with no commit since) and `<unit dir>/blocked.md`: <evidence>, and <items>',
  },
  verifier: {
    stuck: "each unit's `round-N-findings.md` and the batch's findings file; under Check, <evidence>, and <items>",
    changes: "each unit's `round-N-findings.md` and the batch's findings file; under Check, <evidence>, and <items>",
    accepted: "each unit's `round-N-findings.md` and the batch's findings file; under Check, <evidence>, and <items>",
  },
  worker: { none: 'your result as text, with <evidence> and <items>' },
};

/** The files a verdict writes after `stop`, as the role's prompt says them. */
export function written(role: Role, stop: Stop, verdict: string, from: typeof FILES = FILES): string {
  const files = from[role][verdict];
  if (files === undefined) throw new Error(`no files for ${role} ${verdict}`);
  return files.replace('<evidence>', evidence(role, stop)).replace('<items>', 'each item left with its label');
}

export type Outcome = { readonly verdict: string; readonly files: string };
export type Classified = { readonly outcome: Outcome } | { readonly illFormed: string };

/** Why an input is no step's end, or undefined when it is one. */
export function illFormed(role: Role, stop: Stop, states: ReadonlyArray<State>): string | undefined {
  if (!STOPS_OF[role].includes(stop)) return `a ${role} has no ${stop} stop`;
  const foreign = states.find((state) => !STATES_OF[role].includes(state));
  if (foreign !== undefined) return `a ${role} has no ${foreign} state`;
  const refused = states.filter((state) => state === 'refused').length;
  const refusal = stop === 'refusalForm' || stop === 'refusalNone';
  if (refusal && refused > 1) return 'a refusal stops the step at the one item it refused';
  if (refusal && refused === 0) return 'a refusal stops the step at the one item it refused (a refused optional probe is refused too)';
  if (!refusal && refused > 0) return 'a refusal stops the step at once, so a refused item means the step stopped on it';
  if (stop === 'idle' && states.includes('runnable')) return 'the step goes on while a runnable item is left';
  if (stop === 'limit' && !states.includes('runnable')) return 'with no runnable item left the step had already stopped, before the limit passed';
  return undefined;
}

/** F2. The verdict and files of a step that stopped on `stop` with items in `states`; ill-formed input is refused. */
export function classify(role: Role, stop: Stop, states: ReadonlyArray<State>, rules: typeof VERDICT = VERDICT, files: typeof FILES = FILES): Classified {
  const bad = illFormed(role, stop, states);
  if (bad !== undefined) return { illFormed: bad };
  const rule = rules[role].find((one) =>
    'any' in one ? one.any.some((state) => states.includes(state)) : 'only' in one ? states.every((state) => one.only.includes(state)) : true,
  );
  if (rule === undefined) throw new Error(`no verdict rule holds for ${role}`);
  return { outcome: { verdict: rule.verdict, files: written(role, stop, rule.verdict, files) } };
}

/** Each role's required work: `done` on every required item means all of it. */
export const REQUIRED: Record<Role, string> = {
  planner:
    'Your required work: every section of the spec filled, and its acceptance check runnable and recorded red. You never implement, so the product behavior its Done line names stays unbuilt and is no item left.',
  implementor: 'Your required work: every item of the spec, built, gated and requested.',
  verifier:
    'Your required work: every check of step 1 ran to a result that settles pass or fail, for every unit; a check of step 1 that could not run or ran unclear is `stuck`, never `accepted`, and a wider probe this host cannot run goes under Unproven and does not stop `accepted`. Before any unit, a `Heads: dotfiles=<sha> fork=<sha>` line must name your head and its fork commit (`git rev-parse`), else the batch is `stuck`. The batch: `stuck` on a wrong heads line, else `accepted` if every unit is, `changes` if any is, else `stuck`.',
  worker: 'Your required work: the task in your first message.',
};

/** A batch's verdict from its heads line and its units' verdicts, as REQUIRED.verifier says it. */
export function batchVerdict(headsMatch: boolean, units: ReadonlyArray<'accepted' | 'changes' | 'stuck'>): 'accepted' | 'changes' | 'stuck' {
  if (!headsMatch) return 'stuck';
  if (units.every((unit) => unit === 'accepted')) return 'accepted';
  if (units.some((unit) => unit === 'changes')) return 'changes';
  return 'stuck';
}

// ---- rendering -----------------------------------------------------------------------------------------------------

export const BEGIN = '<!-- end-of-step: generated by skills/orchestrate/scripts/ending.ts from its two functions; edit that, then run agents.ts -->';
export const END = '<!-- /end-of-step -->';
/** A rendered block, wherever it stands in a file. */
export const BLOCK = /<!-- end-of-step: [^\n]*-->[\s\S]*?<!-- \/end-of-step -->/;

const list = (items: ReadonlyArray<string>) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);
const word = (verdict: string) => (verdict === 'none' ? 'no verdict word' : `\`${verdict}\``);

/** A verdict rule's condition, in the states' names. */
export function when(rule: Rule): string {
  if ('any' in rule) return `any item is ${list(rule.any.map((state) => STATE_NAME[state]))}`;
  if ('only' in rule) return `every item is ${list(rule.only.map((state) => STATE_NAME[state]))}`;
  return 'otherwise';
}

/** A verdict rule's condition read back from its words (the grammar `when` writes), or an error naming what does not parse. */
export function parseWhen(text: string): { readonly any: ReadonlyArray<State> } | { readonly only: ReadonlyArray<State> } | { readonly else: true } {
  if (text === 'otherwise' || text === 'always') return { else: true };
  const byName = new Map(ALL_STATES.map((state) => [STATE_NAME[state], state] as const));
  const names = (rest: string): State[] =>
    rest.split(/, | or /).map((name) => {
      const state = byName.get(name);
      if (state === undefined) throw new Error(`no state is named "${name}"`);
      return state;
    });
  if (text.startsWith('any item is ')) return { any: names(text.slice('any item is '.length)) };
  if (text.startsWith('every item is ')) return { only: names(text.slice('every item is '.length)) };
  throw new Error(`no verdict condition reads "${text}"`);
}

/** The sentence above each table: its rows are tried in order and the first true one decides. */
export const FIRST_ROW = 'Take the first row that is true of the item; stop there.';
export const FIRST_VERDICT = 'Take the first row that holds for the step; stop there.';
export const F1_HEADER = '| State | An item that is | Its label |';
export const F2_HEADER = '| Verdict, the first that holds | When | You write |';

/** One role's two tables, as its prompt carries them: F1 as its ordered list `rows`, F2 as its ordered rules. */
export function render(role: Role, rows: ReadonlyArray<Decision> = DECISIONS[role]): string {
  const limit = STOPS_OF[role].includes('limit');
  const intro = [
    `**How your step ends.** It stops the moment a refusal comes${role === 'worker' ? '' : ' (the Refusals paragraph)'}${limit ? " or the round's limit passes" : ''}; else it goes on until no runnable item is left.`,
    "Each item takes one row of the first table, and that row alone gives its state and its label, whatever stopped the step; the last row takes every item no row above it took.",
    ATTEMPT_NOTE,
    OTHER_OBSTACLES_NOTE,
    `The states present give your verdict and its files (second table${role === 'verifier' ? '; an optional probe is only ever done, proven, refused or unproven, and unproven never changes it' : ''}), and why the step stopped gives the evidence they hold. Effort is no state and no label.`,
    `Assigned work is ${ASSIGNMENT[role]}; whatever else you find is not assigned.`,
    REQUIRED[role],
  ].join(' ');
  const f1 = [F1_HEADER, '| --- | --- | --- |', ...rows.map((row) => `| ${STATE_NAME[row.state]} | ${condition(role, row.when)} | ${rowLabel(role, row)} |`)];
  const f2 = [
    F2_HEADER,
    '| --- | --- | --- |',
    ...VERDICT[role].map((rule) => `| ${word(rule.verdict)} | ${VERDICT[role].length === 1 ? 'always' : when(rule)} | ${FILES[role][rule.verdict]!.replace('<evidence>', "the stop's evidence").replace('<items>', 'each item left with its label')} |`),
  ];
  const stops = STOPS_OF[role].map((stop) => `${STOP_TEXT[stop]}: ${evidence(role, stop)}`);
  return [BEGIN, intro, '', FIRST_ROW, '', ...f1, '', FIRST_VERDICT, '', ...f2, '', `The stop's evidence: ${stops.join('; ')}.`, END].join('\n');
}

/** A row of a rendered table, as its cells. */
const cells = (line: string) => line.split('|').slice(1, -1).map((cell) => cell.trim());
/** The rows under `header` in a rendered prompt, failing unless `sentence` stands as the paragraph just above it. */
function tableAt(text: string, header: string, sentence: string): string[][] {
  const lines = text.split('\n');
  const at = lines.indexOf(header);
  if (at < 0) throw new Error(`no table headed ${header}`);
  if (lines[at - 1] !== '' || lines[at - 2] !== sentence || lines[at - 3] !== '') throw new Error(`the table headed ${header} is not under "${sentence}"`);
  const body = lines.slice(at + 2);
  const end = body.findIndex((line) => !line.startsWith('|'));
  return body.slice(0, end < 0 ? body.length : end).map(cells);
}

/** A prompt's first table read back: each row's state, its condition parsed by the grammar, and its label words. */
export function readDecisions(role: Role, text: string): Array<{ readonly state: State; readonly when: When; readonly label: string }> {
  if (!text.includes(ATTEMPT_NOTE)) throw new Error(`${role}: the attempt history's instruction is missing`);
  parseOtherObstacles(text);
  const byName = new Map(STATES_OF[role].map((state) => [STATE_NAME[state], state] as const));
  const rows = tableAt(text, F1_HEADER, FIRST_ROW).map(([name = '', words = '', labelWords = '']) => {
    const state = byName.get(name);
    if (state === undefined) throw new Error(`${role}: no state is named "${name}"`);
    return { state, when: parseCondition(role, words), label: labelWords };
  });
  const catchAll = rows.findIndex((row) => row.when === 'otherwise');
  if (catchAll !== rows.length - 1) throw new Error(`${role}: the catch-all is not the last row`);
  return rows;
}

/** Every atom a reader can take as true of an item holding every record given (two records: two facts at once). */
export const truths = (records: ReadonlyArray<Item>): Set<Atom> => new Set(ATOM_IDS.filter((atom) => records.some((one) => READS[atom](one))));

/**
 * The hand-back a prompt asks for an item with these atoms, derived from the prompt's own words: the first true row
 * of its list (state, label), the obstacle rows its second instruction names (the governing one's evidence, every
 * other that holds named, on an optional probe too), and its attempt instruction (what the last attempt printed, exactly when attempted).
 */
export function handBackFrom(role: Role, text: string, atoms: ReadonlySet<Atom>): HandBack {
  const rows = readDecisions(role, text);
  const named = parseOtherObstacles(text);
  const isTrue = (row: (typeof rows)[number]) => row.when === 'otherwise' || row.when.every((atom) => atoms.has(atom));
  const first = rows.find(isTrue);
  if (first === undefined) throw new Error(`${role}: no row is true`);
  const obstacle = (state: State): ObstacleRow | undefined => named.find((row) => row === state);
  const governing = obstacle(first.state) ?? null;
  // An obstacle holds the item, required or optional, when its row's condition holds with the assignment's words set
  // aside: the instruction names it whatever the item's assignment.
  const holdsWhatever = (row: (typeof rows)[number]) => row.when === 'otherwise' || row.when.every((atom) => atom === 'required' || atom === 'optional' || atoms.has(atom));
  const others = named.filter((row) => row !== governing && rows.some((one) => one.state === row && holdsWhatever(one)));
  return { state: first.state, label: first.label, evidence: governing, others, lastAttempt: atoms.has('attempted') };
}

// The hand-back judge (the decoder of a hand-back and its comparison with the one due) is opencode/mods/orchestrate/hand-back.ts:
// it needs Effect Schema, and this file stays import-free (agents.test.ts copies it alone into a fixture).

/** A prompt's second table read back: each verdict with its parsed condition. */
export function readVerdicts(text: string): Array<{ readonly verdict: string; readonly rule: ReturnType<typeof parseWhen> }> {
  return tableAt(text, F2_HEADER, FIRST_VERDICT).map(([verdict = '', words = '']) => ({ verdict: verdict === 'no verdict word' ? 'none' : verdict.replaceAll('`', ''), rule: parseWhen(words) }));
}

/** Every multiset of the role's states up to `size` items. */
export function multisets(states: ReadonlyArray<State>, size: number): State[][] {
  const out: State[][] = [[]];
  const grow = (prefix: State[], from: number) => {
    if (prefix.length === size) return;
    for (let index = from; index < states.length; index++) {
      const next = [...prefix, states[index]!];
      out.push(next);
      grow(next, index);
    }
  };
  grow([], 0);
  return out;
}

/** protocol.md's block: where each role's tables go, and where all of them are. */
export const PROTOCOL_BLOCK = [
  BEGIN,
  "How a step ends is two functions: an item's own state gives its label, and the item states present give the verdict and its files, with the evidence of why the step stopped: [`end-of-step.md`](end-of-step.md). Each role's prompt carries its own two tables here.",
  END,
].join('\n');

/** Every role's tables, as end-of-step.md holds them. */
export function document(): string {
  const parts = [
    '# How a step ends',
    '',
    "Generated by `scripts/ending.ts` from its two functions: edit that, then run `scripts/agents.ts`. F1 gives each item's label from its own state; F2 gives the verdict and its files from the item states present, and the evidence from why the step stopped. Each role's prompt carries its own tables, as below.",
  ];
  for (const role of ROLES) parts.push('', `## ${role}`, '', render(role).split('\n').slice(1, -1).join('\n'));
  return `${parts.join('\n')}\n`;
}
