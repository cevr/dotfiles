// How a step ends, as one decision table: role × why the step ended × the state of each item left. Every cell of
// the cross-product holds exactly one outcome (the role's verdict word, the file it writes, the item's one label)
// or names why it cannot occur. agents.ts renders a role's rows into its prompt between BEGIN and END, and every
// role's rows into end-of-step.md; no other sentence of a prompt decides how a step ends (ending.test.ts lints it).
// Edit the table here, then run agents.ts (and opencode's `bun run agents`).

export const ROLES = ['planner', 'implementor', 'verifier', 'worker'] as const;
export type Role = (typeof ROLES)[number];

/** Why the step ended. */
export const REASONS = ['refusal-form', 'refusal-none', 'limit', 'cannot-run', 'waiting', 'done'] as const;
export type Reason = (typeof REASONS)[number];

/**
 * Which reason a step ends on when more than one holds: a refusal or the round's limit ends it the moment it
 * happens (whichever comes first); else the step goes on while a runnable item is left, then ends on the first of
 * the rest that holds, in this order.
 */
export const AT_ONCE: ReadonlyArray<Reason> = ['refusal-form', 'refusal-none', 'limit'];
export const ONCE_NOTHING_RUNNABLE: ReadonlyArray<Reason> = ['cannot-run', 'waiting', 'done'];

/** The state of one item left, in precedence order: an item in more than one state takes the first. */
export const STATES = ['stopped', 'waits', 'discovery', 'runnable'] as const;
export type State = (typeof STATES)[number];

/** The labels an item carries: its words, then what they mean. */
export const LABELS = {
  continues: ['`continues next round`', "this unit's work, in its next round (or its rewrite after the failure cap); never a follow-up"],
  waits: ['`waits on <id>`', 'the open unit, question, commitment or contradicting spec lines it waits on, by id; it keeps this label whatever ended the step'],
  refusedForm: ['`refused: <what>; form: <the form it named>`', "this unit's work: never a follow-up, never tried another way"],
  refused: ['`refused: <what>`', "this unit's work: never a follow-up, never tried another way"],
  cannot: ['`cannot run here: <check or tool>`', 'with its command and output'],
  outside: ['`finding outside the unit`', "listed under Follow-ups (an implementor's in `state.md`, a planner's in its file)"],
  base: ['a `base` finding', 'On base: it goes to a follow-up unit, never this round'],
  notRun: ['`not run`', 'named under Check, with the refusal'],
  taskRefusedForm: ['`refused: <what>; form: <the form it named>`', 'never tried another way'],
  taskRefused: ['`refused: <what>`', 'never tried another way'],
  left: ['`left`', 'named in your result'],
  outsideTask: ['`outside the task`', 'named in your result'],
} as const satisfies Record<string, readonly [string, string]>;
export type Label = keyof typeof LABELS;

/** Why a cell cannot occur. */
export const NEVER = {
  noneLeft: 'done means no required item is left',
  notStopped: 'only a refusal or a check that cannot run stops an item',
  runnableFirst: 'this end comes only once no runnable item is left',
  verifierWaits: 'a verifier waits only in a step that ends on waiting work',
  verifierLimit: "a verifier's step has no timebox or failure cap",
  workerLimit: 'a lean worker has no round, timebox or failure cap',
} as const;
export type Never = keyof typeof NEVER;

export type Cell = { readonly label: Label } | { readonly never: Never };
export type Row =
  | { readonly role: Role; readonly reason: Reason; readonly verdict: string; readonly file: string; readonly items: Readonly<Record<State, Cell>> }
  | { readonly role: Role; readonly reason: Reason; readonly never: Never };

export const REASON_TEXT: Record<Reason, string> = {
  'refusal-form': 'A refusal named an accepted form',
  'refusal-none': 'A refusal named no accepted form',
  limit: "The round's limit passed: the timebox by the clock, the failure cap by its count",
  'cannot-run': 'A required check or tool cannot run on this host, with no refusal',
  waiting: 'Only work that waits is left (an open unit, an owner commitment, an orchestrator question no stated assumption covers, two spec lines that contradict)',
  done: 'All required work is done',
};

export const STATE_TEXT: Record<State, string> = {
  stopped: 'The item the end stopped',
  waits: 'An item that waits',
  discovery: 'Work no spec item asks for',
  runnable: 'A runnable item',
};

