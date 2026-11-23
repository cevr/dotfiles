// The round policy: how an orchestrate role's step ends, as one versioned contract every host's prompt is
// generated from and decoded back into. Effect-free and IO-free, so the installed plugin (role.ts), the skill's
// generator (skills/orchestrate/scripts/round-policy.ts) and the tests read the same source.
//
//   vocabulary  roles, item states, stop events, the atoms a row's condition is written in, the item evidence
//               fields, the artifacts a verdict writes and each stop's evidence fields, all closed sets;
//   policy      per role, the ordered decision rows (stable rule ids, first true row wins), the ordered verdict
//               rules with their artifacts, and the stop evidence: `project(role)`;
//   notation    `render(policy)` writes the block a prompt carries; `decode(text)` reads a delivered block back
//               into the same Policy, strictly (fixed vocabulary, numbered priority, field names, version);
//               `policyFaults(role, text)` compares what a host delivered with the source, field by field and
//               byte for byte;
//   trace       the contract's input: an item's `Trace`, its assignment and its events, each about the attempt it
//               names (begin, observe, finish, interrupt, deny) or an obstacle (lift, host lost and back, wait open
//               and close, settle); `fold(role, trace)` is the record it leaves (`Folded`, which only `fold` makes)
//               or the first event that cannot happen where it stands, a typed rejection;
//   evidence    the record holds its facts and its content-bound evidence fields (attempt ids, commands, output
//               digests, receipts, heads, refusal scope and remedy, probes, wait refs), all derived by the fold; a
//               record from outside is accepted only as the fold of the one trace it can be (`decodeRecord`);
//               `dueTrace(policy, trace)` and `due(policy, record)` are the hand-back owed, `judge(due, given)` every
//               field that differs; a held item's stop evidence is derived from its trace (`heldEvidence`);
//   admission   `outcome(policy, stop, states)` the verdict, artifacts and stop fields; `admit(policy, step, claim)`
//               every reason a claimed hand-back does not match the checked step.
// A Policy is data: the tests mutate it to show each mutation is caught by the test meant to catch it.

export const VERSION = 1

export const ROLES = ["planner", "implementor", "verifier", "worker"] as const
export type Role = (typeof ROLES)[number]

export const HOSTS = ["claude", "codex", "opencode"] as const
export type Host = (typeof HOSTS)[number]
/** The hosts each role ships on: the lean worker has no Codex runtime (its Codex file is no eligible route). */
export const HOSTS_OF = {
  planner: HOSTS,
  implementor: HOSTS,
  verifier: HOSTS,
  worker: ["claude", "opencode"],
} as const satisfies { readonly [R in Role]: ReadonlyArray<Host> }

// ---- the item ------------------------------------------------------------------------------------------------------

export const ATTEMPTS = ["never", "started", "pass", "fail", "unclear"] as const
export type Attempt = (typeof ATTEMPTS)[number]
export const RESULTS = ["pass", "fail", "unclear"] as const
export type Result = (typeof RESULTS)[number]
export const PROVENANCES = ["none", "unit", "base"] as const
export type Provenance = (typeof PROVENANCES)[number]

/** An item's facts: what the decision reads. `attempt` is the last completed result, or `started`/`never`. */
export interface Facts {
  readonly assigned: boolean
  readonly required: boolean
  readonly attempt: Attempt
  readonly settled: boolean
  readonly refused: boolean
  readonly hostCannot: boolean
  readonly wait: boolean
  readonly provenance: Provenance
}

/** Why an attempt shows no output: it never started, was interrupted, or ran with no authenticated evidence. */
export const MISSING = ["not-started", "interrupted", "missing-authenticated-evidence"] as const
export type Missing = (typeof MISSING)[number]
export type Output =
  | { readonly kind: "log"; readonly digest: string }
  | { readonly kind: "partial"; readonly digest: string }
  | { readonly kind: "missing"; readonly why: Missing }

/** The last attempt that finished: content-bound, never a boolean. */
export interface Run {
  readonly id: string
  readonly command: string
  readonly output: Output
  readonly exit: number
  readonly receipt: string
  readonly head: string
  readonly result: Result
}
export const PENDING = ["started", "interrupted", "denied"] as const
export type PendingStatus = (typeof PENDING)[number]
/** An attempt newer than the last completed one, with no result: running, interrupted, or answered by a refusal. */
export interface Pending {
  readonly id: string
  readonly command: string
  readonly status: PendingStatus
  readonly output: Output
}
/**
 * What authority a refusal named: `named`, the form to retry with (the `!` command or allow rule); `none`, nothing; or
 * `allow`, no form to retry with but an allow rule that exists, as the refusal printed it. Absence is the `none` tag,
 * never an empty or placeholder string.
 */
export type Form = { readonly kind: "named"; readonly form: string } | { readonly kind: "none" } | { readonly kind: "allow"; readonly allow: string }
export interface Refusal {
  readonly what: string
  readonly scope: string
  readonly report: string
  readonly form: Form
}
export interface Absent {
  readonly tool: string
  readonly probe: string
  readonly output: Output
}

export const FIELDS = ["completed", "current", "refused", "cannot", "waits"] as const
export type FieldId = (typeof FIELDS)[number]
export type Field =
  | { readonly field: "completed"; readonly run: Run }
  | { readonly field: "current"; readonly attempt: Pending }
  | { readonly field: "refused"; readonly refusal: Refusal }
  | { readonly field: "cannot"; readonly absent: Absent }
  | { readonly field: "waits"; readonly ref: string }

/** One item as its own history leaves it: its facts and the evidence fields they imply. */
export interface ItemRecord {
  readonly id: string
  readonly facts: Facts
  readonly fields: ReadonlyArray<Field>
}

// ---- vocabulary --------------------------------------------------------------------------------------------------

export const STATES = ["done", "proven", "runnable", "waits", "refused", "cannot", "unclear", "unproven", "discovery", "unitFinding", "baseFinding"] as const
export type State = (typeof STATES)[number]
export const STOPS = ["refusalForm", "refusalNone", "limit", "idle"] as const
export type Stop = (typeof STOPS)[number]

export const STATES_OF = {
  planner: ["done", "runnable", "waits", "refused", "cannot", "discovery"],
  implementor: ["done", "runnable", "waits", "refused", "cannot", "discovery"],
  verifier: ["done", "proven", "runnable", "waits", "refused", "cannot", "unclear", "unproven", "unitFinding", "baseFinding"],
  worker: ["done", "runnable", "waits", "refused", "cannot", "discovery"],
} as const satisfies { readonly [R in Role]: ReadonlyArray<State> }
export const STOPS_OF = {
  planner: STOPS,
  implementor: STOPS,
  verifier: ["refusalForm", "refusalNone", "idle"],
  worker: ["refusalForm", "refusalNone", "idle"],
} as const satisfies { readonly [R in Role]: ReadonlyArray<Stop> }

export const hasState = (role: Role, state: State): boolean => STATES_OF[role].some((one) => one === state)
export const hasStop = (role: Role, stop: Stop): boolean => STOPS_OF[role].some((one) => one === stop)

export const STATE_NAME = {
  done: "done",
  proven: "proven",
  runnable: "runnable",
  waits: "waiting",
  refused: "refused",
  cannot: "cannot run",
  unclear: "ran unclear",
  unproven: "unproven",
  discovery: "a discovery",
  unitFinding: "a unit finding",
  baseFinding: "a base finding",
} as const satisfies { readonly [S in State]: string }

export const STOP_TEXT = {
  refusalForm: "a refusal named an accepted form",
  refusalNone: "a refusal named no accepted form",
  limit: "the round's limit passed",
  idle: "no runnable item is left",
} as const satisfies { readonly [S in Stop]: string }

export const ATOMS = ["assigned", "notAssigned", "required", "optional", "refused", "hostCannot", "wait", "pass", "fail", "unclear", "noRetry", "attempted", "advance", "unit", "base"] as const
export type Atom = (typeof ATOMS)[number]

const ATOM_WORDS = {
  assigned: "assigned",
  notAssigned: "not assigned",
  required: "required",
  optional: "optional (a wider probe)",
  refused: "a refusal stopped it",
  hostCannot: "this host cannot run it (its check or tool is absent or will not start)",
  wait: "waits on an open unit, question, commitment or two contradicting spec lines",
  pass: "its acceptance holds",
  fail: "ran and proves a Blocker or Major",
  unclear: "ran, with a result that settles neither pass nor fail",
  noRetry: "no retry can settle it here",
  attempted: "attempted (it ran at least once)",
  advance: "can still advance in this lane",
  unit: "the unit's change introduced it, shown by measured attribution (whether or not a spec item names it)",
  base: "shown on the base head too",
} as const satisfies { readonly [A in Atom]: string }

/** How an atom reads in a role's prompt: the one vocabulary the renderer writes and the decoder reads. */
export const atomWords = (role: Role, atom: Atom): string => {
  if (atom === "pass" && role === "verifier") return "ran and passed"
  if (atom === "advance" && role === "worker") return "can still advance"
  return ATOM_WORDS[atom]
}

/** What a reader can take each atom to say of an item: true wherever its words could be read as true. */
export const READS = {
  assigned: (facts: Facts) => facts.assigned,
  notAssigned: (facts: Facts) => !facts.assigned,
  required: (facts: Facts) => facts.assigned && facts.required,
  optional: (facts: Facts) => facts.assigned && !facts.required,
  refused: (facts: Facts) => facts.refused,
  hostCannot: (facts: Facts) => facts.hostCannot,
  wait: (facts: Facts) => facts.wait,
  pass: (facts: Facts) => facts.attempt === "pass",
  fail: (facts: Facts) => facts.attempt === "fail",
  unclear: (facts: Facts) => facts.attempt === "unclear",
  noRetry: (facts: Facts) => facts.settled || facts.refused || facts.hostCannot || facts.wait,
  attempted: (facts: Facts) => facts.attempt !== "never",
  advance: (facts: Facts) => !facts.settled,
  unit: (facts: Facts) => facts.provenance === "unit",
  base: (facts: Facts) => facts.provenance === "base",
} as const satisfies { readonly [A in Atom]: (facts: Facts) => boolean }

/** Every atom true of an item holding all of `facts` (two records: two facts at once). */
export const truths = (facts: ReadonlyArray<Facts>): ReadonlySet<Atom> => new Set(ATOMS.filter((atom) => facts.some((one) => READS[atom](one))))

// ---- the policy ----------------------------------------------------------------------------------------------------

/** A row's condition: the atoms that must all be true, or the catch-all. */
export type When = ReadonlyArray<Atom> | "otherwise"
export interface Row {
  readonly priority: number
  readonly id: string
  readonly state: State
  readonly when: When
  readonly label: string
}

export const ARTIFACTS = ["spec", "request", "state", "blocked", "findings", "batch", "result"] as const
export type Artifact = (typeof ARTIFACTS)[number]
export const ARTIFACT_TEXT = {
  spec: "`<unit dir>/spec.md`",
  request: "`<unit dir>/round-N-request.md`, committed, once `request.ts` exits 0",
  state: "`<unit dir>/state.md` current (even with no commit since)",
  blocked: "`<unit dir>/blocked.md`",
  findings: "each unit's `round-N-findings.md`",
  batch: "the batch's findings file",
  result: "your result as text",
} as const satisfies { readonly [A in Artifact]: string }
export const CONTENTS = ["check", "evidence", "items"] as const
export type Content = (typeof CONTENTS)[number]
export const CONTENT_TEXT = {
  check: "under Check",
  evidence: "the stop's evidence",
  items: "each item left with its label",
} as const satisfies { readonly [C in Content]: string }

export type VerdictWhen = { readonly kind: "any"; readonly states: ReadonlyArray<State> } | { readonly kind: "only"; readonly states: ReadonlyArray<State> } | { readonly kind: "else" }
export interface Writes {
  readonly artifacts: ReadonlyArray<Artifact>
  readonly contents: ReadonlyArray<Content>
}
export interface VerdictRule {
  readonly priority: number
  readonly id: string
  readonly verdict: string
  readonly when: VerdictWhen
  readonly writes: Writes
}

