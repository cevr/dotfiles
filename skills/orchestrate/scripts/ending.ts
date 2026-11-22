// How a step ends, as two independent total functions (batch 22t: "the stopping event and each outstanding
// item's status are distinct facts"):
//   F1  label(role, state)          each item of the work is in exactly one state, decided by its own history, and
//                                   that state alone gives its label, whatever stopped the step;
//   F2  outcome(role, stop, states) the stop event and the multiset of item states give the verdict word, by a stated
//                                   precedence over the states present, and the files written.
// An input no step can produce (a refusal that refused nothing, a runnable item when nothing runnable is left, a limit
// with no runnable item, a state or stop the role does not have) is rejected as ill-formed by `classify`, never answered.
// agents.ts renders a role's two tables into its prompt between BEGIN and END, every role's into end-of-step.md.
// Edit here, then run agents.ts (and opencode's `bun run agents`).

export const ROLES = ['planner', 'implementor', 'verifier', 'worker'] as const;
export type Role = (typeof ROLES)[number];

/** Every state an item can be in, across roles; STATES_OF says which a role has. */
export const ALL_STATES = ['done', 'proven', 'runnable', 'waits', 'refused', 'cannot', 'unclear', 'discovery', 'unitFinding', 'baseFinding'] as const;
export type State = (typeof ALL_STATES)[number];

/** Every stop event, across roles; STOPS_OF says which a role has. */
export const ALL_STOPS = ['refusalForm', 'refusalNone', 'limit', 'idle'] as const;
export type Stop = (typeof ALL_STOPS)[number];

export const STATES_OF: Record<Role, ReadonlyArray<State>> = {
  planner: ['done', 'runnable', 'waits', 'refused', 'cannot', 'discovery'],
  implementor: ['done', 'runnable', 'waits', 'refused', 'cannot', 'discovery'],
  verifier: ['done', 'proven', 'runnable', 'waits', 'refused', 'cannot', 'unclear', 'unitFinding', 'baseFinding'],
  worker: ['done', 'runnable', 'waits', 'refused', 'cannot', 'discovery'],
};
export const STOPS_OF: Record<Role, ReadonlyArray<Stop>> = {
  planner: ['refusalForm', 'refusalNone', 'limit', 'idle'],
  implementor: ['refusalForm', 'refusalNone', 'limit', 'idle'],
  verifier: ['refusalForm', 'refusalNone', 'idle'],
  worker: ['refusalForm', 'refusalNone', 'idle'],
};
/** The states that are not work the role was given: they never hold a step back. */
export const OUTSIDE: ReadonlyArray<State> = ['discovery', 'unitFinding', 'baseFinding'];

/** Each state's name, as the tables and the verdict line say it. */
export const STATE_NAME: Record<State, string> = {
  done: 'done',
  proven: 'proven',
  runnable: 'runnable',
  waits: 'waiting',
  refused: 'refused',
  cannot: 'cannot run',
  unclear: 'ran unclear',
  discovery: 'a discovery',
  unitFinding: 'a unit finding',
  baseFinding: 'a base finding',
};

/** What each state means, as a reader decides it from the item's own history. */
export const STATE_TEXT: Record<State, string> = {
  done: 'done; for a check, ran and passed',
  proven: 'a check that ran and proves a Blocker or Major',
  runnable: 'runnable, not yet run',
  waits: 'waiting on an open unit, question, commitment or two contradicting spec lines',
  refused: 'the item the refusal stopped',
  cannot: 'unable to run on this host: its check or tool is absent or will not start, with no refusal',
  unclear: 'a required check that ran, but whose result cannot establish pass or fail',
  discovery: 'work no spec item asks for',
  unitFinding: "a weak test, narrowed acceptance or written-rule break with no failing run that the unit's change introduced, shown by measured attribution (whether or not a spec item names it)",
  baseFinding: 'such a finding the base head shows too',
};

// ---- F1: state → label ---------------------------------------------------------------------------------------------

const CONTINUES = "`continues next round`: this unit's work, in its next round (or its rewrite after the failure cap); never a follow-up";
const WAITS = '`waits on <id>`';
const REFUSED = "`refused: <what>`, adding `; form: <the form it named>` only when the refusal named one: this unit's work, never a follow-up, never tried another way";
const CANNOT = '`cannot run here: <check or tool>`, with its command and output';

/** F1. The label of each state, per role: null for `done`, which is no item left. */
export const LABEL: Record<Role, Partial<Record<State, string | null>>> = {
  planner: { done: null, runnable: CONTINUES, waits: WAITS, refused: REFUSED, cannot: CANNOT, discovery: '`finding outside the unit`, under Follow-ups in your file' },
  implementor: { done: null, runnable: CONTINUES, waits: WAITS, refused: REFUSED, cannot: CANNOT, discovery: '`finding outside the unit`, in `state.md` under Follow-ups' },
  verifier: {
    done: null,
    proven: 'a Blocker or Major, filed with its proof',
    runnable: '`not run`, named under Check',
    waits: WAITS,
    refused: REFUSED.replace("this unit's work, never a follow-up, ", ''),
    cannot: CANNOT,
    unclear: '`ran unclear: <check>`, with its command and the output that settles nothing',
    unitFinding: "marked `unit`: the same lane closes it in its next round",
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

/** F1 as a function: the one label of an item in `state`; throws for a state the role does not have. */
export function label(role: Role, state: State, labels: typeof LABEL = LABEL): string | null {
  if (!STATES_OF[role].includes(state)) throw new Error(`${role} has no state ${state}`);
  const found = labels[role][state];
  if (found === undefined) throw new Error(`no label for ${role} × ${state}`);
  return found;
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
    changes: "each unit's `round-N-findings.md` and the batch's findings file, with <items>",
    accepted: "each unit's `round-N-findings.md` and the batch's findings file, with <items>",
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
  if (refusal && refused !== 1) return 'a refusal stops the step at the one item it refused';
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

/** One role's two tables, as its prompt carries them. */
export function render(role: Role): string {
  const limit = STOPS_OF[role].includes('limit');
  const intro = [
    `**How your step ends.** It stops the moment a refusal comes${role === 'worker' ? '' : ' (the Refusals paragraph)'}${limit ? " or the round's limit passes" : ''}; else it goes on until no runnable item is left.`,
    'Each item is in one state, decided by its own history, and that state alone gives its label, whatever stopped the step (first table).',
    'The states present give your verdict and its files (second table), and why the step stopped gives the evidence they hold. Effort is no state and no label.',
    REQUIRED[role],
  ].join(' ');
  const f1 = [
    '| State | An item that is | Its label |',
    '| --- | --- | --- |',
    ...STATES_OF[role].map((state) => `| ${STATE_NAME[state]} | ${STATE_TEXT[state]} | ${label(role, state) ?? 'none: it is no item left'} |`),
  ];
  const f2 = [
    '| Verdict, the first that holds | When | You write |',
    '| --- | --- | --- |',
    ...VERDICT[role].map((rule) => `| ${word(rule.verdict)} | ${VERDICT[role].length === 1 ? 'always' : when(rule)} | ${FILES[role][rule.verdict]!.replace('<evidence>', "the stop's evidence").replace('<items>', 'each item left with its label')} |`),
  ];
  const stops = STOPS_OF[role].map((stop) => `${STOP_TEXT[stop]}: ${evidence(role, stop)}`);
  return [BEGIN, intro, '', ...f1, '', ...f2, '', `The stop's evidence: ${stops.join('; ')}.`, END].join('\n');
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
