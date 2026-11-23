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
//   evidence    an item's record holds its facts and its content-bound evidence fields (attempt ids, commands,
//               output digests, receipts, heads, refusal scope and form, probes, wait refs); `due(policy, record)`
//               is the hand-back the delivered policy owes for it, `judge(due, given)` every field that differs;
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
export const PENDING = ["started", "interrupted", "denied", "not-started"] as const
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
/** The states whose items hold a step back: what the `held` collection names, one entry each. */
export const HOLDS_BACK = ["runnable", "waits", "refused", "cannot", "unclear"] as const satisfies ReadonlyArray<State>
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
const STOP_AUTHORED = {
  planner: {
    refusalForm: REMEDY,
    refusalNone: [WHAT],
    limit: [{ id: "limit", presence: "always", text: "the clock (the timebox) or the count (the failure cap)" }],
    idle: [{ id: "held", presence: "perHeld", text: "what you tried for the item, the options and your pick" }],
  },
  verifier: {
    refusalForm: REMEDY,
    refusalNone: [WHAT],
    idle: [{ id: "held", presence: "perHeld", text: "the check, with its command and exit code" }],
  },
  worker: {
    refusalForm: REMEDY,
    refusalNone: [WHAT],
    idle: [{ id: "held", presence: "perHeld", text: "what holds the item back" }],
  },
} as const satisfies { readonly [K in "planner" | "verifier" | "worker"]: { readonly [S in Stop]?: ReadonlyArray<StopField> } }

const stopAuthored = (role: Role, stop: Stop): ReadonlyArray<StopField> => {
  if (role === "planner" || role === "implementor") return STOP_AUTHORED.planner[stop]
  if (stop === "limit") return []
  return STOP_AUTHORED[role][stop]
}