export const STOP_FIELDS = ["refused.what", "refused.form", "refused.allow", "limit", "held"] as const
export type StopFieldId = (typeof STOP_FIELDS)[number]
/**
 * How many values a stop field takes, and so whether absence is the truth: `always` exactly one; `ifPrinted` one when the
 * refused item's record holds the remedy the field is for (`refused.form` the `!` command, `refused.allow` the allow rule), else none; `perHeld` one per item that holds
 * the step back, naming it, so none (an empty collection) when no item does. A value is never empty: empty is no
 * value at all, and absence is told by leaving the field out.
 */
export const PRESENCES = ["always", "ifPrinted", "perHeld"] as const
export type Presence = (typeof PRESENCES)[number]
export interface StopField {
  readonly id: StopFieldId
  readonly presence: Presence
  readonly text: string
}
/**
 * The states whose items hold an idle step back (a runnable item keeps the step going and a refusal stops it at once):
 * what the `held` collection names, one entry each.
 */
export const HOLDS_BACK = ["waits", "cannot", "unclear"] as const satisfies ReadonlyArray<State>
export interface StopEvidence {
  readonly stop: Stop
  readonly fields: ReadonlyArray<StopField>
}
export interface FieldText {
  readonly id: FieldId
  readonly text: string
}

export interface Policy {
  readonly version: number
  readonly role: Role
  readonly intro: string
  readonly fields: ReadonlyArray<FieldText>
  readonly rows: ReadonlyArray<Row>
  readonly verdicts: ReadonlyArray<VerdictRule>
  readonly stops: ReadonlyArray<StopEvidence>
}

const CONTINUES = "`continues next round`: this unit's work, in its next round (or its rewrite after the failure cap); never a follow-up"
const WAITS = "`waits on <id>`"
const REFUSED = "`refused: <what>`, adding `; form: <the form it named>` only when the refusal named one: this unit's work, never a follow-up, never tried another way"
const REFUSED_PLAIN = "`refused: <what>`, adding `; form: <the form it named>` only when the refusal named one: never tried another way"
const CANNOT = "`cannot run here: <check or tool>`, with its command and output"
const NONE = "none: it is no item left"

/** Each row as authored: rule id, state, condition and label. Priority is its place. */
type Authored = readonly [id: string, state: State, when: When, label: string]

const specWork = (discovery: string, runnable: string, refused: string): ReadonlyArray<Authored> => [
  ["discovery", "discovery", ["notAssigned"], discovery],
  ["refused", "refused", ["refused"], refused],
  ["cannot", "cannot", ["hostCannot"], CANNOT],
  ["waits", "waits", ["wait"], WAITS],
  ["done", "done", ["pass"], NONE],
  ["runnable", "runnable", "otherwise", runnable],
]

const AUTHORED = {
  planner: specWork("`finding outside the unit`, under Follow-ups in your file", CONTINUES, REFUSED),
  implementor: specWork("`finding outside the unit`, in `state.md` under Follow-ups", CONTINUES, REFUSED),
  verifier: [
    ["unitFinding", "unitFinding", ["notAssigned", "unit"], "marked `unit`: the same lane closes it in its next round"],
    ["baseFinding", "baseFinding", ["notAssigned", "base"], "marked `base`: a follow-up unit"],
    ["refused", "refused", ["refused"], REFUSED_PLAIN],
    ["cannot", "cannot", ["required", "hostCannot"], CANNOT],
    ["waits", "waits", ["required", "wait"], WAITS],
    ["proven", "proven", ["fail"], "a Blocker or Major, filed with its proof"],
    ["done", "done", ["pass"], NONE],
    ["unclear", "unclear", ["required", "unclear", "noRetry"], "`ran unclear: <check>`, with its command and the output that settles nothing"],
    ["unproven", "unproven", ["optional"], "`unproven: <probe>`, under Unproven with the probe that would settle it; it never changes the verdict"],
    ["retry", "runnable", ["required", "attempted", "advance"], "`retry: <check>`, named under Check; it continues to a result"],
    ["notRun", "runnable", "otherwise", "`not run`, named under Check"],
  ],
  worker: specWork("`outside the task`, named in your result", "`left`, named in your result", REFUSED_PLAIN),
} as const satisfies { readonly [R in Role]: ReadonlyArray<Authored> }

/** The pinned winner of every pair of rows one reachable record makes true together, with what must survive. */
export interface Pin {
  readonly pair: readonly [string, string]
  readonly winner: string
  readonly why: string
}
const OBSTACLE_PINS: ReadonlyArray<Pin> = [
  { pair: ["refused", "cannot"], winner: "refused", why: "the refusal's scope and form must survive: only it lets the orchestrator act; the `cannot` field stays" },
  { pair: ["refused", "waits"], winner: "refused", why: "the refusal's scope and form must survive: the wait closes by itself, the refusal never does; the `waits` field stays" },
  { pair: ["cannot", "waits"], winner: "cannot", why: "the missing tool and its probe must survive: no retry here changes the host; the `waits` field stays" },
]
export const PINS = {
  planner: OBSTACLE_PINS,
  implementor: OBSTACLE_PINS,
  worker: OBSTACLE_PINS,
  verifier: [
    ...OBSTACLE_PINS,
    { pair: ["refused", "unclear"], winner: "refused", why: "the refusal must survive; the unclear output stays as `completed`" },
    { pair: ["cannot", "unclear"], winner: "cannot", why: "the missing tool and its probe must survive; the unclear output stays as `completed`" },
    { pair: ["waits", "unclear"], winner: "waits", why: "the wait's id must survive: it is how the check reopens; the unclear output stays as `completed`" },
    { pair: ["refused", "retry"], winner: "refused", why: "a retry the refusal stops will not run; what the attempt printed stays as `completed`" },
    { pair: ["cannot", "retry"], winner: "cannot", why: "a retry here would not start" },
    { pair: ["waits", "retry"], winner: "waits", why: "the retry runs only once the wait closes" },
    { pair: ["unclear", "retry"], winner: "unclear", why: "both hold only under an obstacle, which governs them both; between the two, the output that settles nothing survives as ran unclear" },
    { pair: ["proven", "unproven"], winner: "proven", why: "an optional probe that proves a Blocker or Major is filed as one" },
    { pair: ["refused", "unproven"], winner: "refused", why: "a refusal stops the step whatever the item, so a refused optional probe is refused, never a quiet unproven" },
    { pair: ["done", "unproven"], winner: "done", why: "an optional probe that passed leaves nothing to prove; its run stays as `completed`" },
  ],
} as const satisfies { readonly [R in Role]: ReadonlyArray<Pin> }

const BLOCKED: Writes = { artifacts: ["state", "blocked"], contents: ["evidence", "items"] }
const FINDINGS: Writes = { artifacts: ["findings", "batch"], contents: ["check", "evidence", "items"] }
const VERDICTS_AUTHORED = {
  planner: [
    { id: "ready", verdict: "ready", when: { kind: "only", states: ["done", "discovery"] }, writes: { artifacts: ["spec"], contents: [] } },
    { id: "blocked", verdict: "blocked", when: { kind: "else" }, writes: BLOCKED },
  ],
  implementor: [
    { id: "ready", verdict: "ready", when: { kind: "only", states: ["done", "discovery"] }, writes: { artifacts: ["request"], contents: [] } },
    { id: "blocked", verdict: "blocked", when: { kind: "else" }, writes: BLOCKED },
  ],
  verifier: [
    { id: "stuck", verdict: "stuck", when: { kind: "any", states: ["runnable", "waits", "refused", "cannot", "unclear"] }, writes: FINDINGS },
    { id: "changes", verdict: "changes", when: { kind: "any", states: ["proven"] }, writes: FINDINGS },
    { id: "accepted", verdict: "accepted", when: { kind: "else" }, writes: FINDINGS },
  ],
  worker: [{ id: "none", verdict: "none", when: { kind: "else" }, writes: { artifacts: ["result"], contents: ["evidence", "items"] } }],
} as const satisfies { readonly [R in Role]: ReadonlyArray<Omit<VerdictRule, "priority">> }

/** Every pair of verdict rules both true of some well-formed step, the earlier governing, with why. */
export const VERDICT_ORDER = {
  planner: [],
  implementor: [],
  verifier: [{ earlier: "stuck", later: "changes", why: "a proven Blocker and a required check with no result: the verdict waits for every required check, and the proof is still filed under its own label" }],
  worker: [],
} as const satisfies { readonly [R in Role]: ReadonlyArray<{ readonly earlier: string; readonly later: string; readonly why: string }> }

const WHAT: StopField = { id: "refused.what", presence: "always", text: "what was refused, as the refusal said it" }
const FORM: StopField = { id: "refused.form", presence: "ifPrinted", text: "the `!` command it printed" }
const ALLOW: StopField = { id: "refused.allow", presence: "ifPrinted", text: "the allow rule it printed" }
const REMEDY = [WHAT, FORM, ALLOW]
/** A held item's evidence, derived from its trace (`heldEvidence`): its last run, else the label of what keeps it from one. */
const HELD: StopField = { id: "held", presence: "perHeld", text: "`<command> (exit <code>)` of its last run, else its label" }
const STOP_AUTHORED = {
  planner: {
    refusalForm: REMEDY,
    refusalNone: [WHAT],
    limit: [{ id: "limit", presence: "always", text: "the clock (the timebox) or the count (the failure cap)" }],
    idle: [HELD],
  },
  verifier: {
    refusalForm: REMEDY,
    refusalNone: [WHAT],
    idle: [HELD],
  },
  worker: {
    refusalForm: REMEDY,
    refusalNone: [WHAT],
    idle: [HELD],
  },
} as const satisfies { readonly [K in "planner" | "verifier" | "worker"]: { readonly [S in Stop]?: ReadonlyArray<StopField> } }

const stopAuthored = (role: Role, stop: Stop): ReadonlyArray<StopField> => {
  if (role === "planner" || role === "implementor") return STOP_AUTHORED.planner[stop]
  if (stop === "limit") return []
  return STOP_AUTHORED[role][stop]
}

export const FIELD_TEXT = {
  completed: "the last attempt that finished: its id, the command it ran, its output's digest, its exit code, its receipt, the head it ran at and its result",
  current: "an attempt newer than that, with no result: its id, its command, its status (started, interrupted or denied) and its partial output's digest or why it has none",
  refused: "what was refused, as the refusal said it, its scope, where its safe report is, and the `!` command or allow rule it printed, or none",
  cannot: "the check or tool, with the probe that found it absent: its command and output",
  waits: "the id it waits on",
} as const satisfies { readonly [F in FieldId]: string }

export const ASSIGNMENT = {
  planner: "the spec items",
  implementor: "the spec items",
  verifier: "the checks of step 1, which are required, and the wider probes you run, which are optional",
  worker: "the task in your first message",
} as const satisfies { readonly [R in Role]: string }

export const REQUIRED = {
  planner:
    "Your required work: every section of the spec filled, and its acceptance check runnable and recorded red. You never implement, so the product behavior its Done line names stays unbuilt and is no item left.",
  implementor: "Your required work: every item of the spec, built, gated and requested.",
  verifier:
    "Your required work: every check of step 1 ran to a result that settles pass or fail, for every unit; a check of step 1 that could not run or ran unclear is `stuck`, never `accepted`, and a wider probe this host cannot run goes under Unproven and does not stop `accepted`. Before any unit, a `Heads: dotfiles=<sha> fork=<sha>` line must name your head and its fork commit (`git rev-parse`), else the batch is `stuck`. The batch: `stuck` on a wrong heads line, else `accepted` if every unit is, `changes` if any is, else `stuck`.",
  worker: "Your required work: the task in your first message.",
} as const satisfies { readonly [R in Role]: string }

/** A batch's verdict from its heads line and its units' verdicts, as REQUIRED.verifier says it. */
export const batchVerdict = (headsMatch: boolean, units: ReadonlyArray<"accepted" | "changes" | "stuck">): "accepted" | "changes" | "stuck" => {
  if (!headsMatch) return "stuck"
  if (units.every((unit) => unit === "accepted")) return "accepted"
  if (units.some((unit) => unit === "changes")) return "changes"
  return "stuck"
}

