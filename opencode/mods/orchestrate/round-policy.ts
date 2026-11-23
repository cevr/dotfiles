// The round policy: how an orchestrate role's step ends, as one versioned contract every host's prompt is
// generated from and decoded back into. IO-free and free of the Effect runtime (it uses pure Effect data and Schema
// utilities), so the installed plugin (role.ts), the skill's generator (skills/orchestrate/scripts/round-policy.ts) and
// the tests read the same source.
//
//   vocabulary  roles, item states, stop events, the atoms a row's condition is written in, the item evidence
//               fields, the artifacts a verdict writes and each stop's evidence fields, all closed sets;
//   policy      per role, the ordered decision rows (stable rule ids, first true row wins), the ordered verdict
//               rules with their artifacts, and the stop evidence: `project(role)`;
//   notation    `render(policy)` writes the block a prompt carries; `decodeBlock(text)` reads a delivered block back
//               into the same Policy, strictly (fixed vocabulary, numbered priority, field names, version);
//               `policyFaults(role, text)` compares what a host delivered with the source, field by field and
//               byte for byte;
//   evidence    one way in: `decode(input)` takes a step's persisted `Envelope` from anywhere (its role, each item's
//               history of events, and the step's own observations: the limit passing, a refused write of its own
//               file), checks it by its schema (exact tags, members, primitives and array elements), folds each
//               item's history event by event and derives the step's stop: a typed rejection naming the path or the
//               event, or an opaque `Checked` step that owns deep-frozen copies of everything. Nothing else takes a
//               record, a trace, a stop record or an evidence value from a caller;
//   admission   `owed(checked)` is the one claim true of the step, every value derived from the history it
//               is about; `admit(checked)(claim)` decodes a claim from anywhere and names every way it
//               differs from that, member by member; `outcome(policy, stop, states)` the verdict, artifacts and stop
//               fields of a set of states.
// A Policy is data: the tests mutate it to show each mutation is caught by the test meant to catch it.

import { Array as Arr, flow, Option, Result, Schema } from "effect"

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
  refused: "a refusal stopped it or your file write (report a denied write in your final message)",
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
export const READS = Object.freeze({
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
} as const satisfies { readonly [A in Atom]: (facts: Facts) => boolean })

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
    limit: [{ id: "limit", presence: "always", text: "`timebox <its length>` or `failure cap <its count>`" }],
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
  completed: "the last attempt that finished: its id, command, output digest or why none, exit code, receipt, head and result",
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
const policyOf = (role: Role): Policy => ({
  version: VERSION,
  role,
  intro: intro(role),
  fields: FIELDS.map((id) => ({ id, text: FIELD_TEXT[id] })),
  rows: AUTHORED[role].map(([id, state, when, label], index) => ({ priority: index + 1, id, state, when, label })),
  verdicts: VERDICTS_AUTHORED[role].map((rule, index) => ({ ...rule, priority: index + 1 })),
  stops: STOPS_OF[role].map((stop) => ({ stop, fields: stopAuthored(role, stop) })),
})
export const project = (role: Role): Policy => POLICIES[role]

// ---- the notation --------------------------------------------------------------------------------------------------

export const SOURCE = "opencode/mods/orchestrate/round-policy.ts"
export const header = (role: Role | "protocol", version: number = VERSION): string =>
  `<!-- round-policy v${version} ${role}: generated by ${SOURCE}; edit that, then run skills/orchestrate/scripts/agents.ts -->`
export const END = "<!-- /round-policy -->"
/** A rendered block, wherever it stands in a file. */
export const BLOCK = /<!-- round-policy v\d+ [a-z]+: [^\n]*-->[\s\S]*?<!-- \/round-policy -->/
const HEADER = /^<!-- round-policy v(\d+) ([a-z]+): generated by opencode\/mods\/orchestrate\/round-policy\.ts; edit that, then run skills\/orchestrate\/scripts\/agents\.ts -->$/