/** Each role's required work: `done` means all of it is done. */
export const REQUIRED: Record<Role, string> = {
  planner:
    'Your required work: every section of the spec filled, and its acceptance check runnable and recorded red. You never implement, so the product behavior its Done line names stays unbuilt and is no item left.',
  implementor: 'Your required work: every item of the spec, built, gated and requested.',
  verifier:
    'Your required work: every check of step 1 ran, for every unit; a check of step 1 that could not run or ran unclear is `stuck`, never `accepted`, and a wider probe this host cannot run goes under Unproven and does not stop `accepted`. Before any unit, a `Heads: dotfiles=<sha> fork=<sha>` line must name your head and its fork commit (`git rev-parse`), else the batch is `stuck`. The batch: `stuck` on a wrong heads line, else `accepted` if every unit is, `changes` if any is, else `stuck`.',
  worker: 'Your required work: the task in your first message.',
};

const L = (label: Label): Cell => ({ label });
const N = (never: Never): Cell => ({ never });
const BLOCKED = '`<unit dir>/blocked.md`';
const FINDINGS = "each unit's `round-N-findings.md` and the batch's findings file";
const RESULT = 'none: your result as text';

/** A planner's or implementor's rows past `done`: the same verdict, file and labels. */
const stopped = (role: 'planner' | 'implementor'): ReadonlyArray<Row> => [
  {
    role,
    reason: 'refusal-form',
    verdict: '`blocked`',
    file: `${BLOCKED}: what was refused and the form it named (the exact \`!\` command or allow rule, as Refusals says)`,
    items: { stopped: L('refusedForm'), waits: L('waits'), discovery: L('outside'), runnable: L('continues') },
  },
  {
    role,
    reason: 'refusal-none',
    verdict: '`blocked`',
    file: `${BLOCKED}: what was refused, as the refusal said it, and an allow rule only if one exists`,
    items: { stopped: L('refused'), waits: L('waits'), discovery: L('outside'), runnable: L('continues') },
  },
  {
    role,
    reason: 'limit',
    verdict: '`blocked`',
    file: `${BLOCKED}, quoting the clock or the count`,
    items: { stopped: N('notStopped'), waits: L('waits'), discovery: L('outside'), runnable: L('continues') },
  },
  {
    role,
    reason: 'cannot-run',
    verdict: '`blocked`',
    file: `${BLOCKED}: the check or tool, its command and output, and the probe that would settle it`,
    items: { stopped: L('cannot'), waits: L('waits'), discovery: L('outside'), runnable: N('runnableFirst') },
  },
  {
    role,
    reason: 'waiting',
    verdict: '`blocked`',
    file: `${BLOCKED}: each wait by its id, what you tried, the options and your pick`,
    items: { stopped: N('notStopped'), waits: L('waits'), discovery: L('outside'), runnable: N('runnableFirst') },
  },
];

const DONE_ITEMS = (outside: Label) => ({ stopped: N('noneLeft'), waits: N('noneLeft'), discovery: L(outside), runnable: N('noneLeft') });