const STOPS_SENTENCE = {
  planner: "a refusal comes (the Refusals paragraph) or the round's limit passes",
  implementor: "a refusal comes (the Refusals paragraph) or the round's limit passes",
  verifier: "a refusal comes (the Refusals paragraph)",
  worker: "a refusal comes",
} as const satisfies { readonly [R in Role]: string }
const TABLE_NOTE = {
  planner: "second table",
  implementor: "second table",
  verifier: "second table; an optional probe is only ever done, proven, refused or unproven, and unproven never changes it",
  worker: "second table",
} as const satisfies { readonly [R in Role]: string }

const intro = (role: Role): string =>
  [
    `**How your step ends** (round policy v${VERSION}). It stops the moment ${STOPS_SENTENCE[role]}; else it goes on until no runnable item is left.`,
    "Each item takes one row of the first table, and that row alone gives its state, its rule and its label, whatever stopped the step; the last row takes every item no row above it took.",
    `The states present give your verdict and what you write (${TABLE_NOTE[role]}), and why the step stopped gives the evidence fields of the third. Effort is no state and no label.`,
    `Assigned work is ${ASSIGNMENT[role]}; whatever else you find is not assigned.`,
    REQUIRED[role],
  ].join(" ")

/** One role's policy, from the source data. */
export const project = (role: Role): Policy => ({
  version: VERSION,
  role,
  intro: intro(role),
  fields: FIELDS.map((id) => ({ id, text: FIELD_TEXT[id] })),
  rows: AUTHORED[role].map(([id, state, when, label], index) => ({ priority: index + 1, id, state, when, label })),
  verdicts: VERDICTS_AUTHORED[role].map((rule, index) => ({ ...rule, priority: index + 1 })),
  stops: STOPS_OF[role].map((stop) => ({ stop, fields: stopAuthored(role, stop) })),
})

// ---- the notation --------------------------------------------------------------------------------------------------

export const SOURCE = "opencode/mods/orchestrate/round-policy.ts"
export const header = (role: Role | "protocol", version: number = VERSION): string =>
  `<!-- round-policy v${version} ${role}: generated by ${SOURCE}; edit that, then run skills/orchestrate/scripts/agents.ts -->`
export const END = "<!-- /round-policy -->"
/** A rendered block, wherever it stands in a file. */
export const BLOCK = /<!-- round-policy v\d+ [a-z]+: [^\n]*-->[\s\S]*?<!-- \/round-policy -->/
const HEADER = /^<!-- round-policy v(\d+) ([a-z]+): generated by opencode\/mods\/orchestrate\/round-policy\.ts; edit that, then run skills\/orchestrate\/scripts\/agents\.ts -->$/

export const FIELDS_LEAD =
  "Each item's hand-back gives its rule, its label and each of these fields its record holds, with the exact values recorded; a field the record lacks is left out, never filled in or asserted, and a label wins only the presentation, never dropping another field:"
export const FIRST_ROW = "Take the first row that is true of the item; stop there."
export const FIRST_VERDICT = "Take the first row that holds for the step; stop there."
export const STOPS_LEAD = "Why the step stopped gives the evidence fields you write:"
export const F1_HEADER = "| # | Rule | State | An item that is | Its label |"
export const F2_HEADER = "| # | Rule | Verdict | When | You write |"
export const F3_HEADER = "| Stop | Field | Its evidence | How many |"
const RULE5 = "| --- | --- | --- | --- | --- |"
const RULE4 = "| --- | --- | --- | --- |"

/** At most one element: the first of `items` that `keep` holds for. */
const firstOf = <A>(items: ReadonlyArray<A>, keep: (item: A) => boolean): ReadonlyArray<A> => items.filter(keep).slice(0, 1)
/** `why` when `bad` holds, else nothing. */
const iff = (bad: boolean, ...why: ReadonlyArray<string>): ReadonlyArray<string> => why.filter(() => bad)
/** The matches of a whole-text pattern: its groups, or none. */
const groups = (text: string, pattern: RegExp): ReadonlyArray<string> => [...text.matchAll(new RegExp(pattern.source, "g"))].flatMap((match) => match.slice(1))

const listOf = (items: ReadonlyArray<string>): string => {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} or ${items.slice(-1).join("")}`
}

export const condition = (role: Role, when: When): string => {
  if (when === "otherwise") return "otherwise"
  return when.map((atom) => atomWords(role, atom)).join(", ")
}

export const verdictWhen = (rule: VerdictWhen, single: boolean): string => {
  if (single) return "always"
  if (rule.kind === "any") return `any item is ${listOf(rule.states.map((state) => STATE_NAME[state]))}`
  if (rule.kind === "only") return `every item is ${listOf(rule.states.map((state) => STATE_NAME[state]))}`
  return "otherwise"
}

export const verdictWord = (verdict: string): string => {
  if (verdict === "none") return "no verdict word"
  return `\`${verdict}\``
}

/** What a verdict writes, in words: its artifacts, then what they hold. */
export const writesText = (writes: Writes): string => {
  const files = writes.artifacts.map((artifact) => ARTIFACT_TEXT[artifact]).join(" and ")
  if (writes.contents.length === 0) return files
  return `${files}: ${writes.contents.map((content) => CONTENT_TEXT[content]).join(", and ")}`
}

const fieldsNote = (fields: ReadonlyArray<FieldText>): string => `${FIELDS_LEAD} ${fields.map((one) => `\`${one.id}\`: ${one.text}`).join("; ")}.`

const rowLine = (role: Role, row: Row): string => `| ${row.priority} | \`${row.id}\` | ${STATE_NAME[row.state]} | ${condition(role, row.when)} | ${row.label} |`
const verdictLine = (single: boolean, rule: VerdictRule): string =>
  `| ${rule.priority} | \`${rule.id}\` | ${verdictWord(rule.verdict)} | ${verdictWhen(rule.when, single)} | ${writesText(rule.writes)} |`
/** The states a role's `held` collection names an entry for. */
export const heldStates = (role: Role): ReadonlyArray<State> => HOLDS_BACK.filter((state) => hasState(role, state))

/** How many values a stop field takes, in the words a prompt carries: the one vocabulary written and read back. */
export const presenceWords = (role: Role, presence: Presence): string => {
  if (presence === "always") return "one"
  if (presence === "ifPrinted") return "one if printed, else none"
  return `one per item ${listOf(heldStates(role).map((state) => STATE_NAME[state]))}, naming it, else none`
}

const stopLines =
  (role: Role) =>
  (one: StopEvidence): ReadonlyArray<string> =>
    one.fields.map((field) => `| ${STOP_TEXT[one.stop]} | \`${field.id}\` | ${field.text} | ${presenceWords(role, field.presence)} |`)

/** A policy as the block a prompt carries. */
export const render = (policy: Policy): string =>
  [
    header(policy.role, policy.version),
    policy.intro,
    "",
    fieldsNote(policy.fields),
    "",
    FIRST_ROW,
    "",
    F1_HEADER,
    RULE5,
    ...policy.rows.map((row) => rowLine(policy.role, row)),
    "",
    FIRST_VERDICT,
    "",
    F2_HEADER,
    RULE5,
    ...policy.verdicts.map((rule) => verdictLine(policy.verdicts.length === 1, rule)),
    "",
    STOPS_LEAD,
    "",
    F3_HEADER,
    RULE4,
    ...policy.stops.flatMap(stopLines(policy.role)),
    END,
  ].join("\n")

/** A role's block from the source. */
export const block = (role: Role): string => render(project(role))

// ---- decoding ------------------------------------------------------------------------------------------------------

export type Decoded<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string }
export const ok = <A>(value: A): Decoded<A> => ({ ok: true, value })
export const fail = <A>(error: string): Decoded<A> => ({ ok: false, error })
const mapOk = <A, B>(got: Decoded<A>, f: (value: A) => B): Decoded<B> => {
  if (!got.ok) return fail(got.error)
  return ok(f(got.value))
}
const allOk = <A>(items: ReadonlyArray<Decoded<A>>): Decoded<ReadonlyArray<A>> => {
  const values: Array<A> = []
  for (const one of items) {
    if (!one.ok) return fail(one.error)
    values.push(one.value)
  }
  return ok(values)
}

const roleNamed = (text: string): ReadonlyArray<Role> => firstOf(ROLES, (role) => role === text)

/** Words read back as the longest vocabulary entries, separated by `separator`; every piece must be one. */
export const readList = <A extends string>(text: string, vocabulary: ReadonlyArray<readonly [A, string]>, separator: string): Decoded<ReadonlyArray<A>> => {
  const sorted = [...vocabulary].sort((a, b) => b[1].length - a[1].length)
  const out: Array<A> = []
  let rest = text
  while (rest.length > 0) {
    const at = rest
    const found = firstOf(sorted, ([, words]) => at.startsWith(words) && (at.length === words.length || at.startsWith(separator, words.length)))
    if (found.length === 0) return fail(`no entry reads "${rest}"`)
    for (const [id, words] of found) {
      out.push(id)
      rest = rest.slice(words.length + separator.length)
    }
  }
  if (text.endsWith(separator) || text.length === 0) return fail(`"${text}" is no list`)
  return ok(out)
}

/** A row's condition read back from its words. */
export const parseCondition = (role: Role, text: string): Decoded<When> => {
  if (text === "otherwise") return ok("otherwise")
  return readList(
    text,
    ATOMS.map((atom) => [atom, atomWords(role, atom)] as const),
    ", ",
  )
}

const readStates = (text: string): Decoded<ReadonlyArray<State>> => {
  const names = text.split(/, | or /)
  return allOk(
    names.map((name) => {
      const found = firstOf(STATES, (state) => STATE_NAME[state] === name)
      if (found.length === 0) return fail<State>(`no state is named "${name}"`)
      return ok(found[0] ?? "done")
    }),
  )
}

/** A verdict rule's condition read back from its words. */
export const parseVerdictWhen = (text: string): Decoded<VerdictWhen> => {
  if (text === "otherwise" || text === "always") return ok({ kind: "else" })
  if (text.startsWith("any item is ")) return mapOk(readStates(text.slice("any item is ".length)), (states): VerdictWhen => ({ kind: "any", states }))
  if (text.startsWith("every item is ")) return mapOk(readStates(text.slice("every item is ".length)), (states): VerdictWhen => ({ kind: "only", states }))
  return fail(`no verdict condition reads "${text}"`)
}

/** What a verdict writes, read back: artifacts joined by " and ", then ": " and contents joined by ", and ". */
export const parseWrites = (text: string): Decoded<Writes> => {
  const colon = text.indexOf(": ", text.lastIndexOf("`"))
  const artifacts = readList(
    text.slice(0, Math.max(colon, 0) + text.length * Number(colon < 0)),
    ARTIFACTS.map((one) => [one, ARTIFACT_TEXT[one]] as const),
    " and ",
  )
  if (!artifacts.ok) return fail(`artifacts: ${artifacts.error}`)
  if (colon < 0) return ok({ artifacts: artifacts.value, contents: [] })
  const contents = readList(
    text.slice(colon + 2),
    CONTENTS.map((one) => [one, CONTENT_TEXT[one]] as const),
    ", and ",
  )
  if (!contents.ok) return fail(`contents: ${contents.error}`)
  return ok({ artifacts: artifacts.value, contents: contents.value })
}

const cells = (line: string): ReadonlyArray<string> => line.slice(2, -2).split(" | ")
const fieldName = (cell: string): Decoded<string> => {
  const found = groups(cell, /^`([A-Za-z.]+)`$/)
  if (found.length !== 1) return fail(`"${cell}" is not a field name`)
  return ok(found.join(""))
}

/** The table rows under `head` and its rule line. */
const tableRows = (lines: ReadonlyArray<string>, head: string, rule: string): Decoded<ReadonlyArray<string>> => {
  if (lines[0] !== head || lines[1] !== rule) return fail(`no table headed ${head}`)
  const body = lines.slice(2)
  if (body.length === 0 || body.some((line) => !line.startsWith("| ") || !line.endsWith(" |"))) return fail(`the table headed ${head} has a row that is no row`)
  return ok(body)
}