export const FIELDS_LEAD =
  "Give each item's rule, label and all these fields exactly as recorded. Omit absent fields; the label never drops evidence:"
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
const ok = <A>(value: A): Decoded<A> => ({ ok: true, value })
const fail = <A>(error: string): Decoded<A> => ({ ok: false, error })
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
export const decodeBlock = (text: string): Decoded<Policy> => {
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
  const shown = decodeBlock(found.value)
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

// ---- evidence values, compared member by member (internal) -----------------------------------------------------------

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
const sameField = (a: Field, b: Field): boolean => {
  if (a.field === "completed" && b.field === "completed") return sameRun(a.run, b.run)
  if (a.field === "current" && b.field === "current") return samePending(a.attempt, b.attempt)
  if (a.field === "refused" && b.field === "refused") return sameRefusal(a.refusal, b.refusal)
  if (a.field === "cannot" && b.field === "cannot") return sameAbsent(a.absent, b.absent)
  if (a.field === "waits" && b.field === "waits") return a.ref === b.ref
  return false
}

/** Each value quoted, with `\` and `"` escaped, so no two values show alike: how a judged difference is shown. */
const quoted = (text: string): string => `"${text.replaceAll("\\", "\\\\").replaceAll(`"`, `\\"`)}"`
const outputText = (output: Output): string => {
  if (output.kind === "missing") return `missing ${output.why}`
  return `${output.kind} ${quoted(output.digest)}`
}
const formText = (form: Form): string => {
  if (form.kind === "none") return "none"
  if (form.kind === "allow") return `allow ${quoted(form.allow)}`
  return `named ${quoted(form.form)}`
}
const fieldShown = (field: Field): string => {
  if (field.field === "completed") {
    const { id, command, output, exit, receipt, head, result } = field.run
    return `completed id=${quoted(id)} command=${quoted(command)} output=${outputText(output)} exit=${exit} receipt=${quoted(receipt)} head=${quoted(head)} result=${result}`
  }
  if (field.field === "current") {
    const { id, command, status, output } = field.attempt
    return `current id=${quoted(id)} command=${quoted(command)} status=${status} output=${outputText(output)}`
  }
  if (field.field === "refused") {
    const { what, scope, report, form } = field.refusal
    return `refused what=${quoted(what)} scope=${quoted(scope)} report=${quoted(report)} form=${formText(form)}`
  }
  if (field.field === "cannot") return `cannot tool=${quoted(field.absent.tool)} probe=${quoted(field.absent.probe)} output=${outputText(field.absent.output)}`
  return `waits ref=${quoted(field.ref)}`
}

/** Each a string with a character other than white space: an empty value is no value. */
const filled = (...texts: ReadonlyArray<string>): boolean => texts.every((one) => one.trim().length > 0)

// ---- the envelope: the one way in ------------------------------------------------------------------------------------

const Text = Schema.String
const OutputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("log"), digest: Text }),
  Schema.Struct({ kind: Schema.Literal("partial"), digest: Text }),
  Schema.Struct({ kind: Schema.Literal("missing"), why: Schema.Literals(MISSING) }),
])
const FormSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("named"), form: Text }),
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("allow"), allow: Text }),
])
const RefusalSchema = Schema.Struct({ what: Text, scope: Text, report: Text, form: FormSchema })
const AbsentSchema = Schema.Struct({ tool: Text, probe: Text, output: OutputSchema })

/**
 * One event of an item's history, each about the attempt it names or an obstacle. An attempt begins (`begin`), may have
 * partial output observed (`observe`), and ends completed (`finish`) or interrupted (`interrupt`). A refusal is either
 * `deny`, of a call that never began (a fresh attempt: its command is the refused call, read or git or check), or
 * `refuse`, of another action beside a running or interrupted attempt: that attempt keeps its status and output. A refusal lifts
 * (`lift`); the host loses and regains the check's tool (`hostLost`, `hostBack`); a wait opens and closes (`waitOpen`,
 * `waitClose`); a verifier's unclear result stays unclear once no retry can settle it (`settle`).
 */
const EventSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("begin"), attempt: Text, command: Text }),
  Schema.Struct({ kind: Schema.Literal("observe"), attempt: Text, digest: Text }),
  Schema.Struct({ kind: Schema.Literal("finish"), attempt: Text, result: Schema.Literals(RESULTS), exit: Schema.Int, output: OutputSchema, receipt: Text, head: Text }),
  Schema.Struct({ kind: Schema.Literal("interrupt"), attempt: Text, output: OutputSchema }),
  Schema.Struct({ kind: Schema.Literal("deny"), attempt: Text, command: Text, refusal: RefusalSchema }),
  Schema.Struct({ kind: Schema.Literal("refuse"), attempt: Text, refusal: RefusalSchema }),
  Schema.Struct({ kind: Schema.Literal("lift") }),
  Schema.Struct({ kind: Schema.Literal("hostLost"), absent: AbsentSchema }),
  Schema.Struct({ kind: Schema.Literal("hostBack") }),
  Schema.Struct({ kind: Schema.Literal("waitOpen"), ref: Text }),
  Schema.Struct({ kind: Schema.Literal("waitClose") }),
  Schema.Struct({ kind: Schema.Literal("settle") }),
])
export type TraceEvent = typeof EventSchema.Type

/** Whose the item is: assigned work (required, or a verifier's optional probe), or a finding outside the assignment. */
const AssignmentSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("assigned"), required: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("found"), provenance: Schema.Literals(PROVENANCES) }),
])
export type Assignment = typeof AssignmentSchema.Type
const ItemSchema = Schema.Struct({ id: Text, assignment: AssignmentSchema, events: Schema.Array(EventSchema) })
export type Trace = typeof ItemSchema.Type

/**
 * What the step itself observed, beside its items: the round's limit passing (`limit`: the time box's length or the
 * failure cap's count), or a refusal of the step's own write of an artifact its verdict writes (`writeDenied`), which is
 * no check's attempt.
 */