export const FIELD_TEXT = {
  completed: "the last attempt that finished: its id, the command it ran, its output's digest, its exit code, its receipt, the head it ran at and its result",
  current: "an attempt newer than that, with no result: its id, its command, its status (started, interrupted, denied or not started) and its partial output's digest or why it has none",
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
export const STOPS_LEAD = "Why the step stopped gives the evidence fields you write; leave out a field with no value, never a placeholder:"
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

const has = (record: ItemRecord, id: FieldId): boolean => record.fields.some((one) => one.field === id)
const isResult = (attempt: Attempt): boolean => RESULTS.some((one) => one === attempt)
/** Each a string with a character other than white space: an empty or missing value is no value. */
const filled = (...texts: ReadonlyArray<string>): boolean => texts.every((one) => one === String(one) && one.trim().length > 0)
const outputOk = (output: Output): boolean => (output.kind === "missing" && MISSING.includes(output.why)) || ((output.kind === "log" || output.kind === "partial") && filled(output.digest))
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

const fieldFaults = (field: Field, facts: Facts): ReadonlyArray<string> => {
  const keys = keyFaults(field)
  const unknown = iff(keys.length > 0, `\`${field.field}\` holds unknown keys [${keys.join(", ")}]: no flag stands in for evidence`)
  if (field.field === "completed") {
    const run = field.run
    const empty = !filled(run.id, run.command, run.receipt, run.head) || !outputOk(run.output) || !Number.isInteger(run.exit)
    return [...unknown, ...iff(empty, "`completed` lacks its id, command, output, exit, receipt or head"), ...iff(run.result !== facts.attempt, `\`completed\` holds result ${run.result}, the facts ${facts.attempt}`)]
  }
  if (field.field === "current") {
    const bad = !filled(field.attempt.id, field.attempt.command) || !PENDING.includes(field.attempt.status) || !outputOk(field.attempt.output) || field.attempt.output.kind === "log"
    return [...unknown, ...iff(bad, "`current` lacks its id, command or status, or claims a finished log")]
  }
  if (field.field === "refused") {
    const r = field.refusal
    const form = r.form.kind === "none" || (r.form.kind === "named" && filled(r.form.form)) || (r.form.kind === "allow" && filled(r.form.allow))
    return [...unknown, ...iff(!filled(r.what, r.scope, r.report) || !form, "`refused` lacks what, scope or report, or holds an empty form or allow rule (a refusal that named none holds `none`)")]
  }
  if (field.field === "cannot") return [...unknown, ...iff(!filled(field.absent.tool, field.absent.probe) || !outputOk(field.absent.output), "`cannot` lacks its tool, probe or output")]
  return [...unknown, ...iff(!filled(field.ref), "`waits` lacks its ref")]
}

const attemptIds = (record: ItemRecord): ReadonlyArray<string> =>
  record.fields.flatMap((one) => {
    if (one.field === "completed") return [one.run.id]
    if (one.field === "current") return [one.attempt.id]
    return []
  })

/**
 * Why an item's facts are none a step of this role can reach: the facts the item histories generate, and only
 * those, pass (skills/orchestrate/scripts/item-histories.ts derives the same set independently, by its events).
 */
export const factsFaults = (role: Role, facts: Facts): ReadonlyArray<string> => {
  const flags = [facts.assigned, facts.required, facts.settled, facts.refused, facts.hostCannot, facts.wait].every(isFlag)
  if (!flags || !ATTEMPTS.includes(facts.attempt) || !PROVENANCES.includes(facts.provenance)) return ["the facts are not an item's facts"]
  return [...assignmentFaults(role, facts), ...attemptFaults(role, facts)]
}

const obstructed = (facts: Facts): boolean => facts.refused || facts.hostCannot || facts.wait

/** Whose work the item is: a finding outside the assignment, optional work, provenance. */
const assignmentFaults = (role: Role, facts: Facts): ReadonlyArray<string> => {
  const outside = !facts.assigned
  return [
    ...iff((role === "verifier" && outside) !== (facts.provenance !== "none"), "a provenance belongs exactly to a verifier's finding outside its assignment"),
    ...iff(outside && (facts.attempt !== "never" || !facts.settled || obstructed(facts) || facts.required), "work outside the assignment is never attempted, required or held back, and is settled as found"),
    ...iff(facts.assigned && !facts.required && role !== "verifier", "only a verifier has optional work"),
  ]
}

/** What its attempts and obstacles leave: settled only by a result that settles it, a refusal only after an attempt. */
const attemptFaults = (role: Role, facts: Facts): ReadonlyArray<string> => {
  const verifier = role === "verifier"
  return [
    ...iff(facts.assigned && facts.settled && !isResult(facts.attempt), "a settled item is settled by a result"),
    ...iff(!verifier && facts.assigned && facts.settled && facts.attempt !== "pass", "only its acceptance holding settles a planner's, implementor's or worker's item"),
    ...iff(verifier && facts.attempt === "fail" && !facts.settled, "a verifier's failed check is a proof, which settles it"),
    ...iff(facts.refused && facts.attempt === "never", "a refusal answers an attempt"),
    ...iff(facts.attempt === "pass" && !facts.settled, "a passed item is settled"),
    ...iff(facts.settled && obstructed(facts), "a settled item meets no obstacle"),
  ]
}

const presence = (record: ItemRecord): ReadonlyArray<readonly [boolean, string]> => {
  const { facts } = record
  return [
    [!facts.assigned && record.fields.length > 0, "work outside the assignment carries no attempt or obstacle evidence"],
    [has(record, "completed") !== isResult(facts.attempt), `\`completed\` is due exactly when an attempt finished (facts: ${facts.attempt})`],
    [facts.attempt === "started" && !has(record, "current"), "an attempt with no result yet needs its `current` field"],
    [facts.attempt === "never" && has(record, "current"), "an item never attempted has no `current` attempt"],
    [has(record, "refused") !== facts.refused, "`refused` is due exactly when a refusal holds the item"],
    [has(record, "cannot") !== facts.hostCannot, "`cannot` is due exactly when this host cannot run the item"],
    [has(record, "waits") !== facts.wait, "`waits` is due exactly when a wait holds the item"],
    [unique(attemptIds(record)).length > 0, "`current` and `completed` are the same attempt"],
  ]
}

/**
 * Why a record is no step's item for this role: its facts are unreachable, its evidence disagrees with them, or a
 * field is empty, doubled or carries keys beyond its shape. A valid empty field set is no fault.
 */
export const recordFaults = (role: Role, record: ItemRecord): ReadonlyArray<string> => {
  const facts = factsFaults(role, record.facts)
  if (facts.length > 0) return [...iff(!filled(record.id), "the item has no id"), ...facts]
  return [
    ...iff(!filled(record.id), "the item has no id"),
    ...unique(record.fields.map((one) => one.field)).map((id) => `\`${id}\` stands twice`),
    ...record.fields.flatMap((one) => iff(!FIELDS.includes(one.field), `\`${one.field}\` is no evidence field`)),
    ...presence(record).flatMap(([bad, why]) => iff(bad, why)),
    ...record.fields.filter((one) => FIELDS.includes(one.field)).flatMap((field) => fieldFaults(field, record.facts)),
  ]
}

/** The first row of a policy true of an item with these atoms (the catch-all when none above is). */
export const decide = (policy: Policy, atoms: ReadonlySet<Atom>): ReadonlyArray<Row> => firstOf(policy.rows, (row) => row.when === "otherwise" || row.when.every((atom) => atoms.has(atom)))

/** What a hand-back must hold for one item: the row's rule and label, and every evidence field the policy names that the record holds. */
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

/** The hand-back a policy owes for a record, or the typed rejection of a record no step of its role reaches. */
export const due = (policy: Policy, record: ItemRecord): Decoded<Due> => {
  const faults = recordFaults(policy.role, record)
  if (faults.length > 0) return fail(`${record.id}: ${faults.join("; ")}`)
  const named = policy.fields.map((field) => field.id)
  const rows = decide(policy, truths([record.facts])).map((row) => ({ item: record.id, rule: row.id, state: row.state, label: row.label, fields: record.fields.filter((field) => named.includes(field.field)) }))
  return firstFound(rows, `${record.id}: no row is true`)
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
 * A stop evidence field's value: one of a single-valued field, or one `held` entry naming the item it is for. A field
 * the refusal did not print, or a `held` collection with nothing held, is told by leaving the entries out.
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

/** The remedy a refusal printed for one stop field: the `!` command for `refused.form`, the allow rule for `refused.allow`. */
const remedyOf = (form: Form, id: StopFieldId): ReadonlyArray<string> => {
  if (form.kind === "named" && id === "refused.form") return [form.form]
  if (form.kind === "allow" && id === "refused.allow") return [form.allow]
  return []
}

/** The refusal the step stopped on, bound to the refused item's own record: what it said and the remedy it printed, if any. */
const refusalFaults = (stop: Stop, fields: ReadonlyArray<StopField>, values: ReadonlyArray<StopValue>, items: ReadonlyArray<ItemRecord>): ReadonlyArray<string> => {
  const refusals = items.flatMap((record) => record.fields.flatMap((field) => [field].filter((one) => one.field === "refused")))
  return refusals.flatMap((field) => {
    if (field.field !== "refused") return []
    const { what, form } = field.refusal
    const printed = form.kind !== "none"
    return [
      ...values.flatMap((one) => iff(one.id === "refused.what" && one.value !== what, `refused.what: the refused item's record says ${what}, the stop ${one.value}`)),
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

/** Why a recorded stop is none this step reached: a field it lacks or doubles, an empty value, an entry for no held item. */
export const stopRecordFaults = (policy: Policy, step: Step, owed: ReadonlyArray<Due>): ReadonlyArray<string> => {
  const fields = policy.stops.filter((one) => one.stop === step.stop.stop).flatMap((one) => one.fields)
  const states: ReadonlyArray<State> = HOLDS_BACK
  const held = owed.flatMap((one) => [one.item].filter(() => states.includes(one.state)))
  const values = step.stop.values
  return [
    ...values.flatMap((one) => iff(!fields.some((field) => field.id === one.id), `${one.id}: this stop has no such field`)),
    ...values.flatMap((one) => iff(!filled(one.value), `${one.id}: an empty value is no value; leave the field out to tell its absence`)),
    ...fields.flatMap((field) => countFaults(field, values.filter((one) => one.id === field.id), held)),
    ...refusalFaults(step.stop.stop, fields, values, step.items),
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
  const owed = allOk(step.items.map((record) => due(policy, record)))
  if (!owed.ok) return [`ill-formed item: ${owed.error}`]
  const result = outcome(
    policy,
    step.stop.stop,
    owed.value.map((one) => one.state),
  )
  if (!result.ok) return [`ill-formed step: ${result.error}`]
  const recorded = stopRecordFaults(policy, step, owed.value)
  if (recorded.length > 0) return recorded.map((line) => `ill-formed stop record: ${line}`)
  const { verdict, writes } = result.value
  return [
    ...iff(claim.verdict !== verdict, `verdict: due ${verdict}, given ${claim.verdict}`),
    ...iff(!sameList(claim.writes, writes.artifacts, eq), `writes: due [${writes.artifacts.join(", ")}], given [${claim.writes.join(", ")}]`),
    ...stopFaults(step.stop.values, claim.stop),
    ...itemFaults(owed.value, claim),
  ]
}