interface Cells {
  readonly n: number
  readonly id: string
  readonly name: string
  readonly words: string
  readonly last: string
}
const cells5 = (line: string): Decoded<Cells> => {
  const parts = cells(line)
  if (parts.length !== 5) return fail(`a row with ${parts.length} cells: ${line}`)
  const [n = "", id = "", name = "", words = "", last = ""] = parts
  return mapOk(fieldName(id), (rule) => ({ n: Number(n), id: rule, name, words, last }))
}

const decodeRow = (role: Role, line: string): Decoded<Row> => {
  const got = cells5(line)
  if (!got.ok) return fail(got.error)
  const { n, id, name, words, last } = got.value
  const state = firstOf(STATES_OF[role], (one) => STATE_NAME[one] === name)
  const when = parseCondition(role, words)
  if (state.length === 0) return fail(`${role}: no state is named "${name}"`)
  if (!when.ok) return fail(`${role} row ${id}: ${when.error}`)
  return ok({ priority: n, id, state: state[0] ?? "done", when: when.value, label: last })
}

const decodeVerdict = (line: string): Decoded<VerdictRule> => {
  const got = cells5(line)
  if (!got.ok) return fail(got.error)
  const { n, id, name, words, last } = got.value
  const when = parseVerdictWhen(words)
  const writes = parseWrites(last)
  if (!when.ok) return fail(`verdict ${id}: ${when.error}`)
  if (!writes.ok) return fail(`verdict ${id}: ${writes.error}`)
  const verdict = name.replace(/^`(.*)`$/, "$1").replace(/^no verdict word$/, "none")
  return ok({ priority: n, id, verdict, when: when.value, writes: writes.value })
}

const stopLine = (role: Role, line: string): Decoded<{ readonly stop: Stop; readonly field: StopField }> => {
  const [name = "", id = "", text = "", count = ""] = cells(line)
  const stop = firstOf(STOPS_OF[role], (one) => STOP_TEXT[one] === name)
  const field = fieldName(id)
  const known = firstOf(STOP_FIELDS, (one) => field.ok && one === field.value)
  const presence = firstOf(PRESENCES, (one) => presenceWords(role, one) === count)
  if (cells(line).length !== 4 || stop.length === 0 || known.length === 0 || presence.length === 0) return fail(`${role}: no stop evidence row reads "${line}"`)
  return ok({ stop: stop[0] ?? "idle", field: { id: known[0] ?? "held", presence: presence[0] ?? "always", text } })
}

const decodeStops = (role: Role, lines: ReadonlyArray<string>): Decoded<ReadonlyArray<StopEvidence>> => {
  const read = allOk(lines.map((line) => stopLine(role, line)))
  if (!read.ok) return fail(read.error)
  const order = read.value.map((one) => one.stop).filter((stop, index, all) => all.indexOf(stop) === index)
  const runs = read.value.map((one) => one.stop).filter((stop, index, all) => index === 0 || all[index - 1] !== stop)
  if (runs.length !== order.length) return fail(`${role}: the rows of one stop are not together`)
  return ok(order.map((stop) => ({ stop, fields: read.value.filter((one) => one.stop === stop).map((one) => one.field) })))
}

const decodeField = (part: string): Decoded<FieldText> => {
  const [name = "", text = ""] = groups(part, /^`([a-z]+)`: ([\s\S]+)$/)
  const id = firstOf(FIELDS, (one) => one === name)
  if (id.length === 0 || text === "") return fail(`no evidence field reads "${part}"`)
  return ok({ id: id[0] ?? "waits", text })
}