const LimitSchema = Schema.Union([Schema.Struct({ kind: Schema.Literal("timebox"), length: Text }), Schema.Struct({ kind: Schema.Literal("failureCap"), count: Schema.Int })])
export type Limit = typeof LimitSchema.Type
const StepEventSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("limit"), limit: LimitSchema }),
  Schema.Struct({ kind: Schema.Literal("writeDenied"), artifact: Schema.Literals(ARTIFACTS), refusal: RefusalSchema }),
])
export type StepEvent = typeof StepEventSchema.Type

/** A step's whole persisted history: what D, E and G store, and the only input the contract takes. */
const EnvelopeSchema = Schema.Struct({ version: Schema.Literal(VERSION), role: Schema.Literals(ROLES), items: Schema.Array(ItemSchema), step: Schema.Array(StepEventSchema) })
export type Envelope = typeof EnvelopeSchema.Encoded

/** Every member exact: an unknown member, a wrong tag or a wrong type is a rejection naming its path. */
const STRICT = { onExcessProperty: "error", errors: "first" } as const
const decodeEnvelope = Schema.decodeUnknownResult(EnvelopeSchema, STRICT)

// ---- the fold: an item's history, event by event --------------------------------------------------------------------

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
type Next = Decoded<Folding>

const running = (at: Folding, attempt: string): boolean => at.pending.some((one) => one.status === "started" && one.id === attempt)
/** A running attempt, or one interrupted whose result still arrives (a late result): never a denied one, which never began. */
const finishable = (at: Folding, attempt: string): boolean => at.pending.some((one) => one.status !== "denied" && one.id === attempt)
const runningAny = (at: Folding): boolean => at.pending.some((one) => one.status === "started")
const free = (at: Folding): boolean => at.refusal.length === 0 && at.absent.length === 0 && at.waits.length === 0
const fresh = (at: Folding, attempt: string): boolean => filled(attempt) && !at.attempts.includes(attempt)
const settles = (role: Role, result: Result): boolean => result === "pass" || (role === "verifier" && result === "fail")
/** Missing new output never replaces known output of the same attempt. A new log or partial digest can supersede it. */
const keepOutput = (prior: Output, next: Output): Output => {
  if (next.kind === "missing" && prior.kind !== "missing") return prior
  return next
}

const refusalOk = (refusal: Refusal): boolean =>
  filled(refusal.what, refusal.scope, refusal.report) && (refusal.form.kind === "none" || (refusal.form.kind === "named" && filled(refusal.form.form)) || (refusal.form.kind === "allow" && filled(refusal.form.allow)))
/** A finished attempt's output is its log, or the typed word that it ran with no authenticated evidence: never "not started". */
const finishedOutput = (output: Output): boolean => (output.kind === "log" && filled(output.digest)) || (output.kind === "missing" && output.why === "missing-authenticated-evidence")
const interruptedOutput = (output: Output): boolean => (output.kind === "partial" && filled(output.digest)) || (output.kind === "missing" && output.why === "interrupted")
const iffOk = (good: boolean, next: Folding, why: string): Next => {
  if (good) return ok(next)
  return fail(why)
}

const attemptStep = (role: Role, at: Folding, event: TraceEvent): Next => {
  if (event.kind === "begin") {
    const pending: Pending = { id: event.attempt, command: event.command, status: "started", output: { kind: "missing", why: "missing-authenticated-evidence" } }
    const good = free(at) && !runningAny(at) && fresh(at, event.attempt) && filled(event.command)
    return iffOk(good, { ...at, pending: [pending], attempts: [...at.attempts, event.attempt] }, "an attempt begins only while nothing holds the item, none runs, and with a new id and its command")
  }
  if (event.kind === "observe") {
    const pending = at.pending.map((one): Pending => ({ ...one, output: { kind: "partial", digest: event.digest } }))
    return iffOk(running(at, event.attempt) && filled(event.digest), { ...at, pending }, "output is observed only of the running attempt")
  }
  if (event.kind === "finish") return finishStep(role, at, event)
  if (event.kind === "interrupt") {
    const pending = at.pending.map((one): Pending => ({ ...one, status: "interrupted", output: keepOutput(one.output, event.output) }))
    return iffOk(running(at, event.attempt) && interruptedOutput(event.output), { ...at, pending }, "only the running attempt is interrupted, with its partial output or the word that it was interrupted")
  }
  return refusalStep(at, event)
}

const finishStep = (role: Role, at: Folding, event: TraceEvent): Next => {
  if (event.kind !== "finish") return fail("no such event")
  const prior = Arr.findFirst(at.pending, (one) => one.id === event.attempt && one.status !== "denied")
  if (Option.isNone(prior) || at.refusal.length > 0 || !finishedOutput(event.output) || !filled(event.receipt, event.head))
    return fail("only the current attempt, running or interrupted, finishes, once no refusal holds it, with its result, exit, output (a log, or no authenticated evidence), receipt and head")
  const run: Run = { id: event.attempt, command: prior.value.command, output: keepOutput(prior.value.output, event.output), exit: event.exit, receipt: event.receipt, head: event.head, result: event.result }
  const settled = settles(role, event.result)
  // A result that settles the item leaves nothing for a host loss or a wait opened during the run to hold back.
  const cleared = { absent: at.absent.filter(() => !settled), waits: at.waits.filter(() => !settled) }
  return ok({ ...at, ...cleared, run: [run], pending: [], settled })
}