export const TABLE: ReadonlyArray<Row> = [
  ...stopped('planner'),
  { role: 'planner', reason: 'done', verdict: '`ready`', file: '`<unit dir>/spec.md`', items: DONE_ITEMS('outside') },
  ...stopped('implementor'),
  { role: 'implementor', reason: 'done', verdict: '`ready`', file: '`<unit dir>/round-N-request.md`, committed, once `request.ts` exits 0', items: DONE_ITEMS('outside') },
  {
    role: 'verifier',
    reason: 'refusal-form',
    verdict: '`stuck`',
    file: `${FINDINGS}, the refusal under Check: what was refused and the form it named`,
    items: { stopped: L('refusedForm'), waits: N('verifierWaits'), discovery: L('base'), runnable: L('notRun') },
  },
  {
    role: 'verifier',
    reason: 'refusal-none',
    verdict: '`stuck`',
    file: `${FINDINGS}, the refusal under Check: what was refused, as it said it`,
    items: { stopped: L('refused'), waits: N('verifierWaits'), discovery: L('base'), runnable: L('notRun') },
  },
  { role: 'verifier', reason: 'limit', never: 'verifierLimit' },
  {
    role: 'verifier',
    reason: 'cannot-run',
    verdict: '`stuck`',
    file: `${FINDINGS}, the check under Check with its command and exit code`,
    items: { stopped: L('cannot'), waits: N('verifierWaits'), discovery: L('base'), runnable: N('runnableFirst') },
  },
  {
    role: 'verifier',
    reason: 'waiting',
    verdict: '`stuck`',
    file: `${FINDINGS}, what each check waits on under Check`,
    items: { stopped: N('notStopped'), waits: L('waits'), discovery: L('base'), runnable: N('runnableFirst') },
  },
  { role: 'verifier', reason: 'done', verdict: '`changes` if you proved a Blocker or Major, else `accepted`', file: FINDINGS, items: DONE_ITEMS('base') },
  {
    role: 'worker',
    reason: 'refusal-form',
    verdict: `${RESULT}, naming what was refused and the form it named`,
    file: 'none',
    items: { stopped: L('taskRefusedForm'), waits: L('waits'), discovery: L('outsideTask'), runnable: L('left') },
  },
  {
    role: 'worker',
    reason: 'refusal-none',
    verdict: `${RESULT}, naming what was refused, as it said it`,
    file: 'none',
    items: { stopped: L('taskRefused'), waits: L('waits'), discovery: L('outsideTask'), runnable: L('left') },
  },
  { role: 'worker', reason: 'limit', never: 'workerLimit' },
  {
    role: 'worker',
    reason: 'cannot-run',
    verdict: `${RESULT}, naming the check or tool`,
    file: 'none',
    items: { stopped: L('cannot'), waits: L('waits'), discovery: L('outsideTask'), runnable: N('runnableFirst') },
  },
  {
    role: 'worker',
    reason: 'waiting',
    verdict: `${RESULT}, naming each wait`,
    file: 'none',
    items: { stopped: N('notStopped'), waits: L('waits'), discovery: L('outsideTask'), runnable: N('runnableFirst') },
  },
  { role: 'worker', reason: 'done', verdict: RESULT, file: 'none', items: DONE_ITEMS('outsideTask') },
];

export type Outcome = { readonly verdict: string; readonly file: string; readonly label: Label } | { readonly never: Never };

/** The rows of one role and reason: exactly one in a well-formed table. */
const rowsOf = (table: ReadonlyArray<Row>, role: Role, reason: Reason) => table.filter((row) => row.role === role && row.reason === reason);

/** The one outcome of a cell; throws when the table holds no row, or more than one, for it. */
export function cell(role: Role, reason: Reason, state: State, table: ReadonlyArray<Row> = TABLE): Outcome {
  const rows = rowsOf(table, role, reason);
  if (rows.length !== 1) throw new Error(`${rows.length} rows for ${role} × ${reason}`);
  const row = rows[0]!;
  if ('never' in row) return { never: row.never };
  const item = row.items[state];
  if (item === undefined) throw new Error(`no cell for ${role} × ${reason} × ${state}`);
  return 'never' in item ? item : { verdict: row.verdict, file: row.file, label: item.label };
}

/** The reason a step ends on: the first that happened of those that end it at once, else the first of the rest. */
export function reasonOf(holding: ReadonlyArray<Reason>, firstAtOnce?: Reason): Reason {
  if (firstAtOnce !== undefined && AT_ONCE.includes(firstAtOnce) && holding.includes(firstAtOnce)) return firstAtOnce;
  const reason = AT_ONCE.find((one) => holding.includes(one)) ?? ONCE_NOTHING_RUNNABLE.find((one) => holding.includes(one));
  if (reason === undefined) throw new Error('no reason holds: the step has not ended');
  return reason;
}

/** The state an item takes: the first, in STATES order, of the states it is in. */
export function stateOf(states: ReadonlyArray<State>): State {
  const first = STATES.find((state) => states.includes(state));
  if (first === undefined) throw new Error('an item with no state');
  return first;
}

/** A batch's verdict from its heads line and its units' verdicts, as REQUIRED.verifier says it. */
export function batchVerdict(headsMatch: boolean, units: ReadonlyArray<'accepted' | 'changes' | 'stuck'>): 'accepted' | 'changes' | 'stuck' {
  if (!headsMatch) return 'stuck';
  if (units.every((unit) => unit === 'accepted')) return 'accepted';
  if (units.some((unit) => unit === 'changes')) return 'changes';
  return 'stuck';
}