const decodeFields = (note: string): Decoded<ReadonlyArray<FieldText>> => {
  if (!note.startsWith(`${FIELDS_LEAD} \``) || !note.endsWith(".")) return fail("the evidence fields' instruction is missing")
  const parts = note.slice(FIELDS_LEAD.length + 1, -1).split("; `")
  return allOk(parts.map((part, index) => decodeField(`${"`".repeat(Math.min(index, 1))}${part}`)))
}

const unique = (ids: ReadonlyArray<string>): ReadonlyArray<string> => ids.filter((id, index) => ids.indexOf(id) !== index).slice(0, 1)

/** The one block a text carries, or why it carries none or several. */
export const blockOf = (text: string): Decoded<string> => {
  const opens = text.split("<!-- round-policy v").length - 1
  const closes = text.split(END).length - 1
  if (text.includes("<!-- end-of-step")) return fail("an end-of-step block of an unknown version")
  if (opens !== 1 || closes !== 1) return fail(`${opens} policy blocks open and ${closes} close: exactly one of each`)
  const found = text.match(new RegExp(BLOCK.source, "g")) ?? []
  if (found.length !== 1) return fail("the policy block does not close after it opens")
  return ok(found.join(""))
}

const LEADS: ReadonlyArray<readonly [number, string]> = [
  [2, FIRST_ROW],
  [4, FIRST_VERDICT],
  [6, STOPS_LEAD],
]

interface Parts {
  readonly role: Role
  readonly paragraphs: ReadonlyArray<ReadonlyArray<string>>
}

const partsOf = (text: string): Decoded<Parts> => {
  const lines = text.split("\n")
  const [version = "", name = ""] = groups(lines[0] ?? "", HEADER)
  if (name === "" || lines.slice(-1).join("") !== END) return fail("no round-policy header and end")
  const role = roleNamed(name)
  if (Number(version) !== VERSION) return fail(`unknown round-policy version v${version}`)
  if (role.length === 0) return fail(`no role ${name}`)
  const paragraphs = lines
    .slice(1, -1)
    .join("\n")
    .split("\n\n")
    .map((one) => one.split("\n"))
  if (paragraphs.length !== 8) return fail(`${name}: ${paragraphs.length} paragraphs, not the policy's 8 (a stray clause or a lost table)`)
  const lead = LEADS.filter(([at, words]) => (paragraphs[at] ?? []).join("\n") !== words)
  if (lead.length > 0) return fail(`${name}: "${lead.map(([, words]) => words).join("")}" is not where it stands`)
  if ((paragraphs[0] ?? []).length !== 1) return fail(`${name}: the intro is not one line`)
  return ok({ role: role[0] ?? "worker", paragraphs })
}

/** A block read back into a Policy: strict, or the first reason it is not one. */
export const decode = (text: string): Decoded<Policy> => {
  const got = partsOf(text)
  if (!got.ok) return fail(got.error)
  const { role, paragraphs } = got.value
  const [intro = [], note = [], , f1 = [], , f2 = [], , f3 = []] = paragraphs
  const tables = allOk([tableRows(f1, F1_HEADER, RULE5), tableRows(f2, F2_HEADER, RULE5), tableRows(f3, F3_HEADER, RULE4)])
  if (!tables.ok) return fail(tables.error)
  const [rowLines = [], verdictLines = [], stopRows = []] = tables.value
  const fields = decodeFields(note.join("\n"))
  const rows = allOk(rowLines.map((line) => decodeRow(role, line)))
  const verdicts = allOk(verdictLines.map(decodeVerdict))
  const stops = decodeStops(role, stopRows)
  if (!fields.ok) return fail(fields.error)
  if (!rows.ok) return fail(rows.error)
  if (!verdicts.ok) return fail(verdicts.error)
  if (!stops.ok) return fail(stops.error)
  return checked({ version: VERSION, role, intro: intro.join(""), fields: fields.value, rows: rows.value, verdicts: verdicts.value, stops: stops.value })
}

const misnumbered = (numbers: ReadonlyArray<number>): boolean => numbers.some((n, index) => n !== index + 1)

/** The structural rules every policy keeps, whatever its source: numbering, unique ids, the catch-all last. */
export const checked = (policy: Policy): Decoded<Policy> => {
  const faults = [
    ...iff(misnumbered(policy.rows.map((row) => row.priority)), "the rows are not numbered 1, 2, … in order"),
    ...iff(misnumbered(policy.verdicts.map((rule) => rule.priority)), "the verdict rules are not numbered 1, 2, … in order"),
    ...unique(policy.rows.map((row) => row.id)).map((id) => `rule ${id} stands twice`),
    ...unique(policy.verdicts.map((rule) => rule.id)).map((id) => `verdict ${id} stands twice`),
    ...unique(policy.fields.map((field) => field.id)).map((id) => `field ${id} stands twice`),
    ...unique(policy.stops.map((one) => one.stop)).map((stop) => `stop ${stop} stands twice`),
    ...iff(policy.rows.findIndex((row) => row.when === "otherwise") !== policy.rows.length - 1, "the catch-all is not the last row"),
  ]
  if (faults.length > 0) return fail(`${policy.role}: ${faults.join("; ")}`)
  return ok(policy)
}

// ---- comparing: typed and member by member; text is made only to show a difference, never to find one ---------------

const eq = <A>(a: A, b: A): boolean => a === b
/** Two lists equal element by element, in order. */
const sameList = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>, same: (x: A, y: A) => boolean): boolean =>
  a.length === b.length && a.every((x, index) => b.slice(index, index + 1).every((y) => same(x, y)))

const sameWhen = (a: When, b: When): boolean => {
  if (a === "otherwise" || b === "otherwise") return a === b
  return sameList(a, b, eq)
}
const sameVerdictWhen = (a: VerdictWhen, b: VerdictWhen): boolean => {
  if (a.kind === "else" || b.kind === "else") return a.kind === b.kind
  return a.kind === b.kind && sameList(a.states, b.states, eq)
}
const sameWrites = (a: Writes, b: Writes): boolean => sameList(a.artifacts, b.artifacts, eq) && sameList(a.contents, b.contents, eq)
const sameRow = (a: Row, b: Row): boolean => a.priority === b.priority && a.id === b.id && a.state === b.state && sameWhen(a.when, b.when) && a.label === b.label
const sameRule = (a: VerdictRule, b: VerdictRule): boolean =>
  a.priority === b.priority && a.id === b.id && a.verdict === b.verdict && sameVerdictWhen(a.when, b.when) && sameWrites(a.writes, b.writes)
const sameStopField = (a: StopField, b: StopField): boolean => a.id === b.id && a.presence === b.presence && a.text === b.text
const sameStops = (a: StopEvidence, b: StopEvidence): boolean => a.stop === b.stop && sameList(a.fields, b.fields, sameStopField)
const sameFieldText = (a: FieldText, b: FieldText): boolean => a.id === b.id && a.text === b.text

const whenText = (when: VerdictWhen): string => {
  if (when.kind === "else") return "else"
  return `${when.kind} ${when.states.join(",")}`
}
const rowText = (role: Role) => (row: Row) => `${row.priority} ${row.state} [${condition(role, row.when)}] ${row.label}`
const ruleText = (rule: VerdictRule) => `${rule.priority} ${rule.verdict} when ${whenText(rule.when)} writes ${rule.writes.artifacts.join(",")} / ${rule.writes.contents.join(",")}`
const stopsText = (one: StopEvidence) => one.fields.map((field) => `${field.id} (${field.presence}): ${field.text}`).join("; ")

/** One kind of part of a policy, compared by id and then member by member; each line names the part and both values. */
const partDifferences = <A>(
  kind: string,
  ours: ReadonlyArray<A>,
  theirs: ReadonlyArray<A>,
  id: (part: A) => string,
  same: (a: A, b: A) => boolean,
  show: (part: A) => string,
): ReadonlyArray<string> => [
  ...iff(!sameList(ours.map(id), theirs.map(id), eq), `${kind}s: source ${ours.map(id).join(", ")}, shown ${theirs.map(id).join(", ")}`),
  ...ours.flatMap((part) => {
    const other = theirs.filter((one) => id(one) === id(part))
    if (other.length === 0) return [`${kind} ${id(part)}: source ${show(part)}, shown none`]
    return other.flatMap((one) => iff(!same(part, one), `${kind} ${id(part)}: source ${show(part)}, shown ${show(one)}`))
  }),
  ...theirs.flatMap((part) => iff(!ours.some((one) => id(one) === id(part)), `${kind} ${id(part)}: source none, shown ${show(part)}`)),
]

/** Every part of a shown policy that differs from the source, each named with both values. */
export const differences = (source: Policy, shown: Policy): ReadonlyArray<string> => [
  ...iff(source.role !== shown.role, `role: source ${source.role}, shown ${shown.role}`),
  ...iff(source.version !== shown.version, `version: source v${source.version}, shown v${shown.version}`),
  ...iff(source.intro !== shown.intro, `intro: source ${source.intro}, shown ${shown.intro}`),
  ...partDifferences("field", source.fields, shown.fields, (one) => one.id, sameFieldText, (one) => one.text),
  ...partDifferences("row", source.rows, shown.rows, (one) => one.id, sameRow, rowText(source.role)),
  ...partDifferences("verdict", source.verdicts, shown.verdicts, (one) => one.id, sameRule, ruleText),
  ...partDifferences("stop", source.stops, shown.stops, (one) => one.stop, sameStops, stopsText),
]

/** Every way a delivered text's policy is not the role's source: block count, decoding, each part, then the bytes. */
export const policyFaults = (role: Role, text: string): ReadonlyArray<string> => {
  const found = blockOf(text)
  if (!found.ok) return [`${role}: ${found.error}`]
  const shown = decode(found.value)
  // A decode error that already names the role is not prefixed twice.
  if (!shown.ok) return [`${role}: ${shown.error.replace(new RegExp(`^${role}:? `), "")}`]
  const parts = differences(project(role), shown.value).map((line) => `${role}: ${line}`)
  if (parts.length > 0) return parts
  // The canonical-bytes check compares rendered text on purpose: it is the rendering itself being checked.
  if (found.value !== block(role)) return [`${role}: the block's bytes are not the source's canonical rendering`]
  return []
}

/** The policy a delivered text carries, once it matches the source, or every fault. */
export const delivered = (role: Role, text: string): Decoded<Policy> => {
  const faults = policyFaults(role, text)
  if (faults.length > 0) return fail(faults.join("; "))
  return ok(project(role))
}

// ---- evidence: what a record owes, and what a hand-back gives ------------------------------------------------------

const sameOutput = (a: Output, b: Output): boolean => {
  if (a.kind === "missing" || b.kind === "missing") return a.kind === "missing" && b.kind === "missing" && a.why === b.why
  return a.kind === b.kind && a.digest === b.digest
}
const sameForm = (a: Form, b: Form): boolean => {
  if (a.kind === "named" && b.kind === "named") return a.form === b.form
  if (a.kind === "allow" && b.kind === "allow") return a.allow === b.allow
  return a.kind === "none" && b.kind === "none"
}
const sameRun = (a: Run, b: Run): boolean =>
  a.id === b.id && a.command === b.command && sameOutput(a.output, b.output) && a.exit === b.exit && a.receipt === b.receipt && a.head === b.head && a.result === b.result
const samePending = (a: Pending, b: Pending): boolean => a.id === b.id && a.command === b.command && a.status === b.status && sameOutput(a.output, b.output)
const sameRefusal = (a: Refusal, b: Refusal): boolean => a.what === b.what && a.scope === b.scope && a.report === b.report && sameForm(a.form, b.form)
const sameAbsent = (a: Absent, b: Absent): boolean => a.tool === b.tool && a.probe === b.probe && sameOutput(a.output, b.output)

/** Two evidence fields equal member by member: the kind, then every value it holds. */
export const sameField = (a: Field, b: Field): boolean => {
  if (a.field === "completed" && b.field === "completed") return sameRun(a.run, b.run)
  if (a.field === "current" && b.field === "current") return samePending(a.attempt, b.attempt)
  if (a.field === "refused" && b.field === "refused") return sameRefusal(a.refusal, b.refusal)
  if (a.field === "cannot" && b.field === "cannot") return sameAbsent(a.absent, b.absent)
  if (a.field === "waits" && b.field === "waits") return a.ref === b.ref
  return false
}

/** Each value as written: `plain` as it is, `quoted` in double quotes with `\` and `"` escaped, so no two values show alike. */
type Show = (text: string) => string
const plain: Show = (text) => text
const quoted: Show = (text) => `"${text.replaceAll("\\", "\\\\").replaceAll(`"`, `\\"`)}"`
const outputText = (output: Output, show: Show = plain): string => {
  if (output.kind === "missing") return `missing ${output.why}`
  return `${output.kind} ${show(output.digest)}`
}
const formText = (form: Form, show: Show = plain): string => {
  if (form.kind === "none") return "none"
  if (form.kind === "allow") return `allow ${show(form.allow)}`
  return `named ${show(form.form)}`
}
const fieldLine = (field: Field, show: Show): string => {
  if (field.field === "completed") {
    const { id, command, output, exit, receipt, head, result } = field.run
    return `completed id=${show(id)} command=${show(command)} output=${outputText(output, show)} exit=${exit} receipt=${show(receipt)} head=${show(head)} result=${result}`
  }
  if (field.field === "current") {
    const { id, command, status, output } = field.attempt
    return `current id=${show(id)} command=${show(command)} status=${status} output=${outputText(output, show)}`
  }
  if (field.field === "refused") {
    const { what, scope, report, form } = field.refusal
    return `refused what=${show(what)} scope=${show(scope)} report=${show(report)} form=${formText(form, show)}`
  }
  if (field.field === "cannot") return `cannot tool=${show(field.absent.tool)} probe=${show(field.absent.probe)} output=${outputText(field.absent.output, show)}`
  return `waits ref=${show(field.ref)}`
}
/**
 * A field's values as one plain line, for reading. Not injective (a value may hold ` command=`), so it is never
 * compared: `sameField` compares, and a judged difference is shown by `fieldShown`.
 */
export const fieldKey = (field: Field): string => fieldLine(field, plain)
/** A field's values as one line with every value quoted and escaped: how a judged difference is shown. */
export const fieldShown = (field: Field): string => fieldLine(field, quoted)

/** Each a string with a character other than white space: an empty or missing value is no value. */
const filled = (...texts: ReadonlyArray<string>): boolean => texts.every((one) => one === String(one) && one.trim().length > 0)
const isFlag = (value: boolean): boolean => value === true || value === false

/** The keys each evidence value may hold: a key beyond them is a flag standing in for evidence. */
const KEYS = {
  completed: ["field", "run"],
  current: ["field", "attempt"],
  refused: ["field", "refusal"],
  cannot: ["field", "absent"],
  waits: ["field", "ref"],
  run: ["id", "command", "output", "exit", "receipt", "head", "result"],
  pending: ["id", "command", "status", "output"],
  refusal: ["what", "scope", "report", "form"],
  absent: ["tool", "probe", "output"],
  named: ["kind", "form"],
  none: ["kind"],
  allow: ["kind", "allow"],
} as const satisfies { readonly [K in string]: ReadonlyArray<string> }
const extraKeys = (keys: ReadonlyArray<string>, known: ReadonlyArray<string>): ReadonlyArray<string> =>
  keys.filter((key) => !known.includes(key))

/** The keys a field holds beyond its shape, its own and its nested value's. */
const keyFaults = (field: Field): ReadonlyArray<string> => {
  const extra = (inner: ReadonlyArray<string>) => [...extraKeys(Object.keys(field), KEYS[field.field]), ...inner]
  if (field.field === "completed") return extra(extraKeys(Object.keys(field.run), KEYS.run))
  if (field.field === "current") return extra(extraKeys(Object.keys(field.attempt), KEYS.pending))
  if (field.field === "refused") return extra([...extraKeys(Object.keys(field.refusal), KEYS.refusal), ...extraKeys(Object.keys(field.refusal.form), KEYS[field.refusal.form.kind])])
  if (field.field === "cannot") return extra(extraKeys(Object.keys(field.absent), KEYS.absent))
  return extra([])
}

const unknownKeys = (field: Field): ReadonlyArray<string> => {
  const keys = keyFaults(field)
  return iff(keys.length > 0, `\`${field.field}\` holds unknown keys [${keys.join(", ")}]: no flag stands in for evidence`)
}

// ---- the trace: an item's history, the contract's input --------------------------------------------------------------

/** Whose the item is: assigned work (required, or a verifier's optional probe), or a finding outside the assignment. */
export type Assignment = { readonly kind: "assigned"; readonly required: boolean } | { readonly kind: "found"; readonly provenance: Provenance }

/**
 * One event of an item's history, each about the attempt it names. An attempt begins (`begin`), may have partial
 * output observed (`observe`), and ends completed (`finish`: its command's exit, output, receipt and head), interrupted
 * (`interrupt`), or answered by a refusal (`deny`: of the running attempt, or of a new one that never started). Every
 * refusal is of an attempt: a denied read or git command while working the item is that item's attempt, never started.
 * A refusal lifts (`lift`); the host loses and regains the check's tool (`hostLost`, `hostBack`); a wait opens and closes
 * (`waitOpen`, `waitClose`); a verifier's unclear result stays unclear once no retry can settle it (`settle`).
 */
export type TraceEvent =
  | { readonly kind: "begin"; readonly attempt: string; readonly command: string }
  | { readonly kind: "observe"; readonly attempt: string; readonly digest: string }
  | { readonly kind: "finish"; readonly attempt: string; readonly result: Result; readonly exit: number; readonly output: Output; readonly receipt: string; readonly head: string }
  | { readonly kind: "interrupt"; readonly attempt: string; readonly output: Output }
  | { readonly kind: "deny"; readonly attempt: string; readonly command: string; readonly refusal: Refusal }
  | { readonly kind: "lift" }
  | { readonly kind: "hostLost"; readonly absent: Absent }
  | { readonly kind: "hostBack" }
  | { readonly kind: "waitOpen"; readonly ref: string }
  | { readonly kind: "waitClose" }
  | { readonly kind: "settle" }
export const TRACE_EVENTS = ["begin", "observe", "finish", "interrupt", "deny", "lift", "hostLost", "hostBack", "waitOpen", "waitClose", "settle"] as const satisfies ReadonlyArray<TraceEvent["kind"]>

/** An item's whole history within a step: what the contract reads, and what a later unit stores. */
export interface Trace {
  readonly id: string
  readonly assignment: Assignment
  readonly events: ReadonlyArray<TraceEvent>
}

/** Where a trace stands after each event: at most one of each (an empty list is none). */
interface Folding {
  readonly settled: boolean
  readonly run: ReadonlyArray<Run>
  readonly pending: ReadonlyArray<Pending>
  readonly refusal: ReadonlyArray<Refusal>
  readonly absent: ReadonlyArray<Absent>
  readonly waits: ReadonlyArray<string>
  readonly attempts: ReadonlyArray<string>
}

const running = (at: Folding, attempt: string): boolean => at.pending.some((one) => one.status === "started" && one.id === attempt)
/** A running attempt, or one interrupted whose result still arrives (a late result): never a denied one, which never started. */
const finishable = (at: Folding, attempt: string): boolean => at.pending.some((one) => one.status !== "denied" && one.id === attempt)
const runningAny = (at: Folding): boolean => at.pending.some((one) => one.status === "started")
const free = (at: Folding): boolean => at.refusal.length === 0 && at.absent.length === 0 && at.waits.length === 0
const fresh = (at: Folding, attempt: string): boolean => filled(attempt) && !at.attempts.includes(attempt)
const settles = (role: Role, result: Result): boolean => result === "pass" || (role === "verifier" && result === "fail")
const commandOf = (at: Folding, attempt: string): ReadonlyArray<string> => at.pending.flatMap((one) => [one.command].filter(() => one.id === attempt))

const refusalOk = (refusal: Refusal): boolean =>
  filled(refusal.what, refusal.scope, refusal.report) && (refusal.form.kind === "none" || (refusal.form.kind === "named" && filled(refusal.form.form)) || (refusal.form.kind === "allow" && filled(refusal.form.allow)))
/** A finished attempt's output is its log, or the typed word that it ran with no authenticated evidence: never "not started". */
const finishedOutput = (output: Output): boolean => (output.kind === "log" && filled(output.digest)) || (output.kind === "missing" && output.why === "missing-authenticated-evidence")
const interruptedOutput = (output: Output): boolean => (output.kind === "partial" && filled(output.digest)) || (output.kind === "missing" && output.why === "interrupted")

type Next = Decoded<Folding>

const attemptStep = (role: Role, at: Folding, event: TraceEvent): Next => {
  if (event.kind === "begin") {
    if (!free(at) || runningAny(at) || !fresh(at, event.attempt) || !filled(event.command)) return fail("an attempt begins only while nothing holds the item, none runs, and with a new id and its command")
    const pending: Pending = { id: event.attempt, command: event.command, status: "started", output: { kind: "missing", why: "missing-authenticated-evidence" } }
    return ok({ ...at, pending: [pending], attempts: [...at.attempts, event.attempt] })
  }
  if (event.kind === "observe") {
    if (!running(at, event.attempt) || !filled(event.digest)) return fail("output is observed only of the running attempt")
    return ok({ ...at, pending: at.pending.map((one) => ({ ...one, output: { kind: "partial", digest: event.digest } })) })
  }
  if (event.kind === "finish") {
    if (!finishable(at, event.attempt) || !RESULTS.includes(event.result) || !Number.isInteger(event.exit) || !finishedOutput(event.output) || !filled(event.receipt, event.head))
      return fail("only the current attempt, running or interrupted, finishes, with its result, exit, output (a log, or no authenticated evidence), receipt and head")
    const run: Run = { id: event.attempt, command: commandOf(at, event.attempt).join(""), output: event.output, exit: event.exit, receipt: event.receipt, head: event.head, result: event.result }
    const settled = settles(role, event.result)
    // A result that settles the item leaves nothing for a host loss or a wait opened during the run to hold back.
    const cleared = { absent: at.absent.filter(() => !settled), waits: at.waits.filter(() => !settled) }
    return ok({ ...at, ...cleared, run: [run], pending: [], settled })
  }
  if (event.kind === "interrupt") {
    if (!running(at, event.attempt) || !interruptedOutput(event.output)) return fail("only the running attempt is interrupted, with its partial output or the word that it was interrupted")
    return ok({ ...at, pending: at.pending.map((one) => ({ ...one, status: "interrupted", output: event.output })) })
  }
  return denyStep(at, event)
}

const denyStep = (at: Folding, event: TraceEvent): Next => {
  if (event.kind !== "deny") return fail("no such event")
  const ofRunning = running(at, event.attempt) && commandOf(at, event.attempt).includes(event.command)
  const ofNew = !runningAny(at) && fresh(at, event.attempt) && filled(event.command)
  if (at.refusal.length > 0 || (!ofRunning && !ofNew) || !refusalOk(event.refusal))
    return fail("a refusal answers the running attempt or a new one, while no refusal holds the item, with what, scope, report and remedy")
  const pending: Pending = { id: event.attempt, command: event.command, status: "denied", output: { kind: "missing", why: "not-started" } }
  return ok({ ...at, pending: [pending], refusal: [event.refusal], attempts: [...at.attempts.filter((one) => one !== event.attempt), event.attempt] })
}

const obstacleStep = (role: Role, at: Folding, event: TraceEvent): Next => {
  if (event.kind === "lift") return iffOk(at.refusal.length > 0, { ...at, refusal: [] }, "only a refusal that holds the item lifts")
  if (event.kind === "hostLost") {
    const { tool, probe, output } = event.absent
    return iffOk(at.absent.length === 0 && filled(tool, probe) && finishedOutput(output), { ...at, absent: [event.absent] }, "the host loses a tool once, shown by its probe and the probe's output")
  }
  if (event.kind === "hostBack") return iffOk(at.absent.length > 0, { ...at, absent: [] }, "only a lost tool comes back")
  if (event.kind === "waitOpen") return iffOk(at.waits.length === 0 && filled(event.ref), { ...at, waits: [event.ref] }, "a wait opens once, on its ref")
  if (event.kind === "waitClose") return iffOk(at.waits.length > 0, { ...at, waits: [] }, "only an open wait closes")
  const unclear = role === "verifier" && at.run.some((one) => one.result === "unclear") && !runningAny(at) && free(at)
  return iffOk(unclear, { ...at, settled: true }, "only a verifier's unclear result, with no attempt running and nothing holding it, settles as unclear")
}

const iffOk = (good: boolean, next: Folding, why: string): Next => {
  if (good) return ok(next)
  return fail(why)
}

const ATTEMPT_EVENTS: ReadonlyArray<TraceEvent["kind"]> = ["begin", "observe", "finish", "interrupt", "deny"]

/** One event after the trace so far: the next standing, or why the event cannot happen there. */
const stepTrace = (role: Role, at: Folding, event: TraceEvent): Next => {
  if (!TRACE_EVENTS.includes(event.kind)) return fail("no such event")
  if (!wellFormed(event)) return fail(`the event holds other members than a ${event.kind} event's`)
  if (at.settled) return fail("the item is settled: no event follows")
  if (ATTEMPT_EVENTS.includes(event.kind)) return attemptStep(role, at, event)
  return obstacleStep(role, at, event)
}

/** The members each event holds, exactly: a stored trace read back is checked before any member is read. */
const EVENT_KEYS = {
  begin: ["kind", "attempt", "command"],
  observe: ["kind", "attempt", "digest"],
  finish: ["kind", "attempt", "result", "exit", "output", "receipt", "head"],
  interrupt: ["kind", "attempt", "output"],
  deny: ["kind", "attempt", "command", "refusal"],
  lift: ["kind"],
  hostLost: ["kind", "absent"],
  hostBack: ["kind"],
  waitOpen: ["kind", "ref"],
  waitClose: ["kind"],
  settle: ["kind"],
} as const satisfies { readonly [K in TraceEvent["kind"]]: ReadonlyArray<string> }
const OUTPUT_KEYS = { log: ["kind", "digest"], partial: ["kind", "digest"], missing: ["kind", "why"] } as const
const FORM_KEYS = { named: KEYS.named, none: KEYS.none, allow: KEYS.allow } as const

/** A value's own members, none for a value that is no object (a member missing from a stored event). */
const membersOf = (value: Output | Refusal | Absent | Form | TraceEvent): ReadonlyArray<string> => Object.keys(Object(value)).sort()
const exactly = (value: Output | Refusal | Absent | Form | TraceEvent, keys: ReadonlyArray<string>): boolean => sameList(membersOf(value), [...keys].sort(), eq)
const kindKeys = (table: { readonly [kind: string]: ReadonlyArray<string> }, value: Output | Form): boolean =>
  Object.entries(table).some(([kind, keys]) => membersOf(value).includes("kind") && kind === value.kind && exactly(value, keys))
const outputWell = (output: Output): boolean => kindKeys(OUTPUT_KEYS, Object(output))
const refusalWell = (refusal: Refusal): boolean => exactly(refusal, KEYS.refusal) && kindKeys(FORM_KEYS, Object(refusal).form)
const absentWell = (absent: Absent): boolean => exactly(absent, KEYS.absent) && outputWell(Object(absent).output)

/** An event holding exactly its kind's members, each nested value exactly its own. */
const wellFormed = (event: TraceEvent): boolean => {
  const own = Object.entries(EVENT_KEYS).some(([kind, keys]) => kind === event.kind && exactly(event, keys))
  if (!own) return false
  if (event.kind === "finish" || event.kind === "interrupt") return outputWell(event.output)
  if (event.kind === "deny") return refusalWell(event.refusal)
  if (event.kind === "hostLost") return absentWell(event.absent)
  return true
}

const START: Folding = { settled: false, run: [], pending: [], refusal: [], absent: [], waits: [], attempts: [] }

const assignmentFaults = (role: Role, trace: Trace): ReadonlyArray<string> => {
  const { assignment } = trace
  if (assignment.kind === "assigned") return iff(!assignment.required && role !== "verifier", "only a verifier has optional work (a wider probe)")
  const found = role === "verifier" && (assignment.provenance === "unit" || assignment.provenance === "base")
  return [
    ...iff(!found && !(role !== "verifier" && assignment.provenance === "none"), "a verifier's finding is the unit's or the base's; another role's has no provenance"),
    ...iff(trace.events.length > 0, "a finding outside the assignment is settled as found: no event follows"),
  ]
}

const factsOf = (assignment: Assignment, at: Folding): Facts => {
  const assigned = assignment.kind === "assigned"
  return {
    assigned,
    required: assignment.kind === "assigned" && assignment.required,
    attempt: attemptOf(at),
    settled: !assigned || at.settled,
    refused: at.refusal.length > 0,
    hostCannot: at.absent.length > 0,
    wait: at.waits.length > 0,
    provenance: provenanceOf(assignment),
  }
}
const attemptOf = (at: Folding): Attempt => {
  for (const run of at.run) return run.result
  if (at.pending.length > 0) return "started"
  return "never"
}
const provenanceOf = (assignment: Assignment): Provenance => {
  if (assignment.kind === "found") return assignment.provenance
  return "none"
}

const fieldsOf = (at: Folding): ReadonlyArray<Field> => [
  ...at.run.map((run): Field => ({ field: "completed", run })),
  ...at.pending.map((attempt): Field => ({ field: "current", attempt })),
  ...at.refusal.map((refusal): Field => ({ field: "refused", refusal })),
  ...at.absent.map((absent): Field => ({ field: "cannot", absent })),
  ...at.waits.map((ref): Field => ({ field: "waits", ref })),
]

/**
 * The record a trace folds to: what the rows read, beside the trace it is the fold of. Only `fold` makes one: the class
 * is not exported and its private member makes the type nominal, so no literal or other object can stand for it.
 */
class FoldOf {
  constructor(
    readonly role: Role,
    readonly record: ItemRecord,
    private readonly source: Trace,
  ) {}
  /** The history this record is the fold of: what a later unit stores. */
  get trace(): Trace {
    return this.source
  }
}
export type Folded = FoldOf

/** The record an item's trace leaves, or the first event that cannot happen where it stands (a typed rejection). */
export const fold = (role: Role, trace: Trace): Decoded<Folded> => {
  const assigned = assignmentFaults(role, trace)
  if (!filled(trace.id)) return fail("the item has no id")
  if (assigned.length > 0) return fail(`${trace.id}: ${assigned.join("; ")}`)
  let at: Folding = START
  for (const [index, event] of trace.events.entries()) {
    const next = stepTrace(role, at, event)
    if (!next.ok) return fail(`${trace.id}: event ${index + 1} (${event.kind}): ${next.error}`)
    at = next.value
  }
  return ok(new FoldOf(role, { id: trace.id, facts: factsOf(trace.assignment, at), fields: fieldsOf(at) }, trace))
}

// ---- a record from outside: decoded into the trace it must be the fold of ---------------------------------------------

/** One kind of evidence a record holds, each value as its field carries it. */
const runOf = (field: Field): ReadonlyArray<Run> => {
  if (field.field === "completed") return [field.run]
  return []
}
const pendingOf = (field: Field): ReadonlyArray<Pending> => {
  if (field.field === "current") return [field.attempt]
  return []
}
const refusalOf = (field: Field): ReadonlyArray<Refusal> => {
  if (field.field === "refused") return [field.refusal]
  return []
}
const absentOf = (field: Field): ReadonlyArray<Absent> => {
  if (field.field === "cannot") return [field.absent]
  return []
}
const waitOf = (field: Field): ReadonlyArray<string> => {
  if (field.field === "waits") return [field.ref]
  return []
}
const runsIn = (record: ItemRecord) => record.fields.flatMap(runOf)
const pendingIn = (record: ItemRecord) => record.fields.flatMap(pendingOf)
const refusalsIn = (record: ItemRecord) => record.fields.flatMap(refusalOf)
const absentIn = (record: ItemRecord) => record.fields.flatMap(absentOf)
const waitsIn = (record: ItemRecord) => record.fields.flatMap(waitOf)
const observedOf = (attempt: Pending): ReadonlyArray<TraceEvent> => {
  if (attempt.output.kind === "partial") return [{ kind: "observe", attempt: attempt.id, digest: attempt.output.digest }]
  return []
}


/** The refusal a lifted denial answered: not in the record (a lifted refusal leaves none), so any well-formed one witnesses it. */
const liftedWitness = (attempt: Pending): Refusal => ({ what: attempt.command, scope: attempt.command, report: attempt.id, form: { kind: "none" } })

const pendingEvents = (record: ItemRecord, attempt: Pending): ReadonlyArray<TraceEvent> => {
  const begin: TraceEvent = { kind: "begin", attempt: attempt.id, command: attempt.command }
  if (attempt.status === "interrupted") return [begin, { kind: "interrupt", attempt: attempt.id, output: attempt.output }]
  if (attempt.status === "denied") {
    const refusals = refusalsIn(record)
    const deny = (refusal: Refusal): TraceEvent => ({ kind: "deny", attempt: attempt.id, command: attempt.command, refusal })
    if (refusals.length > 0) return refusals.map(deny)
    return [deny(liftedWitness(attempt)), { kind: "lift" }]
  }
  return [begin, ...observedOf(attempt)]
}

/**
 * The one trace a record can be the fold of: its completed attempt, then its current one (a refusal is of it), its
 * settling as unclear, then what holds the item. A record is accepted only when this trace folds back to it exactly, so a record no history
 * leaves (a refusal with its denied attempt dropped, an attempt after a settled pass, a finished run that never
 * started) is rejected by the event that cannot happen or by the field the fold does not leave.
 */
export const traceOf = (record: ItemRecord): Trace => {
  const { facts } = record
  if (!facts.assigned) return { id: record.id, assignment: { kind: "found", provenance: facts.provenance }, events: [] }
  const completed = runsIn(record).flatMap((run): ReadonlyArray<TraceEvent> => [
    { kind: "begin", attempt: run.id, command: run.command },
    { kind: "finish", attempt: run.id, result: run.result, exit: run.exit, output: run.output, receipt: run.receipt, head: run.head },
  ])
  const settle: ReadonlyArray<TraceEvent> = [{ kind: "settle" } as const].filter(() => facts.settled && facts.attempt === "unclear")
  const holds: ReadonlyArray<TraceEvent> = [
    ...absentIn(record).map((absent): TraceEvent => ({ kind: "hostLost", absent })),
    ...waitsIn(record).map((ref): TraceEvent => ({ kind: "waitOpen", ref })),
  ]
  const current = pendingIn(record).flatMap((attempt) => pendingEvents(record, attempt))
  return { id: record.id, assignment: { kind: "assigned", required: facts.required }, events: [...completed, ...current, ...settle, ...holds] }
}

const FACT_KEYS = ["assigned", "required", "attempt", "settled", "refused", "hostCannot", "wait", "provenance"] as const satisfies ReadonlyArray<keyof Facts>

/** Every way a record differs from the fold of its trace, member by member. */
const foldDifferences = (record: ItemRecord, folded: ItemRecord): ReadonlyArray<string> => [
  ...FACT_KEYS.flatMap((key) => iff(record.facts[key] !== folded.facts[key], `facts.${key}: the record says ${String(record.facts[key])}, its history leaves ${String(folded.facts[key])}`)),
  ...record.fields.flatMap((field) => iff(!folded.fields.some((one) => sameField(one, field)), `\`${field.field}\` ${fieldShown(field)}: no history leaves it beside the record's other fields`)),
  ...folded.fields.flatMap((field) => iff(!record.fields.some((one) => sameField(one, field)), `\`${field.field}\`: the record lacks ${fieldShown(field)}, which its history leaves`)),
]

/** A record from outside read as the fold of a trace: accepted only when some history leaves exactly it. */
export const decodeRecord = (role: Role, record: ItemRecord): Decoded<Folded> => {
  const keys = record.fields.flatMap(unknownKeys)
  const doubled = unique(record.fields.map((one) => one.field)).map((id) => `\`${id}\` stands twice`)
  const flags = [record.facts.assigned, record.facts.required, record.facts.settled, record.facts.refused, record.facts.hostCannot, record.facts.wait].every(isFlag)
  const known = flags && ATTEMPTS.includes(record.facts.attempt) && PROVENANCES.includes(record.facts.provenance) && record.fields.every((one) => FIELDS.includes(one.field))
  if (!known) return fail(`${record.id}: the record's facts or fields are not an item's`)
  if (keys.length > 0 || doubled.length > 0) return fail(`${record.id}: ${[...keys, ...doubled].join("; ")}`)
  const folded = fold(role, traceOf(record))
  if (!folded.ok) return fail(`${folded.error} (the only history the record could be the fold of)`)
  const off = foldDifferences(record, folded.value.record)
  if (off.length > 0) return fail(`${record.id}: ${off.join("; ")}`)
  return folded
}

/** Why a record is the fold of no history this role can have: empty when it is one. */
export const recordFaults = (role: Role, record: ItemRecord): ReadonlyArray<string> => {
  const got = decodeRecord(role, record)
  if (got.ok) return []
  return [got.error]
}

// ---- the hand-back an item owes ---------------------------------------------------------------------------------------

/** The first row of a policy true of an item with these atoms (the catch-all when none above is). */
export const decide = (policy: Policy, atoms: ReadonlySet<Atom>): ReadonlyArray<Row> => firstOf(policy.rows, (row) => row.when === "otherwise" || row.when.every((atom) => atoms.has(atom)))

/** What a hand-back must hold for one item: the row's rule and label, and every evidence field its trace leaves. */
export interface Due {
  readonly item: string
  readonly rule: string
  readonly state: State
  readonly label: string
  readonly fields: ReadonlyArray<Field>
}
export interface HandBack {
  readonly item: string
  readonly rule: string
  readonly label: string
  readonly fields: ReadonlyArray<Field>
}

/** The first of `items`, or `why` when there is none. */
const firstFound = <A>(items: ReadonlyArray<A>, why: string): Decoded<A> => {
  for (const one of items) return ok(one)
  return fail(why)
}

/** The hand-back a policy owes for a folded item. */
export const dueOf = (policy: Policy, folded: Folded): Decoded<Due> => {
  const { record } = folded
  if (folded.role !== policy.role) return fail(`${record.id}: folded for a ${folded.role}, judged for a ${policy.role}`)
  const named = policy.fields.map((field) => field.id)
  const rows = decide(policy, truths([record.facts])).map((row) => ({
    item: record.id,
    rule: row.id,
    state: row.state,
    label: row.label,
    fields: record.fields.filter((field) => named.includes(field.field)),
  }))
  return firstFound(rows, `${record.id}: no row is true`)
}

/** The hand-back a policy owes for an item's trace, or the typed rejection of a trace no history is. */
export const dueTrace = (policy: Policy, trace: Trace): Decoded<Due> => {
  const folded = fold(policy.role, trace)
  if (!folded.ok) return fail(folded.error)
  return dueOf(policy, folded.value)
}

/** The hand-back a policy owes for a record from outside, or the typed rejection of a record no history leaves. */
export const due = (policy: Policy, record: ItemRecord): Decoded<Due> => {
  const folded = decodeRecord(policy.role, record)
  if (!folded.ok) return fail(folded.error)
  return dueOf(policy, folded.value)
}

const HAND_BACK_KEYS: ReadonlyArray<string> = ["item", "rule", "label", "fields"]

const fieldFaultsOf = (owed: Due, fields: ReadonlyArray<Field>): ReadonlyArray<string> => [
  ...owed.fields.flatMap((want) => {
    const got = fields.filter((one) => one.field === want.field)
    const exact = got.length === 1 && got.every((one) => sameField(one, want) && keyFaults(one).length === 0)
    return iff(!exact, `${want.field}: due ${fieldShown(want)}, given ${got.map(fieldShown).join(" and ") || "none"}`)
  }),
  ...fields.flatMap((one) => iff(!owed.fields.some((want) => want.field === one.field), `${one.field}: due none, given ${fieldShown(one)}`)),
]

/** Every field of a hand-back that differs from the one due, each named with both values: member by member, never a prefix, a rendered key or a flag. */
export const judge = (owed: Due, given: HandBack): ReadonlyArray<string> => {
  const extra = Object.keys(given).filter((key) => !HAND_BACK_KEYS.includes(key))
  return [
    ...iff(extra.length > 0, `unknown hand-back keys [${extra.join(", ")}]: no flag stands in for evidence`),
    ...iff(given.item !== owed.item, `item: due ${owed.item}, given ${given.item}`),
    ...iff(given.rule !== owed.rule, `rule: due ${owed.rule}, given ${given.rule}`),
    ...iff(given.label !== owed.label, `label: due ${owed.label}, given ${given.label}`),
    ...iff(!Array.isArray(given.fields), "fields: due a list of evidence fields, given none"),
    ...fieldFaultsOf(owed, [given.fields].filter((fields) => Array.isArray(fields)).flat()),
  ]
}

// ---- a held item's evidence, derived from its trace ---------------------------------------------------------------------

/**
 * What keeps a held item from settling, derived from its folded trace: its last completed run's command and exit, or,
 * when nothing ran to the end, the typed reason (a refusal with its remedy, the tool this host lacks, the ref it waits
 * on), in the rows' order. Never a free-text field echoed back.
 */
export type HeldEvidence =
  | { readonly kind: "ran"; readonly command: string; readonly exit: number }
  | { readonly kind: "refused"; readonly what: string; readonly form: Form }
  | { readonly kind: "cannot"; readonly tool: string }
  | { readonly kind: "waits"; readonly ref: string }

export const heldEvidence = (folded: Folded): ReadonlyArray<HeldEvidence> => {
  const { record } = folded
  const ran = runsIn(record).map((run): HeldEvidence => ({ kind: "ran", command: run.command, exit: run.exit }))
  const why: ReadonlyArray<HeldEvidence> = [
    ...refusalsIn(record).map((refusal): HeldEvidence => ({ kind: "refused", what: refusal.what, form: refusal.form })),
    ...absentIn(record).map((absent): HeldEvidence => ({ kind: "cannot", tool: absent.tool })),
    ...waitsIn(record).map((ref): HeldEvidence => ({ kind: "waits", ref })),
  ]
  return [...ran, ...why].slice(0, 1)
}

const remedyText = (form: Form): string => {
  if (form.kind === "named") return `; form: ${form.form}`
  if (form.kind === "allow") return `; form: ${form.allow}`
  return ""
}
/** A held item's evidence as a report writes it: `<command> (exit <code>)`, else its label's words. */
export const heldText = (evidence: HeldEvidence): string => {
  if (evidence.kind === "ran") return `${evidence.command} (exit ${evidence.exit})`
  if (evidence.kind === "refused") return `refused: ${evidence.what}${remedyText(evidence.form)}`
  if (evidence.kind === "cannot") return `cannot run here: ${evidence.tool}`
  return `waits on ${evidence.ref}`
}

/** A written held value read in the grammar of the evidence it must be, into its members: none when it is not of it. */
const heldRead = (want: HeldEvidence, text: string): ReadonlyArray<HeldEvidence> => {
  if (want.kind === "ran") return groupsOf(text, /^([\s\S]+) \(exit (-?\d+)\)$/).map(([command = "", exit = ""]): HeldEvidence => ({ kind: "ran", command, exit: Number(exit) }))
  if (want.kind === "cannot") return groupsOf(text, /^cannot run here: ([\s\S]+)$/).map(([tool = ""]): HeldEvidence => ({ kind: "cannot", tool }))
  if (want.kind === "waits") return groupsOf(text, /^waits on ([\s\S]+)$/).map(([ref = ""]): HeldEvidence => ({ kind: "waits", ref }))
  if (want.form.kind === "none") return groupsOf(text, /^refused: ([\s\S]+)$/).map(([what = ""]): HeldEvidence => ({ kind: "refused", what, form: want.form }))
  const kind = want.form.kind
  return groupsOf(text, /^refused: ([\s\S]+); form: ([\s\S]+)$/).map(([what = "", remedy = ""]): HeldEvidence => ({ kind: "refused", what, form: formOf(kind, remedy) }))
}
const formOf = (kind: "named" | "allow", text: string): Form => {
  if (kind === "named") return { kind, form: text }
  return { kind, allow: text }
}
/** The capture groups of each whole-text match of `pattern` (anchored, so one at most). */
const groupsOf = (text: string, pattern: RegExp): ReadonlyArray<ReadonlyArray<string>> => [...text.matchAll(new RegExp(pattern.source, "g"))].map((match) => match.slice(1))

/** Two held evidence values equal member by member. */
export const sameHeld = (a: HeldEvidence, b: HeldEvidence): boolean => {
  if (a.kind === "ran" && b.kind === "ran") return a.command === b.command && a.exit === b.exit
  if (a.kind === "refused" && b.kind === "refused") return a.what === b.what && sameForm(a.form, b.form)
  if (a.kind === "cannot" && b.kind === "cannot") return a.tool === b.tool
  if (a.kind === "waits" && b.kind === "waits") return a.ref === b.ref
  return false
}

// ---- the step: verdict, artifacts and stop evidence -----------------------------------------------------------------

export interface Outcome {
  readonly verdict: string
  readonly rule: string
  readonly writes: Writes
  readonly fields: ReadonlyArray<StopFieldId>
}

const refusalStop = (stop: Stop): boolean => stop === "refusalForm" || stop === "refusalNone"

/** Why a stop with these item states is no step's end: empty when it is one. */
export const illFormed = (role: Role, stop: Stop, states: ReadonlyArray<State>): ReadonlyArray<string> => {
  const refused = states.filter((state) => state === "refused").length
  const reasons: ReadonlyArray<readonly [boolean, string]> = [
    [!hasStop(role, stop), `a ${role} has no ${stop} stop`],
    ...states.map((state): readonly [boolean, string] => [!hasState(role, state), `a ${role} has no ${state} state`]),
    [refusalStop(stop) && refused > 1, "a refusal stops the step at the one item it refused"],
    [refusalStop(stop) && refused === 0, "a refusal stops the step at the one item it refused (a refused optional probe is refused too)"],
    [!refusalStop(stop) && refused > 0, "a refusal stops the step at once, so a refused item means the step stopped on it"],
    [stop === "idle" && states.includes("runnable"), "the step goes on while a runnable item is left"],
    [stop === "limit" && !states.includes("runnable"), "with no runnable item left the step had already stopped, before the limit passed"],
  ]
  return reasons.flatMap(([bad, why]) => iff(bad, why)).slice(0, 1)
}

const holdsFor = (when: VerdictWhen, states: ReadonlyArray<State>): boolean => {
  if (when.kind === "any") return when.states.some((state) => states.includes(state))
  if (when.kind === "only") return states.every((state) => when.states.includes(state))
  return true
}

/** The verdict, what it writes and the stop's evidence fields, from a policy, or why the input is ill-formed. */
export const outcome = (policy: Policy, stop: Stop, states: ReadonlyArray<State>): Decoded<Outcome> => {
  const bad = illFormed(policy.role, stop, states)
  if (bad.length > 0) return fail(bad.join(""))
  const fields = policy.stops.filter((one) => one.stop === stop).flatMap((one) => one.fields.map((field) => field.id))
  const rules = firstOf(policy.verdicts, (one) => holdsFor(one.when, states)).map((rule) => ({ verdict: rule.verdict, rule: rule.id, writes: rule.writes, fields }))
  return firstFound(rules, `no verdict rule holds for ${policy.role}`)
}

/**
 * A stop evidence field's value: one of a single-valued field, or one `held` entry naming the item it is for, its value
 * written as `heldText` writes that item's derived evidence. A field the refusal did not print, or a `held` collection
 * with nothing held, is told by leaving the entries out.
 */
export type StopValue =
  | { readonly id: "refused.what" | "refused.form" | "refused.allow" | "limit"; readonly value: string }
  | { readonly id: "held"; readonly item: string; readonly value: string }
/** The stop event as recorded: which stop, and its evidence fields' values. */
export interface StopRecord {
  readonly stop: Stop
  readonly values: ReadonlyArray<StopValue>
}
export interface Step {
  readonly stop: StopRecord
  readonly items: ReadonlyArray<ItemRecord>
}
export interface Claim {
  readonly verdict: string
  readonly writes: ReadonlyArray<Artifact>
  readonly stop: ReadonlyArray<StopValue>
  readonly items: ReadonlyArray<HandBack>
}

/** The item a `held` entry names, or none for a single-valued field (and for a `held` entry that names none). */
const heldItem = (value: StopValue): ReadonlyArray<string> => {
  if (value.id !== "held" || !("item" in value)) return []
  return [value.item]
}
const sameStopValue = (a: StopValue, b: StopValue): boolean => a.id === b.id && a.value === b.value && sameList(heldItem(a), heldItem(b), eq)
const stopValueText = (value: StopValue): string => [...heldItem(value).map((item) => `${quoted(item)}: `), quoted(value.value)].join("")

/** Each field's count, by its presence: what the record must hold for the stop to be one a step reached. */
const countFaults = (field: StopField, entries: ReadonlyArray<StopValue>, held: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (field.presence === "always") return iff(entries.length !== 1, `${field.id}: exactly one value is due, the record holds ${entries.length}`)
  if (field.presence === "ifPrinted") return iff(entries.length > 1, `${field.id}: at most one value, the record holds ${entries.length}`)
  const named = entries.flatMap(heldItem)
  return [
    ...iff(named.length !== entries.length || !named.every((item) => filled(item)), `${field.id}: an entry names no item`),
    ...unique(named).map((item) => `${field.id}: ${item} stands twice`),
    ...named.flatMap((item) => iff(!held.includes(item), `${field.id}: ${item} holds nothing back, so no entry is due for it`)),
    ...held.flatMap((item) => iff(!named.includes(item), `${field.id}: ${item} holds the step back and has no entry`)),
  ]
}

/** Each held entry against the evidence its item's trace derives, read in that evidence's grammar, member by member. */
const heldValueFaults = (values: ReadonlyArray<StopValue>, folded: ReadonlyArray<Folded>): ReadonlyArray<string> =>
  values.flatMap((value) =>
    heldItem(value).flatMap((item) =>
      folded
        .filter((one) => one.record.id === item)
        .flatMap(heldEvidence)
        .flatMap((want) => iff(!heldRead(want, value.value).some((got) => sameHeld(got, want)), `held: ${item}: its trace derives ${quoted(heldText(want))}, the record ${quoted(value.value)}`)),
    ),
  )

/** The remedy a refusal printed for one stop field: the `!` command for `refused.form`, the allow rule for `refused.allow`. */
const remedyOf = (form: Form, id: StopFieldId): ReadonlyArray<string> => {
  if (form.kind === "named" && id === "refused.form") return [form.form]
  if (form.kind === "allow" && id === "refused.allow") return [form.allow]
  return []
}

/** The refusal the step stopped on, bound to the refused item's own record: what it said and the remedy it printed, if any. */
const refusalFaults = (stop: Stop, fields: ReadonlyArray<StopField>, values: ReadonlyArray<StopValue>, items: ReadonlyArray<ItemRecord>): ReadonlyArray<string> => {
  const refusals = items.flatMap(refusalsIn)
  return refusals.flatMap((refusal) => {
    const { what, form } = refusal
    const printed = form.kind !== "none"
    return [
      ...values.flatMap((one) => iff(one.id === "refused.what" && one.value !== what, `refused.what: the refused item's record says ${quoted(what)}, the stop ${quoted(one.value)}`)),
      ...iff(stop === "refusalForm" && !printed, "the refused item's refusal printed no remedy, so the stop is a refusal that named none"),
      ...iff(stop === "refusalNone" && printed, "the refused item's refusal printed a remedy, so the stop is a refusal that named one"),
      ...fields.flatMap((one) => {
        const want = remedyOf(form, one.id)
        const got = values.flatMap((value) => [value.value].filter(() => value.id === one.id))
        return iff(one.presence === "ifPrinted" && !sameList(want, got, eq), `${one.id}: the refused item's record says ${formText(form, quoted)}, the stop ${got.map(quoted).join(" and ") || "none"}`)
      }),
    ]
  })
}

/** Why a recorded stop is none this step reached: a field it lacks or doubles, an empty value, a value its items' traces do not derive. */
export const stopRecordFaults = (policy: Policy, step: Step, owed: ReadonlyArray<Due>, folded: ReadonlyArray<Folded>): ReadonlyArray<string> => {
  const fields = policy.stops.filter((one) => one.stop === step.stop.stop).flatMap((one) => one.fields)
  const states = heldStates(policy.role)
  const held = owed.flatMap((one) => [one.item].filter(() => states.includes(one.state)))
  const values = step.stop.values
  return [
    ...values.flatMap((one) => iff(!fields.some((field) => field.id === one.id), `${one.id}: this stop has no such field`)),
    ...values.flatMap((one) => iff(!filled(one.value), `${one.id}: an empty value is no value; leave the field out to tell its absence`)),
    ...fields.flatMap((field) => countFaults(field, values.filter((one) => one.id === field.id), held)),
    ...refusalFaults(step.stop.stop, fields, values, step.items),
    ...heldValueFaults(values, folded),
  ]
}

/** The claimed stop values against the recorded ones, field by field, each value member by member. */
const stopFaults = (record: ReadonlyArray<StopValue>, claim: ReadonlyArray<StopValue>): ReadonlyArray<string> => {
  const ids = STOP_FIELDS.filter((id) => record.some((one) => one.id === id) || claim.some((one) => one.id === id))
  return ids.flatMap((id) => {
    const want = record.filter((one) => one.id === id)
    const got = claim.filter((one) => one.id === id)
    const exact = want.length === got.length && want.every((one) => got.some((other) => sameStopValue(one, other))) && got.every((one) => want.some((other) => sameStopValue(one, other)))
    return iff(!exact, `stop ${id}: due ${want.map(stopValueText).join(" and ") || "none"}, given ${got.map(stopValueText).join(" and ") || "none"}`)
  })
}

const itemFaults = (dues: ReadonlyArray<Due>, claim: Claim): ReadonlyArray<string> => [
  ...dues.flatMap((one) => {
    const given = claim.items.filter((item) => item.item === one.item)
    if (given.length !== 1) return [`${one.item}: ${given.length} hand-backs, not one`]
    return given.flatMap((item) => judge(one, item).map((line) => `${one.item}: ${line}`))
  }),
  ...claim.items.filter((item) => !dues.some((one) => one.item === item.item)).map((item) => `${item.item}: no such item in the step`),
]

/** Every reason a claimed hand-back does not match the checked step under a policy: none means it is admitted. */
export const admit = (policy: Policy, step: Step, claim: Claim): ReadonlyArray<string> => {
  const twice = unique(step.items.map((record) => record.id))
  if (twice.length > 0) return twice.map((id) => `ill-formed step: item ${id} stands twice`)
  const folded = allOk(step.items.map((record) => decodeRecord(policy.role, record)))
  if (!folded.ok) return [`ill-formed item: ${folded.error}`]
  const owed = allOk(folded.value.map((one) => dueOf(policy, one)))
  if (!owed.ok) return [`ill-formed item: ${owed.error}`]
  const result = outcome(
    policy,
    step.stop.stop,
    owed.value.map((one) => one.state),
  )
  if (!result.ok) return [`ill-formed step: ${result.error}`]
  const recorded = stopRecordFaults(policy, step, owed.value, folded.value)
  if (recorded.length > 0) return recorded.map((line) => `ill-formed stop record: ${line}`)
  const { verdict, writes } = result.value
  return [
    ...iff(claim.verdict !== verdict, `verdict: due ${verdict}, given ${claim.verdict}`),
    ...iff(!sameList(claim.writes, writes.artifacts, eq), `writes: due [${writes.artifacts.join(", ")}], given [${claim.writes.join(", ")}]`),
    ...stopFaults(step.stop.values, claim.stop),
    ...itemFaults(owed.value, claim),
  ]
}