/**
 * A refusal: `deny` of a call that never began (a fresh attempt, never started, with no output), or `refuse` of
 * another action beside an unfinished attempt, which leaves that attempt as it is, output and all. Never a denial of an
 * attempt that began: what it already printed stays in every later label.
 */
const refusalStep = (at: Folding, event: TraceEvent): Next => {
  if (event.kind === "deny") {
    const pending: Pending = { id: event.attempt, command: event.command, status: "denied", output: { kind: "missing", why: "not-started" } }
    const good = at.refusal.length === 0 && at.pending.every((one) => one.status === "denied") && fresh(at, event.attempt) && filled(event.command) && refusalOk(event.refusal)
    const why = "a denied call never began: a new attempt, with no begun attempt unfinished and no refusal holding the item, with what, scope, report and remedy"
    return iffOk(good, { ...at, pending: [pending], refusal: [event.refusal], attempts: [...at.attempts, event.attempt] }, why)
  }
  if (event.kind === "refuse") {
    const good = at.refusal.length === 0 && finishable(at, event.attempt) && refusalOk(event.refusal)
    return iffOk(good, { ...at, refusal: [event.refusal] }, "a refusal beside an attempt is of another action while that attempt is unfinished, while no refusal holds the item")
  }
  return fail("no such event")
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

const ATTEMPT_EVENTS: ReadonlyArray<TraceEvent["kind"]> = ["begin", "observe", "finish", "interrupt", "deny", "refuse"]

/** One event after the trace so far: the next standing, or why the event cannot happen there. */
const stepTrace = (role: Role, at: Folding, event: TraceEvent): Next => {
  if (at.settled) return fail("the item is settled: no event follows")
  if (ATTEMPT_EVENTS.includes(event.kind)) return attemptStep(role, at, event)
  return obstacleStep(role, at, event)
}

const START: Folding = { settled: false, run: [], pending: [], refusal: [], absent: [], waits: [], attempts: [] }

const assignmentFaults = (role: Role, trace: Trace): ReadonlyArray<string> => {
  const { assignment } = trace
  if (assignment.kind === "assigned") return iff(!assignment.required && role !== "verifier", "only a verifier has optional work (a wider probe)")
  const verifierFinding = role === "verifier" && assignment.provenance !== "none"
  const otherFinding = role !== "verifier" && assignment.provenance === "none"
  return [
    ...iff(!verifierFinding && !otherFinding, "a verifier's finding is the unit's or the base's; another role's has no provenance"),
    ...iff(trace.events.length > 0, "a finding outside the assignment is settled as found: no event follows"),
  ]
}

const attemptOf = (at: Folding): Attempt => {
  for (const run of at.run) return run.result
  if (at.pending.length > 0) return "started"
  return "never"
}
const factsOf = (assignment: Assignment, at: Folding): Facts => ({
  assigned: assignment.kind === "assigned",
  required: assignment.kind === "assigned" && assignment.required,
  attempt: attemptOf(at),
  settled: assignment.kind === "found" || at.settled,
  refused: at.refusal.length > 0,
  hostCannot: at.absent.length > 0,
  wait: at.waits.length > 0,
  provenance: provenanceOf(assignment),
})
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

/** The record an item's trace leaves, or the first event that cannot happen where it stands (a typed rejection). */
const fold = (role: Role, trace: Trace): Decoded<ItemRecord> => {
  const assigned = assignmentFaults(role, trace)
  if (!filled(trace.id)) return fail("an item has no id")
  if (assigned.length > 0) return fail(`item ${trace.id}: ${assigned.join("; ")}`)
  let at: Folding = START
  for (const [index, event] of trace.events.entries()) {
    const next = stepTrace(role, at, event)
    if (!next.ok) return fail(`item ${trace.id}: event ${index + 1} (${event.kind}): ${next.error}`)
    at = next.value
  }
  return ok({ id: trace.id, facts: factsOf(trace.assignment, at), fields: fieldsOf(at) })
}

// ---- the checked step: decoded, folded, owned ---------------------------------------------------------------------

/** What stopped the step, derived from its histories: an item's refusal, its own refused write, the limit, or none left. */
type Ending =
  | { readonly kind: "refusal"; readonly refusal: Refusal }
  | { readonly kind: "write"; readonly refusal: Refusal }
  | { readonly kind: "limit"; readonly limit: Limit }
  | { readonly kind: "idle" }

/** A refused write of the step's own file stops it as any refusal does, by the remedy it printed. */
const stopOf = (ending: Ending): Stop => {
  if (ending.kind === "limit") return "limit"
  if (ending.kind === "idle") return "idle"
  if (ending.refusal.form.kind === "none") return "refusalNone"
  return "refusalForm"
}

/**
 * A step decoded from its persisted envelope and checked: every item's history folded, and the stop derived. Only
 * `decode` issues one (its private member makes the type nominal, and admissions check the issuance map), and it owns
 * deep-frozen copies of everything, so nothing it returns shares a reference with what the caller handed in.
 */
class CheckedStep {
  constructor(
    readonly role: Role,
    readonly records: ReadonlyArray<ItemRecord>,
    readonly ending: Ending,
    private readonly source: Envelope,
  ) {}
  /** The envelope this step was decoded from, as the contract owns it: what a later unit stores. */
  get envelope(): Envelope {
    return this.source
  }
}
export type Checked = CheckedStep
const issued = new WeakMap<Checked, Owed>()
Object.freeze(CheckedStep.prototype)

/** A value and everything inside it, frozen: what the contract returns can never be changed by whoever holds it. */
const frozen = <A>(value: A): A => {
  for (const inner of Object.values(Object(value))) if (inner === Object(inner)) frozen(inner)
  return Object.freeze(value)
}
const POLICIES = frozen({
  planner: policyOf("planner"),
  implementor: policyOf("implementor"),
  verifier: policyOf("verifier"),
  worker: policyOf("worker"),
})

const refusalsOf = (record: ItemRecord): ReadonlyArray<Refusal> =>
  record.fields.flatMap((field) => {
    if (field.field === "refused") return [field.refusal]
    return []
  })

/** The role's artifacts: what any of its verdicts writes. */
const artifactsOf = (role: Role): ReadonlyArray<Artifact> => project(role).verdicts.flatMap((rule) => rule.writes.artifacts)

/** A positive length in a clock unit, retaining exactly the space (if any) that was recorded. */
const timeboxLength = /^[1-9][0-9]* ?(?:ms|s|m|h|d)(?![\s\S])/
const observedLimit = (limit: Limit): boolean => {
  if (limit.kind === "timebox") return timeboxLength.test(limit.length)
  return Number.isSafeInteger(limit.count) && limit.count > 0
}

const endingOf = (role: Role, records: ReadonlyArray<ItemRecord>, step: ReadonlyArray<StepEvent>): Decoded<Ending> => {
  const endings: ReadonlyArray<Ending> = [
    ...records.flatMap(refusalsOf).map((refusal): Ending => ({ kind: "refusal", refusal })),
    ...step.map((event): Ending => {
      if (event.kind === "limit") return { kind: "limit", limit: event.limit }
      return { kind: "write", refusal: event.refusal }
    }),
  ]
  const wrong = [
    ...iff(endings.length > 1, "the step stopped once: a refusal or the limit, never two"),
    ...step.flatMap((event) => {
      if (event.kind === "limit") {
        return [...iff(!hasStop(role, "limit"), `a ${role} has no round limit`), ...iff(!observedLimit(event.limit), "a limit has a positive clock length or failure count")]
      }
      return [...iff(!artifactsOf(role).includes(event.artifact), `a ${role} writes no ${event.artifact}`), ...iff(!refusalOk(event.refusal), "a refused write has what, scope, report and remedy")]
    }),
  ]
  if (wrong.length > 0) return fail(`step: ${wrong.join("; ")}`)
  for (const one of endings) return ok(one)
  return ok({ kind: "idle" })
}

/**
 * The states the verdict reads: each item's, and a refused write of the step's own file as one refused item more (no
 * check reopened or invented, every settled result kept).
 */
const statesOf = (ending: Ending, rows: ReadonlyArray<Row>): ReadonlyArray<State> => {
  const states = rows.map((row) => row.state)
  if (ending.kind === "write") return [...states, "refused"]
  return states
}

/** The state each item's record takes under a policy: its first true row. */
const rowOf = (policy: Policy, record: ItemRecord): Decoded<Row> => firstFound(decide(policy, truths([record.facts])), `${record.id}: no row is true`)

const checkStep = (envelope: Envelope): Decoded<Checked> => {
  const { role } = envelope
  const twice = unique(envelope.items.map((item) => item.id))
  if (twice.length > 0) return fail(`items: item ${twice.join(", ")} stands twice`)
  const records = allOk(envelope.items.map((item) => fold(role, item)))
  if (!records.ok) return fail(records.error)
  const ending = endingOf(role, records.value, envelope.step)
  if (!ending.ok) return fail(ending.error)
  const policy = project(role)
  const reads = allOk(records.value.map((record) => readOf(policy, record)))
  if (!reads.ok) return fail(reads.error)
  const due = deriveOwed(policy, ending.value, reads.value)
  if (!due.ok) return fail(due.error)
  const checked = Object.freeze(new CheckedStep(role, frozen(records.value), frozen(ending.value), frozen(envelope)))
  issued.set(checked, due.value)
  return ok(checked)
}

const rejected = (error: Schema.SchemaError): Decoded<Checked> => fail(`envelope: ${error.message.replaceAll("\n", " ")}`)

/** An unknown JS value can also be unreadable (a throwing getter or proxy), independently of the schema. */
const readUnknown = <Input, A>(read: (input: Input) => A, unreadable: () => A) =>
  (input: Input): A => Result.match(Result.try(() => read(input)), { onFailure: unreadable, onSuccess: (value) => value })

/**
 * The one way in: a step's persisted envelope, from anywhere (a store, a file, a test's raw JSON), decoded by its schema
 * (exact tags, primitives, array elements and members, each rejection naming its path), then each item's history
 * folded event by event and the step's stop derived. Never throws: a typed rejection, or the checked step.
 */
export const decode = readUnknown(flow(decodeEnvelope, Result.match({ onFailure: rejected, onSuccess: checkStep })), () => fail("envelope: could not read the value"))

// ---- what a step owes, derived ----------------------------------------------------------------------------------------

/** The first row of a policy true of an item with these atoms (the catch-all when none above is). */
export const decide = (policy: Policy, atoms: ReadonlySet<Atom>): ReadonlyArray<Row> => firstOf(policy.rows, (row) => row.when === "otherwise" || row.when.every((atom) => atoms.has(atom)))

/** The first of `items`, or `why` when there is none. */
const firstFound = <A>(items: ReadonlyArray<A>, why: string): Decoded<A> => {
  for (const one of items) return ok(one)
  return fail(why)
}

/** One item's hand-back: its rule, its label and every evidence field its history leaves that the policy names. */
export interface HandBack {
  readonly item: string
  readonly rule: string
  readonly label: string
  readonly fields: ReadonlyArray<Field>
}
/** A stop evidence value: one of a single-valued field, or one `held` entry naming the item it is for. */
export type StopValue =
  | { readonly id: "refused.what" | "refused.form" | "refused.allow" | "limit"; readonly value: string }
  | { readonly id: "held"; readonly item: string; readonly value: string }
/** What a step's hand-back claims: its verdict, what it writes, the stop's evidence values and each item's hand-back. */
export interface Claim {
  readonly verdict: string
  readonly writes: ReadonlyArray<Artifact>
  readonly stop: ReadonlyArray<StopValue>
  readonly items: ReadonlyArray<HandBack>
}
/** One item as the step's policy reads it: its state, rule and the facts its history leaves (for reading, never input). */
export interface ItemState {
  readonly item: string
  readonly rule: string
  readonly state: State
  readonly facts: Facts
}
/** What a checked step owes under a policy: the one claim that is true of it, and each item's state. */
export interface Owed {
  readonly claim: Claim
  readonly states: ReadonlyArray<ItemState>
}

/** A held item's evidence, derived from its folded history: its last run, else the typed reason none ran to the end. */
type HeldEvidence =
  | { readonly kind: "ran"; readonly command: string; readonly exit: number }
  | { readonly kind: "refused"; readonly what: string; readonly form: Form }
  | { readonly kind: "cannot"; readonly tool: string }
  | { readonly kind: "waits"; readonly ref: string }

const heldEvidence = (record: ItemRecord): ReadonlyArray<HeldEvidence> =>
  record.fields
    .flatMap((field): ReadonlyArray<HeldEvidence> => {
      if (field.field === "completed") return [{ kind: "ran", command: field.run.command, exit: field.run.exit }]
      if (field.field === "refused") return [{ kind: "refused", what: field.refusal.what, form: field.refusal.form }]
      if (field.field === "cannot") return [{ kind: "cannot", tool: field.absent.tool }]
      if (field.field === "waits") return [{ kind: "waits", ref: field.ref }]
      return []
    })
    .slice(0, 1)

const remedyText = (form: Form): string => {
  if (form.kind === "named") return `; form: ${form.form}`
  if (form.kind === "allow") return `; form: ${form.allow}`
  return ""
}
/** A held item's evidence as a report writes it: `<command> (exit <code>)`, else its label's words. */
const heldText = (evidence: HeldEvidence): string => {
  if (evidence.kind === "ran") return `${evidence.command} (exit ${evidence.exit})`
  if (evidence.kind === "refused") return `refused: ${evidence.what}${remedyText(evidence.form)}`
  if (evidence.kind === "cannot") return `cannot run here: ${evidence.tool}`
  return `waits on ${evidence.ref}`
}
/** The capture groups of each whole-text match of `pattern` (anchored, so one at most). */
const groupsOf = (text: string, pattern: RegExp): ReadonlyArray<ReadonlyArray<string>> => [...text.matchAll(new RegExp(pattern.source, "g"))].map((match) => match.slice(1))
const formOf = (kind: "named" | "allow", text: string): Form => {
  if (kind === "named") return { kind, form: text }
  return { kind, allow: text }
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
const sameHeld = (a: HeldEvidence, b: HeldEvidence): boolean => {
  if (a.kind === "ran" && b.kind === "ran") return a.command === b.command && a.exit === b.exit
  if (a.kind === "refused" && b.kind === "refused") return a.what === b.what && sameForm(a.form, b.form)
  if (a.kind === "cannot" && b.kind === "cannot") return a.tool === b.tool
  if (a.kind === "waits" && b.kind === "waits") return a.ref === b.ref
  return false
}

/** The limit as a report writes it: `timebox <its length>` or `failure cap <its count>`. */
const limitText = (limit: Limit): string => {
  if (limit.kind === "timebox") return `timebox ${limit.length}`
  return `failure cap ${limit.count}`
}
const limitRead = (text: string): ReadonlyArray<Limit> => [
  ...groupsOf(text, /^timebox ([\s\S]+)$/).map(([length = ""]): Limit => ({ kind: "timebox", length })),
  ...groupsOf(text, /^failure cap (\d+)$/).map(([count = ""]): Limit => ({ kind: "failureCap", count: Number(count) })),
]
const sameLimit = (a: Limit, b: Limit): boolean => {
  if (a.kind === "timebox" && b.kind === "timebox") return a.length === b.length
  if (a.kind === "failureCap" && b.kind === "failureCap") return a.count === b.count
  return false
}

/** The remedy a refusal printed, by the stop field it fills. */
const remedyValues = (form: Form): ReadonlyArray<StopValue> => {
  if (form.kind === "named") return [{ id: "refused.form", value: form.form }]
  if (form.kind === "allow") return [{ id: "refused.allow", value: form.allow }]
  return []
}

/** The stop's evidence values, each derived from the history it is about. */
const stopValuesOf = (ending: Ending, records: ReadonlyArray<ItemRecord>, held: ReadonlyArray<string>): ReadonlyArray<StopValue> => {
  if (ending.kind === "refusal" || ending.kind === "write") return [{ id: "refused.what", value: ending.refusal.what }, ...remedyValues(ending.refusal.form)]
  if (ending.kind === "limit") return [{ id: "limit", value: limitText(ending.limit) }]
  return records
    .filter((record) => held.includes(record.id))
    .flatMap((record) => heldEvidence(record).map((evidence): StopValue => ({ id: "held", item: record.id, value: heldText(evidence) })))
}

/** The one claim true of the step, using only the role policy and evidence folded from its own envelope. */
const deriveOwed = (policy: Policy, ending: Ending, reads: ReadonlyArray<Read>): Decoded<Owed> => {
  const result = outcome(policy, stopOf(ending), statesOf(ending, reads.map((one) => one.row)))
  if (!result.ok) return fail(`step: ${result.error}`)
  const named = policy.fields.map((field) => field.id)
  const items = reads.map(({ record, row }): HandBack => ({ item: record.id, rule: row.id, label: row.label, fields: record.fields.filter((field) => named.includes(field.field)) }))
  const holding = heldStates(policy.role)
  const held = reads.flatMap(({ row, record }) => iff(holding.includes(row.state), record.id))
  const claim: Claim = { verdict: result.value.verdict, writes: result.value.writes.artifacts, stop: stopValuesOf(ending, reads.map(({ record }) => record), held), items }
  const states = reads.map(({ record, row }): ItemState => ({ item: record.id, rule: row.id, state: row.state, facts: record.facts }))
  return ok(frozen({ claim, states }))
}

/** What this exact issued step owes, with no way to substitute a policy, a record, or different evidence. */
export const owed = (checked: Checked): Decoded<Owed> =>
  Option.match(Option.fromUndefinedOr(issued.get(checked)), {
    onNone: () => fail("a step is checked only by decode, from its envelope"),
    onSome: ok,
  })

/** An item's record with the row a policy gives it. */
interface Read {
  readonly record: ItemRecord
  readonly row: Row
}
const readOf = (policy: Policy, record: ItemRecord): Decoded<Read> => {
  const row = rowOf(policy, record)
  if (!row.ok) return fail(row.error)
  return ok({ record, row: row.value })
}

// ---- a claim, judged against what is owed ---------------------------------------------------------------------------

const RunSchema = Schema.Struct({ id: Text, command: Text, output: OutputSchema, exit: Schema.Int, receipt: Text, head: Text, result: Schema.Literals(RESULTS) })
const PendingSchema = Schema.Struct({ id: Text, command: Text, status: Schema.Literals(PENDING), output: OutputSchema })
const FieldSchema = Schema.Union([
  Schema.Struct({ field: Schema.Literal("completed"), run: RunSchema }),
  Schema.Struct({ field: Schema.Literal("current"), attempt: PendingSchema }),
  Schema.Struct({ field: Schema.Literal("refused"), refusal: RefusalSchema }),
  Schema.Struct({ field: Schema.Literal("cannot"), absent: AbsentSchema }),
  Schema.Struct({ field: Schema.Literal("waits"), ref: Text }),
])
const StopValueSchema = Schema.Union([
  Schema.Struct({ id: Schema.Literals(["refused.what", "refused.form", "refused.allow", "limit"]), value: Text }),
  Schema.Struct({ id: Schema.Literal("held"), item: Text, value: Text }),
])
const HandBackSchema = Schema.Struct({ item: Text, rule: Text, label: Text, fields: Schema.Array(FieldSchema) })
const ClaimSchema = Schema.Struct({ verdict: Text, writes: Schema.Array(Schema.Literals(ARTIFACTS)), stop: Schema.Array(StopValueSchema), items: Schema.Array(HandBackSchema) })
const decodeClaim = Schema.decodeUnknownResult(ClaimSchema, STRICT)

/** Every field of a hand-back that differs from the one owed, each named with both values: member by member. */
const judge = (owed: HandBack, given: HandBack): ReadonlyArray<string> => [
  ...iff(given.rule !== owed.rule, `rule: due ${owed.rule}, given ${given.rule}`),
  ...iff(given.label !== owed.label, `label: due ${owed.label}, given ${given.label}`),
  ...owed.fields.flatMap((want) => {
    const got = given.fields.filter((one) => one.field === want.field)
    const exact = got.length === 1 && got.every((one) => sameField(one, want))
    return iff(!exact, `${want.field}: due ${fieldShown(want)}, given ${got.map(fieldShown).join(" and ") || "none"}`)
  }),
  ...given.fields.flatMap((one) => iff(!owed.fields.some((want) => want.field === one.field), `${one.field}: due none, given ${fieldShown(one)}`)),
]

const heldItem = (value: StopValue): ReadonlyArray<string> => {
  if (value.id === "held") return [value.item]
  return []
}
const stopValueText = (value: StopValue): string => [...heldItem(value).map((item) => `${quoted(item)}: `), quoted(value.value)].join("")

/** A claimed stop value against the derived one, read in that value's own grammar and compared member by member. */
const sameStopValue = (checked: Checked, want: StopValue, got: StopValue): boolean => {
  if (want.id !== got.id || !sameList(heldItem(want), heldItem(got), eq)) return false
  if (want.id === "limit") return limitsOf(checked.ending).some((limit) => limitRead(got.value).some((other) => sameLimit(limit, other)))
  if (want.id !== "held") return want.value === got.value
  // The held entry's evidence, derived again from its item's history, and the claim read in that evidence's grammar.
  const derived = checked.records.filter((record) => record.id === want.item).flatMap(heldEvidence)
  return derived.some((evidence) => heldRead(evidence, got.value).some((one) => sameHeld(one, evidence)))
}
const limitsOf = (ending: Ending): ReadonlyArray<Limit> => {
  if (ending.kind === "limit") return [ending.limit]
  return []
}

const stopFaults = (checked: Checked, want: ReadonlyArray<StopValue>, got: ReadonlyArray<StopValue>): ReadonlyArray<string> =>
  STOP_FIELDS.flatMap((id) => {
    const owed = want.filter((one) => one.id === id)
    const given = got.filter((one) => one.id === id)
    const same = (a: StopValue, b: StopValue) => sameStopValue(checked, a, b)
    const exact = owed.length === given.length && owed.every((one) => given.some((other) => same(one, other))) && given.every((one) => owed.some((other) => same(other, one)))
    return iff(!exact, `stop ${id}: due ${owed.map(stopValueText).join(" and ") || "none"}, given ${given.map(stopValueText).join(" and ") || "none"}`)
  })

const itemFaults = (owed: ReadonlyArray<HandBack>, given: ReadonlyArray<HandBack>): ReadonlyArray<string> => [
  ...owed.flatMap((one) => {
    const matched = given.filter((item) => item.item === one.item)
    if (matched.length !== 1) return [`${one.item}: ${matched.length} hand-backs, not one`]
    return matched.flatMap((item) => judge(one, item).map((line) => `${one.item}: ${line}`))
  }),
  ...given.flatMap((item) => iff(!owed.some((one) => one.item === item.item), `${item.item}: no such item in the step`)),
]

/** Every way a decoded claim differs from the claim the step owes. */
const claimFaults = (checked: Checked, claim: Claim): ReadonlyArray<string> => {
  const due = owed(checked)
  if (!due.ok) return [`ill-formed: ${due.error}`]
  const want = due.value.claim
  return [
    ...iff(claim.verdict !== want.verdict, `verdict: due ${want.verdict}, given ${claim.verdict}`),
    ...iff(!sameList(claim.writes, want.writes, eq), `writes: due [${want.writes.join(", ")}], given [${claim.writes.join(", ")}]`),
    ...stopFaults(checked, want.stop, claim.stop),
    ...itemFaults(want.items, claim.items),
  ]
}

const unreadClaim = (error: Schema.SchemaError): ReadonlyArray<string> => [`claim: ${error.message.replaceAll("\n", " ")}`]

/**
 * Every reason a claim (from anywhere: decoded by its schema, unknown members rejected) does not match what the checked
 * step owes: none means it is admitted. Every value is compared with the one derived from the step's
 * own histories, never with an echo of itself.
 */
export const admit = (checked: Checked) =>
  readUnknown(
    flow(decodeClaim, Result.match({ onFailure: unreadClaim, onSuccess: (claim: Claim) => claimFaults(checked, claim) })),
    () => ["claim: could not read the value"],
  )

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