export const BEGIN = '<!-- end-of-step: generated by skills/orchestrate/scripts/ending.ts from its table; edit that, then run agents.ts -->';
export const END = '<!-- /end-of-step -->';
/** A rendered block, wherever it stands in a file. */
export const BLOCK = /<!-- end-of-step: [^\n]*-->[\s\S]*?<!-- \/end-of-step -->/;

const KEYS = 'abcdefghij';
const cellText = (outcome: Outcome | Cell, keys: ReadonlyArray<Never>) =>
  'never' in outcome ? `cannot occur (${KEYS[keys.indexOf(outcome.never)]})` : LABELS[outcome.label][0];

/** One role's rows, as its prompt carries them: the order, the table, then what its labels and keys mean. */
export function render(role: Role, table: ReadonlyArray<Row> = TABLE): string {
  const rows = REASONS.map((reason) => {
    const found = rowsOf(table, role, reason);
    if (found.length !== 1) throw new Error(`${found.length} rows for ${role} × ${reason}`);
    return [reason, found[0]!] as const;
  });
  const used = new Set<Label>();
  const keys: Array<Never> = [];
  const keep = (never: Never) => (keys.includes(never) ? undefined : keys.push(never));
  for (const [, row] of rows) {
    if ('never' in row) keep(row.never);
    else for (const state of STATES) { const item = row.items[state]; if ('never' in item) keep(item.never); else used.add(item.label); }
  }
  const limit = rows.some(([reason, row]) => reason === 'limit' && !('never' in row));
  const intro = [
    `**How your step ends.** It ends the moment a refusal comes${role === 'worker' ? '' : ' (the Refusals paragraph)'}${limit ? " or the round's limit passes, whichever comes first" : ''}; else it goes on while a runnable item is left, then ends on the first of the last three rows that holds, in their order.`,
    'That one row gives your verdict, the file you write and the one label of each item left; an item in more than one state takes the leftmost column that applies. Effort is no reason and no label.',
    REQUIRED[role],
  ].join(' ');
  const header = `| Why the step ended | Verdict | You write | ${STATES.map((state) => STATE_TEXT[state]).join(' | ')} |`;
  const lines = rows.map(([reason, row]) =>
    'never' in row
      ? `| ${REASON_TEXT[reason]} | cannot occur (${KEYS[keys.indexOf(row.never)]}) | | ${STATES.map(() => '').join(' | ')} |`
      : `| ${REASON_TEXT[reason]} | ${row.verdict} | ${row.file === 'none' ? '' : row.file} | ${STATES.map((state) => cellText(row.items[state], keys)).join(' | ')} |`,
  );
  const meaning = [...used].map((label) => `${LABELS[label][0]}: ${LABELS[label][1]}`).join('; ');
  const never = keys.map((key, index) => `(${KEYS[index]}) ${NEVER[key]}`).join('; ');
  return [BEGIN, intro, '', header, `| --- | --- | --- | ${STATES.map(() => '---').join(' | ')} |`, ...lines, '', `Labels: ${meaning}. Cannot occur: ${never}.`, END].join('\n');
}

/** protocol.md's block: where each role's rows go, and where all of them are. */
export const PROTOCOL_BLOCK = [
  BEGIN,
  "How a step ends is one table, by role, by why it ended and by the state of each item left: [`end-of-step.md`](end-of-step.md). Each role's prompt carries its own rows here.",
  END,
].join('\n');

/** Every role's rows, as end-of-step.md holds them. */
export function document(table: ReadonlyArray<Row> = TABLE): string {
  const parts = [
    '# How a step ends',
    '',
    "Generated by `scripts/ending.ts` from its table: edit that, then run `scripts/agents.ts`. One row per role and why the step ended, one column per state of an item left; every cell holds one outcome or names why it cannot occur. Each role's prompt carries its own rows, as below.",
  ];
  for (const role of ROLES) parts.push('', `## ${role}`, '', render(role, table).split('\n').slice(1, -1).join('\n'));
  return `${parts.join('\n')}\n`;
}
