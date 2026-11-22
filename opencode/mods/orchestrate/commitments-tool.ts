// The `commitments` tool (the root's) and the `follow_up` tool (a worker's), pure: their inputs, their descriptions,
// each call's command for the record (record.ts), and the words of every answer, the record's section among them (what
// `orchestrate status`, every land and the queue check say of the record). The plugin (cmd/orchestrate/server.ts) runs
// the commands on the CommitmentRecord and reads the facts a standing needs (`factsOf`) at each call; nothing of a run
// is kept between calls. Nothing here reads prose: every field is the call's own.
import { Array as Arr, Effect, flow, Match, Option, Order, Predicate, Result, Schema, SchemaAST, SchemaIssue, SchemaParser, SchemaTransformation } from "effect"
import { toolInput } from "@dotfiles/decider/tool-input"
import { redact } from "@dotfiles/opencode-digest/redact"
import {
  AfterItem,
  Command,
  type Commitment,
  PartInput,

  msOf,
  noticesOf,
  OWNER_KINDS,
  RANKS,
  ROOT,
  type RecordEvent,
  type RecordRefused,
  type Actor,

  type Snapshot,
  SOURCE_KINDS,
  type StoredEvent,
} from "./record.ts"
import { CommitmentRecord, Evidence, type EvidenceRefused, type MainLine, type RecordFailed } from "./service.ts"
import { dataOf, EVIDENCE_ROOT, lineOf, type Reason, REASON_CLASSES, type ReasonData, type ReceiptSeen, ReferentInput, reasonFrom } from "./reasons.ts"
import { type Lane, lanesOf } from "./tools.ts"
import { asked, type Facts, LISTED, ownersOf, type Standing, STANDINGS, standingOf, standingsOf, unroutedOf } from "./standing.ts"

export const COMMITMENTS = "commitments"
export const FOLLOW_UP = "follow_up"
/** The run a call names none of: one record holds every run of its repository, `run` a column. */
export const DEFAULT_RUN = "default"
/** The ids the section names of each standing, at most. */
export const SECTION_IDS = 10

export const ACTIONS = ["add", "assign", "order", "release", "decide", "defer", "reopen", "word", "route", "landed", "invariant", "list", "history", "import"] as const
export type Action = (typeof ACTIONS)[number]

const Part = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  part: Schema.optional(Schema.String),
  rank: Schema.optional(Schema.Literals(RANKS)),
  owner_lane: Schema.optional(Schema.String),
  after: Schema.optional(Schema.Array(AfterItem)),
  review_by: Schema.optional(Schema.String),
})

/** The names a tool input's struct declares, at any depth: the only keys a refusal names. */
const declaredNames = (ast: SchemaAST.AST): ReadonlyArray<string> =>
  Match.value(ast).pipe(
    Match.tag("Objects", (objects) => objects.propertySignatures.flatMap((each) => [String(each.name), ...declaredNames(each.type)])),
    Match.tag("Union", (union) => union.types.flatMap(declaredNames)),
    Match.tag("Arrays", (arrays) => [...arrays.elements, ...arrays.rest].flatMap(declaredNames)),
    Match.tag("Declaration", (declaration) => declaration.typeParameters.flatMap(declaredNames)),
    Match.orElse(() => []),
  )

/** One thing wrong with a call, where it is: a key it does not take, a key it lacks, or a value its field does not take. */
interface Flaw {
  readonly kind: "stray" | "missing" | "value"
  readonly path: ReadonlyArray<PropertyKey>
}

/** The flaws an issue holds, by their places: what a union or a check wanted stays with the schema, never with the call. */
const flawsOf = (issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>): ReadonlyArray<Flaw> =>
  Match.value(issue).pipe(
    Match.tag("Pointer", (pointer) => flawsOf(pointer.issue, [...path, ...pointer.path])),
    Match.tag("Composite", (composite) => composite.issues.flatMap((each) => flawsOf(each, path))),
    // A union none of whose forms took the value: the flaws inside the forms that came closest, else the value itself.
    Match.tag("AnyOf", (any) => Arr.match(any.issues, { onEmpty: (): ReadonlyArray<Flaw> => [{ kind: "value", path }], onNonEmpty: (issues) => issues.flatMap((each) => flawsOf(each, path)) })),
    Match.tag("UnexpectedKey", (): ReadonlyArray<Flaw> => [{ kind: "stray", path }]),
    Match.tag("MissingKey", (): ReadonlyArray<Flaw> => [{ kind: "missing", path }]),
    Match.orElse((): ReadonlyArray<Flaw> => [{ kind: "value", path }]),
  )

/**
 * A call's refusal in words that repeat nothing the caller wrote: a declared field by its name, an element by its index,
 * and a key the input does not take by its position among its object's keys, never by its text or its value.
 */
export const decodeRefusal = (issue: SchemaIssue.Issue, keysAt: (path: ReadonlyArray<PropertyKey>) => ReadonlyArray<string>, names: ReadonlySet<string>): string => {
  const segment = (key: PropertyKey) =>
    Match.value(key).pipe(
      Match.when(Match.number, (index) => `[${index}]`),
      Match.when((name: PropertyKey) => Predicate.isString(name) && names.has(name), (name) => `.${String(name)}`),
      Match.orElse(() => ".<a key not repeated>"),
    )
  const where = (path: ReadonlyArray<PropertyKey>) => Arr.match(path, { onEmpty: () => "the call", onNonEmpty: (keys) => `the call's ${keys.map(segment).join("").slice(1)}` })
  const flaws = flawsOf(issue, [])
  const strays = Arr.groupBy(Arr.filter(flaws, (flaw) => flaw.kind === "stray"), (flaw) => flaw.path.slice(0, -1).map(String).join("\u0000"))
  const stray = Object.values(strays).map((group) => {
    const parent = group[0].path.slice(0, -1)
    const keys = keysAt(parent)
    const positions = group.map((flaw) => keys.indexOf(String(flaw.path.at(-1))) + 1)
    return `${where(parent)} takes no key at position ${positions.join(", ")} of its ${keys.length} (${group.length} refused); a key's text is not repeated`
  })
  const rest = Arr.filter(flaws, (flaw) => flaw.kind !== "stray").map((flaw) =>
    Match.value(flaw.kind).pipe(
      Match.when("missing", () => `${where(flaw.path)} is missing`),
      Match.orElse(() => `${where(flaw.path)} is not a value it takes; the value is not repeated`),
    ),
  )
  return [...stray, ...rest].join("; ")
}

/**
 * A tool input that refuses a key its struct does not take, where a plain one drops it: a caller's `validated: true` or
 * any word of its own beside a reason is refused, never read as part of one (reasons.ts). Its JSON Schema is the struct's.
 * Every refusal of its decode is `decodeRefusal`'s, on the tool and the CLI alike: no key or value the caller wrote.
 */
const exactInput = <S extends Schema.Struct<Schema.Struct.Fields>>(struct: S) =>
  Schema.declareConstructor<S["Type"], S["Encoded"]>()(
    [toolInput(struct)],
    ([codec]) => {
      const names = new Set(declaredNames(struct.ast))
      return (input, _ast, options) => {
        const keysAt = (path: ReadonlyArray<PropertyKey>) =>
          Arr.reduce(path, Option.some(input), (at, key) => Option.flatMap(at, (value) => Option.liftPredicate(Predicate.isObjectOrArray)(value).pipe(Option.flatMap((held) => Arr.findFirst(Object.entries(held), ([name]) => name === String(key))), Option.map(([, inner]) => inner)))).pipe(
            Option.filter(Predicate.isObject),
            Option.match({ onNone: () => [], onSome: (held) => Object.keys(held) }),
          )
        return Effect.mapError(
          SchemaParser.decodeUnknownEffect(codec)(input, { ...options, onExcessProperty: "error", errors: "all" }),
          (issue) => new SchemaIssue.InvalidValue({ message: decodeRefusal(issue, keysAt, names) }),
        )
      }
    },
    {
      expected: "object",
      toCodecJson: () => Schema.link<S["Type"]>()(struct, SchemaTransformation.passthrough({ strict: false })),
    },
  )

export const CommitmentsInput = exactInput(
  Schema.Struct({
    action: Schema.Literals(ACTIONS).annotate({
      description:
        "add: N commitments from an approval or a plan, one per part (the call that records an owner's approval). assign: own or re-own one, with its waits and review-by time. order: start an owner's commitments; answers all its open ones. release: give one up. decide: close one by decision, with why and a guarantee (reason_class guarantee, referent an invariant). defer: keep one open with why it waits (a dependency or a measurement); it closes nothing. reopen: undo a decision; its reason is cleared, its history kept. invariant: declare a named invariant of this repository (id, doc_path of a committed document, anchor), which a guarantee then names. word: give a manual wait's word. route: answer a hand-back. landed: the commit on the default branch that holds one's work, when no land recorded it (a land by hand, another tool's). list, history: read. import: an Ergo register, table to table.",
    }),
    run: Schema.optional(Schema.String).annotate({ description: `add, word, list: the run (default "${DEFAULT_RUN}").` }),
    source_kind: Schema.optional(Schema.Literals(SOURCE_KINDS)).annotate({ description: "add: where the commitments come from. owner-answer and owner-ask are the owner's: closing one by decision tells the owner." }),
    source_ref: Schema.optional(Schema.String).annotate({ description: "add: a pointer to the source: `<session>:<question id>`, `plan.md:12`, a spec's path." }),
    quote: Schema.optional(Schema.String).annotate({ description: "add: the owner's words, one line of at most 200 characters (owner-answer, owner-ask only)." }),
    plan: Schema.optional(Schema.String).annotate({ description: "add: the plan or placeholder commitment the parts split." }),
    parts: Schema.optional(Schema.Array(Part)).annotate({
      description: "add: the parts, one commitment each: { id (a slug), title (one line), part?, rank? (A-D), owner_lane?, after? [{ kind, ref }], review_by? (ISO time) }.",
    }),
    id: Schema.optional(Schema.String).annotate({ description: "assign, release, decide, reopen, landed, history: the commitment." }),
    head: Schema.optional(Schema.String).annotate({ description: "landed: the commit (7 to 40 hex digits) that holds its work; it lands once git has it on the default branch." }),
    owner_lane: Schema.optional(Schema.String).annotate({ description: "assign, order: the owner (a unit, or `root`)." }),
    owner_session: Schema.optional(Schema.String).annotate({ description: "assign: the owner's session, when one holds it." }),
    after: Schema.optional(Schema.Array(AfterItem)).annotate({
      description: "assign: what it waits on, each { kind: commit-on-main | commitment-closed | date | manual, ref }; empty: due now.",
    }),
    review_by: Schema.optional(Schema.String).annotate({ description: "assign: when it is overdue if still open (ISO time; default 7 days)." }),
    ids: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "order: the commitments to start." }),
    why: Schema.optional(Schema.String).annotate({ description: "decide: the reason, one line." }),
    reason_class: Schema.optional(Schema.Literals(REASON_CLASSES)).annotate({
      description: "decide, defer: guarantee (decide: a declared invariant the close rests on), dependency (defer: an open commitment it waits on), measured (defer: a receipt that orders it; never closes).",
    }),
    referent: Schema.optional(ReferentInput).annotate({
      description: `decide, defer: what the reason points at, checked by the plugin: { kind: "invariant", id } | { kind: "commitment", id } | { kind: "receipt", path } (a receipt envelope under ${EVIDENCE_ROOT}/ of this checkout). spec-item, unit and owner-question are refused until their units ship.`,
    }),
    doc_path: Schema.optional(Schema.String).annotate({ description: "invariant: the document that states it, a path in this checkout committed at HEAD." }),
    anchor: Schema.optional(Schema.String).annotate({ description: "invariant: its heading's anchor in that document (a slug)." }),
    word: Schema.optional(Schema.String).annotate({ description: "word: the word a manual wait names." }),
    hand_back: Schema.optional(Schema.Int).annotate({ description: "route: the hand-back's number." }),
    as: Schema.optional(Schema.Literals(["routed", "rejected"])).annotate({ description: "route: routed (acted on) or rejected." }),
    owner: Schema.optional(Schema.String).annotate({ description: "list: one owner's (`-` for unowned)." }),
    standing: Schema.optional(Schema.Literals(STANDINGS)).annotate({ description: "list: one standing's." }),
    age: Schema.optional(Schema.Finite).annotate({ description: "list: only those older than this many days." }),
    all: Schema.optional(Schema.Boolean).annotate({ description: "list: closed ones too." }),
    from: Schema.optional(Schema.String).annotate({ description: "import: the register's SQLite file (a copy)." }),
    map: Schema.optional(Schema.Literals(["ergo-register"])).annotate({ description: "import: the mapping, ergo-register." }),
  }),
)
export type CommitmentsInput = typeof CommitmentsInput.Type
type Field = Exclude<keyof CommitmentsInput, "action">

/** The fields each action takes, and the ones it needs. */
export const FIELDS = {
  add: ["run", "source_kind", "source_ref", "quote", "plan", "parts"],
  assign: ["id", "owner_lane", "owner_session", "after", "review_by"],
  order: ["owner_lane", "ids"],
  release: ["id"],
  decide: ["id", "why", "reason_class", "referent"],
  defer: ["id", "reason_class", "referent"],
  reopen: ["id"],
  word: ["run", "word"],
  route: ["hand_back", "as"],
  landed: ["id", "head"],
  invariant: ["id", "doc_path", "anchor"],
  list: ["owner", "standing", "run", "age", "all"],
  history: ["id"],
  import: ["run", "from", "map"],
} as const satisfies { readonly [A in Action]: ReadonlyArray<Field> }
export const REQUIRED = {
  add: ["source_kind", "source_ref", "parts"],
  assign: ["id", "owner_lane"],
  order: ["owner_lane", "ids"],
  release: ["id"],
  decide: ["id", "why", "reason_class", "referent"],
  defer: ["id", "reason_class", "referent"],
  reopen: ["id"],
  word: ["word"],
  route: ["hand_back", "as"],
  landed: ["id", "head"],
  invariant: ["id", "doc_path", "anchor"],
  list: [],
  history: ["id"],
  import: ["from", "map"],
} as const satisfies { readonly [A in Action]: ReadonlyArray<Field> }

const ALL_FIELDS: ReadonlyArray<Field> = Arr.dedupe(ACTIONS.flatMap((action): ReadonlyArray<Field> => FIELDS[action]))

/** A call as its arguments are written, for an answer that names the next one. */
export const callOf = (action: Action, fields: ReadonlyArray<readonly [string, string]> = []): string =>
  `${COMMITMENTS}({ action: "${action}"${fields.map(([field, value]) => `, ${field}: ${value}`).join("")} })`

/** The call that lists every open commitment of `standing`. */
export const listCallOf = (standing: Standing): string => callOf("list", [["standing", `"${standing}"`]])

export const COMMITMENTS_DESCRIPTION = [
  "The record of what this repository's runs owe: one commitment per promised outcome, kept in a SQLite file on this host, never in prose.",
  `Record an owner's approval in the same turn: ${callOf("add", [["source_kind", '"owner-answer"'], ["source_ref", '"<session>:<q id>"'], ["quote", '"<their words>"'], ["parts", '[{ id: "auth-1", title: "…" }, …]']])}: one commitment per part, so no later part is lost.`,
  "Each open commitment has one standing, computed at each read: unowned, orphaned (its owner's lane is gone), overdue (past its review-by time), due (every wait met, not started) or held. orchestrate status, every land and the queue check list all but held.",
  "assign owns it (re-owning keeps it open; every owned one has a review-by time, 7 days by default). order starts an owner's and answers all its open ones. decide closes one with a reason; one the owner approved tells the owner, who can have it reopened. A unit's commitment lands when a land (orchestrate land, the work tool's) or the root's landed names the commit that holds its work, and git has that commit on the default branch; no read claims a commit. A lane removed with no land is orphaned until the root says landed, decide or assign.",
  "The root's tool: a subagent files what it finds with follow_up instead.",
].join("\n")

export const FollowUpInput = exactInput(
  Schema.Struct({
    id: Schema.String.annotate({ description: "A slug for it, unique in the repository: letters, digits, ., _ and -." }),
    title: Schema.String.annotate({ description: "What is owed, one line of at most 200 characters." }),
    rank: Schema.optional(Schema.Literals(RANKS)).annotate({ description: "A (most) to D, only to sort." }),
    reason_class: Schema.Literals(["dependency", "measured"]).annotate({
      description: "Why it is not done now: dependency (it waits on an open commitment) or measured (a receipt orders it). Difficulty, effort and size are not reasons.",
    }),
    referent: ReferentInput.annotate({
      description: `What the reason points at, checked by the plugin: { kind: "commitment", id } for a dependency, { kind: "receipt", path } (a receipt envelope under ${EVIDENCE_ROOT}/) for a measurement.`,
    }),
    suggest_owner: Schema.optional(Schema.String).annotate({ description: "The lane you think should own it; the root decides." }),
    key: Schema.optional(Schema.String).annotate({ description: "An idempotency key of your own for this filing (a slug): a retry with the same key files nothing again. Default: the call's id." }),
    run: Schema.optional(Schema.String).annotate({ description: `The run (default "${DEFAULT_RUN}").` }),
  }),
)
export type FollowUpInput = typeof FollowUpInput.Type

export const FOLLOW_UP_DESCRIPTION = [
  "File one follow-up you found and will not do now (a missing test, a bug beside your scope, work outside your spec's Owns): one unowned commitment in the run's record, listed to the root at every status and land until it owns or decides it.",
  "It replaces a Follow-ups line in state.md or findings: file it here and name its id there.",
].join("\n")

// ── Input → command ──

const fieldsIn = (input: CommitmentsInput): ReadonlyArray<Field> => ALL_FIELDS.filter((field) => Predicate.isNotUndefined(input[field]))

/** Why a call's fields do not fit its action, else none. */
export const inputRefusal = (input: CommitmentsInput): Option.Option<string> => {
  const takes: ReadonlyArray<Field> = FIELDS[input.action]
  const needs: ReadonlyArray<Field> = REQUIRED[input.action]
  const stray = Arr.findFirst(fieldsIn(input), (field) => !takes.includes(field))
  const missing = Arr.findFirst(needs, (field) => Predicate.isUndefined(input[field]))
  return Option.firstSomeOf([
    Option.map(stray, (field) => `${COMMITMENTS}: ${input.action} takes no ${field}; it takes ${takes.join(", ")}.`),
    Option.map(missing, (field) => `${COMMITMENTS}: ${input.action} needs ${field}.`),
  ])
}

/** The parent's refusal of a subagent's call. */
export const PARENT_REFUSAL = `${COMMITMENTS}: the root's tool. A subagent files what it finds with ${FOLLOW_UP}({ id, title, suggest_owner? }) and names the rest in its hand-back.`


/** An ISO time as epoch ms, or why not; none when none is given. */
const msIn = (what: string, iso: Option.Option<string>): Result.Result<Option.Option<number>, string> =>
  Option.match(iso, {
    onNone: () => Result.succeed(Option.none()),
    onSome: (text) =>
      Result.fromOption(
        Option.liftPredicate(msOf(text), (ms) => !Number.isNaN(ms)).pipe(Option.map(Option.some)),
        () => `${COMMITMENTS}: ${what} "${text.slice(0, 60)}" is not an ISO time`,
      ),
  })

const partOf = (part: typeof Part.Type): Result.Result<PartInput, string> =>
  Result.map(msIn(`the review_by of ${part.id}`, Option.fromUndefinedOr(part.review_by)), (reviewBy) =>
    PartInput.make({ id: part.id, title: part.title, part: Option.fromUndefinedOr(part.part), rank: Option.fromUndefinedOr(part.rank), ownerLane: Option.fromUndefinedOr(part.owner_lane), after: Option.fromUndefinedOr(part.after), reviewBy }),
  )

const addOf = (input: CommitmentsInput): Result.Result<Command, string> =>
  Result.map(Result.all((input.parts ?? []).map(partOf)), (parts) =>
    Command.cases.add.make({
      run: input.run ?? DEFAULT_RUN,
      sourceKind: input.source_kind ?? "plan-part",
      sourceRef: input.source_ref ?? "",
      quote: Option.fromUndefinedOr(input.quote),
      plan: Option.fromUndefinedOr(input.plan),
      parts,
    }),
  )

const assignOf = (input: CommitmentsInput): Result.Result<Command, string> =>
  Result.map(msIn("the review_by", Option.fromUndefinedOr(input.review_by)), (reviewBy) =>
    Command.cases.assign.make({ id: input.id ?? "", ownerLane: input.owner_lane ?? "", ownerSession: Option.fromUndefinedOr(input.owner_session), after: input.after ?? [], reviewBy }),
  )

/** A writing action's command for the record, or why the input does not make one; the record refuses what it does not take. */
export const commandOf = (input: CommitmentsInput, action: Exclude<Action, "list" | "history" | "import" | "landed" | "defer" | "invariant">): Result.Result<Command, string> => {
  const id = input.id ?? ""
  return Match.value(action).pipe(
    Match.when("add", () => addOf(input)),
    Match.when("assign", () => assignOf(input)),
    Match.when("order", () => Result.succeed(Command.cases.order.make({ ownerLane: input.owner_lane ?? "", ids: input.ids ?? [] }))),
    Match.when("release", () => Result.succeed(Command.cases.release.make({ id }))),
    Match.when("decide", () => Result.map(reasonOfInput(COMMITMENTS, input), (reason) => Command.cases.decide.make({ id, why: input.why ?? "", reason: dataOf(reason) }))),
    Match.when("reopen", () => Result.succeed(Command.cases.reopen.make({ id }))),
    Match.when("word", () => Result.succeed(Command.cases.word.make({ run: input.run ?? DEFAULT_RUN, word: input.word ?? "" }))),
    Match.when("route", () => Result.succeed(Command.cases.route.make({ handBack: input.hand_back ?? 0, as: input.as ?? "routed" }))),
    Match.exhaustive,
  )
}

/** A call's `{ reason_class, referent }`, checked and canonicalised (reasons.ts `reasonFrom`), or why not; a call with neither has none. */
const reasonOfInput = (tool: string, input: Pick<CommitmentsInput, "reason_class" | "referent">): Result.Result<Reason, string> =>
  Result.mapError(
    Result.flatMap(
      Result.fromOption(Option.all([Option.fromUndefinedOr(input.reason_class), Option.fromUndefinedOr(input.referent)]), () => "a reason names both reason_class and referent"),
      ([reasonClass, referent]) => reasonFrom(reasonClass, referent),
    ),
    (why) => `${tool}: ${why}`,
  )

/** A reason the record keeps, and the receipt the evidence reader read when it is a measurement: never a caller's word. */
export const observedReason = (tool: string, reason: Reason, checkout: string) =>
  Effect.gen(function* () {
    const referent = reason.referent
    if (referent.kind !== "receipt") return { reason: dataOf(reason), observed: Option.none<ReceiptSeen>() } satisfies Observed
    const evidence = yield* Evidence
    const seen = yield* Effect.mapError(evidence.receipt(checkout, referent.path), (refused: EvidenceRefused) => `${tool}: ${refused.reason}`)
    return { reason: dataOf(reason), observed: Option.some(seen) } satisfies Observed
  })

/** An idempotency key: a slug. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** A worker's follow-up as the record's `add`: one unowned `follow-up` commitment, its source the call. */
/** A reason as the record takes it: its data, and the receipt the evidence reader read for a measurement. */
export interface Observed {
  readonly reason: ReasonData
  readonly observed: Option.Option<ReceiptSeen>
}

/**
 * A worker's follow-up as the record's `add`: one unowned `follow-up` commitment, its source the session and the call's
 * idempotency key (its `key`, else the call's id), so a retry with the same key files nothing again.
 */
export const followUpCommandOf = (input: FollowUpInput, sessionID: string, callID: string, reason: Observed): Command =>
  Command.cases.add.make({
    run: input.run ?? DEFAULT_RUN,
    sourceKind: "follow-up",
    sourceRef: `${sessionID}:${input.key ?? callID}`,
    suggestOwner: Option.fromUndefinedOr(input.suggest_owner),
    parts: [PartInput.make({ id: input.id, title: input.title, rank: Option.fromUndefinedOr(input.rank) })],
    reason: Option.some(reason.reason),
    observed: reason.observed,
  })

// ── Facts ──

/** Whether `commit` is on the default branch of `checkout` (an ancestor of its tip `tip`), as git says. */
const onMainOf = (mainLine: MainLine["Service"], checkout: string, tip: string) => (commit: string) =>
  Effect.gen(function* () {
    const known = yield* mainLine.commitOf(checkout, commit)
    if (Option.isNone(known)) return false
    return (yield* mainLine.between(checkout, tip, known.value)).length === 0
  })

/**
 * The facts a read of `snapshot` needs: now, which of the commits it asks about are on the default branch (none when
 * no default branch reads), and which owners are gone (`gone`, the lanes' answer).
 */
export const factsOf = (mainLine: MainLine["Service"], checkout: string, gone: (owners: ReadonlyArray<string>) => Effect.Effect<ReadonlySet<string>>, snapshot: Snapshot, now: number) =>
  Effect.gen(function* () {
    const onMain = yield* onMainAmong(mainLine, checkout, asked(snapshot))
    const owners = ownersOf(snapshot)
    const away = yield* Arr.match(owners, { onEmpty: () => Effect.succeed<ReadonlySet<string>>(new Set()), onNonEmpty: gone })
    return { now, onMain, gone: away } satisfies Facts
  })

/** Which of `commits` git has on the default branch of `checkout`; none when no default branch reads. */
export const onMainAmong = (mainLine: MainLine["Service"], checkout: string, commits: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const tip = yield* mainLine.tip(checkout, Option.none())
    const onMain = yield* Option.match(tip, {
      onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
      onSome: (head) => Effect.filter(commits, onMainOf(mainLine, checkout, head.head), { concurrency: 4 }),
    })
    return new Set(onMain)
  })

/** A workspace a land landed and the head it merged of it, as the land names it (the work tool's `landed`). */
export interface LandedLane {
  readonly path: string
  readonly head: string
}

const WorkLanded = Schema.Struct({ action: Schema.Literal("land"), pushed: Schema.String, landed: Schema.Array(Schema.Struct({ path: Schema.String, head: Schema.String })) })
const decodeWorkLanded = Schema.decodeUnknownOption(WorkLanded)

/**
 * The land event a work tool call's metadata carries: a pushed land's workspaces, each with the head it merged. A land
 * that did not push (no `pushed`, no `landed`), another action, or metadata an older work plugin wrote is none.
 */
export const workLandedOf = flow(decodeWorkLanded, Option.map((pushed) => pushed.landed))

/** One claim: the commitment, its run and owner, and the commit that holds its work. */
export interface Claim {
  readonly id: string
  readonly run: string
  readonly owner: string
  readonly head: string
}

/**
 * The claims a land event makes: for each workspace it landed, the open commitment whose lane that workspace is (as
 * the lane hook recorded it, `lanePath`) and that its own unit owns, with the head the land merged of it. A workspace
 * no commitment recorded claims nothing (nothing is created), and a head the commitment claims already claims nothing
 * again (the same event twice). Nothing else claims: no read does, and git decides only whether a claimed head is on
 * the default branch.
 */
export const landClaimsOf = (snapshot: Snapshot, landed: ReadonlyArray<LandedLane>): ReadonlyArray<Claim> =>
  Arr.dedupeWith(
    landed.flatMap((lane) =>
      [...snapshot.commitments.values()].flatMap((row): ReadonlyArray<Claim> =>
        Arr.filter([{ id: row.id, run: row.run, owner: row.id, head: lane.head }], () => row.state === "open" && Option.contains(row.lanePath, lane.path) && Option.contains(row.ownerLane, row.id) && !Option.contains(row.head, lane.head)),
      ),
    ),
    (a, b) => a.id === b.id,
  )

/** Whether a pass has anything to weigh: an open commitment with a claimed head. */
const claimsStanding = (snapshot: Snapshot): boolean => [...snapshot.commitments.values()].some((row) => row.state === "open" && Option.isSome(row.head))

/**
 * One pass over the claims standing: each open commitment whose claimed head git has on the default branch lands (its
 * facts read now). It claims nothing, so a read may run it; with no claim standing it writes nothing. Answers the rows after.
 */
export const passed = (actor: Actor, now: number, facts: (snapshot: Snapshot) => Effect.Effect<Facts>) =>
  Effect.gen(function* () {
    const record = yield* CommitmentRecord
    const snapshot = yield* record.read
    if (!claimsStanding(snapshot)) return snapshot
    const read = yield* facts(snapshot)
    const done = yield* record.run(Command.cases.pass.make({ onMain: [...read.onMain], gone: [...read.gone], root: Option.none() }), { actor, now })
    return done.snapshot
  })

/**
 * `claims` recorded, each a hand-back by `by` (`orchestrate-land`, `work-land`, the root's `landed`) from `session`
 * that claims its commitment's head, routed at once; then one pass (`passed`). Answers the rows after.
 */
export const claimsRecorded = (claims: ReadonlyArray<Claim>, by: string, session: string, actor: Actor, now: number, facts: (snapshot: Snapshot) => Effect.Effect<Facts>) =>
  Effect.gen(function* () {
    const record = yield* CommitmentRecord
    for (const claim of claims) {
      const handed = yield* record.run(
        Command.cases.hand_back.make({ run: claim.run, ownerLane: claim.owner, role: by, session, verdict: "done", head: Option.some(claim.head), claims: [claim.id] }),
        { actor, now },
      )
      const ids = handed.events.flatMap((event) => Arr.filter([Number(event.subjectId)], () => event.subjectKind === "hand_back"))
      yield* Effect.forEach(ids, (handBack) => record.run(Command.cases.route.make({ handBack, as: "routed" }), { actor, now }), { discard: true })
    }
    return yield* passed(actor, now, facts)
  })

/** The root's `landed`: where a commitment's work landed when no land event said so (a land by hand, another tool's). */
const landedOf = (input: CommitmentsInput, actor: Actor, now: number, reads: Reads) =>
  Effect.gen(function* () {
    const record = yield* CommitmentRecord
    const id = input.id ?? ""
    const head = input.head ?? ""
    if (actor.role !== ROOT) return yield* Effect.fail(`${COMMITMENTS}: only the root says where a commitment's work landed`)
    const row = Option.filter(Option.fromUndefinedOr((yield* record.read).commitments.get(id)), (each) => each.state === "open")
    if (Option.isNone(row)) return yield* Effect.fail(`${COMMITMENTS}: ${id} is not an open commitment`)
    if (Option.isNone(row.value.ownerLane)) return yield* Effect.fail(`${COMMITMENTS}: ${id} is unowned; own it first: ${callOf("assign")}`)
    const claims = Arr.filter([{ id, run: row.value.run, owner: row.value.ownerLane.value, head }], () => !Option.contains(row.value.head, head))
    const after = yield* claimsRecorded(claims, "landed", actor.id, actor, now, reads.facts)
    const landed = Option.exists(Option.fromUndefinedOr(after.commitments.get(id)), (each) => each.state === "landed")
    return Match.value(landed).pipe(
      Match.when(true, () => `${COMMITMENTS}: ${id} landed: ${head} is on the default branch.`),
      Match.orElse(() => `${COMMITMENTS}: ${id} claims ${head}; it lands once git has ${head} on the default branch (it does not now).`),
    )
  })


/**
 * Which of `owners` are gone: a unit with no lane in the base's list. `root` never is, and with no list (the work
 * plugin did not answer) none is: an unread list orphans nothing.
 */
export const goneOf = (owners: ReadonlyArray<string>, lanes: Option.Option<{ readonly rifts: ReadonlyArray<Lane>; readonly workrift: boolean }>): ReadonlySet<string> =>
  new Set(
    Option.match(lanes, {
      onNone: () => [],
      onSome: (listed) => owners.filter((owner) => owner !== ROOT && lanesOf(owner, listed.rifts, listed.workrift).length === 0),
    }),
  )

// ── Answers ──

const isOwnerSourced = (row: Commitment): boolean => OWNER_KINDS.includes(row.sourceKind)

/** The order the section names a standing's ids in: owner-sourced first, then oldest, then by id. */
export const sectionOrder: Order.Order<Commitment> = Order.combineAll([
  Order.mapInput(Order.Boolean, (row: Commitment) => !isOwnerSourced(row)),
  Order.mapInput(Order.String, (row: Commitment) => row.createdAt),
  Order.mapInput(Order.String, (row: Commitment) => row.id),
])

const idsLine = (standing: Standing, rows: ReadonlyArray<Commitment>): string => {
  const named = Arr.sort(rows, sectionOrder).slice(0, SECTION_IDS).map((row) => row.id)
  const more = Arr.filter([`, and ${rows.length - named.length} more: ${listCallOf(standing)}`], () => rows.length > named.length)
  return `- ${standing}: ${named.join(", ")}${more.join("")}${Option.getOrElse(Option.fromUndefinedOr(RESOLVES[standing]), () => "")}`
}

/** What a listed standing's line says resolves it, where the standing calls for a tool call the others do not. */
const RESOLVES: Partial<Record<Standing, string>> = {
  orphaned: `. Each lane is gone and no land named its commit: ${callOf("landed", [["id", '"<id>"'], ["head", '"<commit>"']])} when its work is on the default branch, else decide it with why, or assign it to re-own (${callOf("list", [["standing", '"orphaned"']])} shows each one's lane, start and claim).`,
}

/** What the section lists: each listed standing's commitments, the unrouted hand-backs and the unseen notices. */
export interface Listed {
  readonly by: ReadonlyMap<Standing, ReadonlyArray<Commitment>>
  readonly unrouted: ReadonlyArray<number>
  /** Outside-run closes first, then by id. */
  readonly notices: ReadonlyArray<Commitment>
}

export const listedOf = (snapshot: Snapshot, facts: Facts): Listed => ({ by: standingsOf(snapshot, facts), unrouted: unroutedOf(snapshot), notices: noticeRowsOf(snapshot) })

/** The unseen notices' rows (`noticesOf`): those closed by a session with no earlier event in their run first, then by id. */
export const noticeRowsOf = (snapshot: Snapshot): ReadonlyArray<Commitment> =>
  Arr.sort(
    noticesOf(snapshot).flatMap((id) => Option.toArray(Option.fromUndefinedOr(snapshot.commitments.get(id)))),
    Order.combine(Order.mapInput(Order.Boolean, (row: Commitment) => !row.noticeOutsideRun), Order.mapInput(Order.String, (row: Commitment) => row.id)),
  )

/** A notice as the section names it: its id, run and closing session, and whether that session had acted in the run. */
const noticeOf = (row: Commitment): string =>
  `${row.id} (${[`run ${row.run}`, ...Option.toArray(Option.map(row.noticeBy, (by) => `by ${by}`)), ...Arr.filter(["outside its run"], () => row.noticeOutsideRun)].join(", ")})`

/** At most `SECTION_IDS` of `items`, then how many more and the call that lists them. */
const capped = (items: ReadonlyArray<string>, rest: string): string =>
  [items.slice(0, SECTION_IDS).join(", "), ...Arr.filter([`and ${items.length - SECTION_IDS} more: ${rest}`], () => items.length > SECTION_IDS)].join(", ")

const countOf = (listed: Listed, standing: Standing): number => (listed.by.get(standing) ?? []).length

/**
 * The record's section: the counts by standing, then each listed standing's ids (at most ten, owner-sourced first,
 * then oldest, with the call that lists the rest), the unrouted hand-backs and the notices the owner has not seen.
 * Nothing when nothing is listed, unrouted or unseen: only held is quiet, so a record of held ones says nothing.
 */
export const sectionOf = (listed: Listed): ReadonlyArray<string> => {
  const open = STANDINGS.reduce((sum, standing) => sum + countOf(listed, standing), 0)
  const loud = LISTED.reduce((sum, standing) => sum + countOf(listed, standing), 0)
  if (loud + listed.unrouted.length + listed.notices.length === 0) return []
  const counts = STANDINGS.map((standing) => `${countOf(listed, standing)} ${standing}`).join(", ")
  const lines = LISTED.flatMap((standing) => Arr.match(listed.by.get(standing) ?? [], { onEmpty: () => [], onNonEmpty: (rows) => [idsLine(standing, rows)] }))
  return [
    `Commitments: ${open} open (${counts}). Only held is quiet: own (${callOf("assign")}), order or decide each listed one.`,
    ...lines,
    ...Arr.match(listed.unrouted, { onEmpty: () => [], onNonEmpty: (ids) => [`- unrouted hand-backs: ${capped(ids.map(String), "the oldest are named; routing them names the next")}: ${callOf("route")}`] }),
    ...Arr.match(listed.notices, { onEmpty: () => [], onNonEmpty: (rows) => [`- closed by decision, not yet seen by the owner: ${capped(rows.map(noticeOf), callOf("list", [["all", "true"]]))}`] }),
  ]
}

/** The section's keys: one per listed id, so the queue check says it again only when the set changes. */
export const sectionKeys = (listed: Listed): ReadonlyArray<string> => [
  ...LISTED.flatMap((standing) => (listed.by.get(standing) ?? []).map((row) => `commitment:${standing}:${row.id}`)),
  ...listed.unrouted.map((id) => `hand-back:${id}`),
  ...listed.notices.map((row) => `notice:${row.id}`),
]

const DAY = 86_400_000

const rowLine = (snapshot: Snapshot, facts: Facts) => (row: Commitment): string => {
  const where = Match.value(row.state).pipe(
    Match.when("open", () => standingOf(snapshot, row, facts)),
    Match.orElse((state) => state),
  )
  const owner = Option.getOrElse(row.ownerLane, () => "-")
  const review = Option.match(row.reviewBy, { onNone: () => "", onSome: (at) => ` review by ${at}` })
  // Its last known lane facts: where its lane was, the commit it started at, the commit a land or the root claimed.
  const lastKnown = [
    ...Option.toArray(Option.map(row.lanePath, (path) => `lane ${path}`)),
    ...Option.toArray(Option.map(row.startHead, (head) => `started at ${head}`)),
    ...Option.toArray(Option.map(row.head, (head) => `claims ${head}`)),
  ]
  const known = Arr.match(lastKnown, { onEmpty: () => "", onNonEmpty: (each) => `; ${each.join(", ")}` })
  return `${row.id} [${where}] ${owner}: ${row.title} (${row.sourceKind} ${row.sourceRef}; ${row.run})${review}${known}${reasonPart(row)}`
}

/** A row's reason, or how a reasonless close was made: an import's is printed "historical, unclassified". */
const reasonPart = (row: Commitment): string =>
  Option.match(row.reason, {
    onSome: (reason) => Match.value(row.state).pipe(
      Match.when("decided", () => `; closed on ${lineOf(reason)}`),
      Match.orElse(() => `; waits on ${lineOf(reason)}`),
    ),
    onNone: () =>
      Option.match(row.unreasonedClose, {
        onNone: () => "",
        onSome: (close) => Match.value(close).pipe(Match.when("historical", () => "; historical, unclassified"), Match.orElse(() => "; placed in its parts")),
      }),
  })

/** A row the list's filters keep. */
const kept = (input: CommitmentsInput, snapshot: Snapshot, facts: Facts) => (row: Commitment): boolean =>
  (input.all === true || row.state === "open") &&
  Option.getOrElse(Option.map(Option.fromUndefinedOr(input.owner), (owner) => Option.getOrElse(row.ownerLane, () => "-") === owner), () => true) &&
  Option.getOrElse(Option.map(Option.fromUndefinedOr(input.run), (run) => row.run === run), () => true) &&
  Option.getOrElse(Option.map(Option.fromUndefinedOr(input.age), (days) => facts.now - msOf(row.createdAt) > days * DAY), () => true) &&
  Option.getOrElse(Option.map(Option.fromUndefinedOr(input.standing), (standing) => row.state === "open" && standingOf(snapshot, row, facts) === standing), () => true)

/** The list action's answer: one line per commitment the filters keep, by id. */
export const listAnswer = (input: CommitmentsInput, snapshot: Snapshot, facts: Facts): string => {
  const rows = Arr.sort([...snapshot.commitments.values()].filter(kept(input, snapshot, facts)), Order.mapInput(Order.String, (row: Commitment) => row.id))
  return Arr.match(rows, {
    onEmpty: () => `${COMMITMENTS}: none match.`,
    onNonEmpty: (each) => [`${COMMITMENTS}: ${each.length}`, ...each.map(rowLine(snapshot, facts))].join("\n"),
  })
}

const eventLine = (event: StoredEvent): string => {
  const states = Option.match(Option.all([event.fromState, event.toState]), { onNone: () => "", onSome: ([from, to]) => ` ${from} → ${to}` })
  const note = Arr.filter([` (${event.note})`], () => event.note !== "")
  // The reason the event carried: history keeps it after a reopen clears the row's.
  const happened = event.happening
  const reason = Match.value(happened).pipe(
    Match.tag("decided", "deferred", (each) => Option.some(each.reason)),
    Match.tag("promised", (each) => each.reason),
    Match.tag("imported", (each) => Option.as(Option.liftPredicate(each.row.state, (state) => state === "decided"), "historical, unclassified")),
    Match.orElse(() => Option.none<ReasonData | string>()),
  )
  const why = Option.match(reason, { onNone: () => "", onSome: (each) => `; ${Match.value(each).pipe(Match.when(Predicate.isString, (text) => text), Match.orElse(lineOf))}` })
  return `${event.seq} ${event.at} ${event.happening._tag}${states} by ${event.actor.role} ${event.actor.id}${note.join("")}${why}`
}

/** The history action's answer: every event of the commitment, oldest first. */
export const historyAnswer = (id: string, events: ReadonlyArray<StoredEvent>): string =>
  Arr.match(events, { onEmpty: () => `${COMMITMENTS}: ${id} has no history: no such commitment.`, onNonEmpty: (each) => [`${COMMITMENTS}: ${id}`, ...each.map(eventLine)].join("\n") })

const idsOf = (events: ReadonlyArray<RecordEvent>, tag: RecordEvent["happening"]["_tag"]): ReadonlyArray<string> =>
  Arr.dedupe(events.flatMap((event) => Arr.filter([event.subjectId], () => event.happening._tag === tag)))

const namesOf = (ids: ReadonlyArray<string>): string => Arr.match(ids, { onEmpty: () => "none", onNonEmpty: (each) => each.join(", ") })

/** What a writing action did, in a line or two: the commitments it touched, and what the root does next. */
export const doneAnswer = (command: Command, events: ReadonlyArray<RecordEvent>, snapshot: Snapshot): string =>
  Match.value(command).pipe(
    Match.tag("add", (add) => {
      const unowned = add.parts.filter((part) => Option.isNone(part.ownerLane)).map((part) => part.id)
      const placed = idsOf(events, "placed").map((id) => ` ${id} is placed in them: closed, its parts carry it.`)
      return `${COMMITMENTS}: added ${namesOf(add.parts.map((part) => part.id))}. Unowned until assigned: ${namesOf(unowned)}.${placed.join("")}`
    }),
    Match.tag("assign", (assign) =>
      Option.match(Option.fromUndefinedOr(snapshot.commitments.get(assign.id)), {
        onNone: () => `${COMMITMENTS}: ${assign.id} not found.`,
        onSome: (row) => `${COMMITMENTS}: ${row.id} owned by ${assign.ownerLane}, review by ${Option.getOrElse(row.reviewBy, () => "-")}; waits on ${namesOf(row.after.map((each) => `${each.kind} ${each.ref}`))}.`,
      }),
    ),
    Match.tag("order", (order) => {
      const open = [...snapshot.commitments.values()].filter((row) => row.state === "open" && Option.contains(row.ownerLane, order.ownerLane))
      return `${COMMITMENTS}: started ${namesOf(idsOf(events, "ordered"))}. ${order.ownerLane}'s open commitments, each placed by this order: ${namesOf(open.map((row) => row.id))}.`
    }),
    Match.tag("decide", (decide) => {
      const noticed = Option.exists(Option.fromUndefinedOr(snapshot.commitments.get(decide.id)), (row) => Option.isSome(row.noticeUntil))
      const told = Arr.filter([" The owner approved it: they are told, and can have it reopened."], () => noticed)
      return `${COMMITMENTS}: ${decide.id} closed by decision, ${lineOf(decide.reason)}.${told.join("")}`
    }),
    Match.tag("defer", (defer) => `${COMMITMENTS}: ${defer.id} stays open, waiting on ${lineOf(defer.reason)}.`),
    Match.tag("invariant", (invariant) =>
      Option.match(Option.fromUndefinedOr(snapshot.invariants.get(invariant.id)), {
        onNone: () => `${COMMITMENTS}: invariant ${invariant.id} not found.`,
        onSome: (held) => `${COMMITMENTS}: invariant ${held.id} declared: ${held.docPath}#${held.anchor} at ${held.commit.slice(0, 12)}; a guarantee names it as { kind: "invariant", id: "${held.id}" }.`,
      }),
    ),
    Match.tag("reopen", (reopen) => `${COMMITMENTS}: ${reopen.id} is open again and unowned; its reason is cleared, its history kept.`),
    Match.tag("word", (word) => `${COMMITMENTS}: word ${word.word} given in ${word.run}.`),
    Match.tag("route", (route) => `${COMMITMENTS}: hand-back ${route.handBack} ${route.as}.`),
    Match.orElse((other) => `${COMMITMENTS}: ${other._tag} done (changes: ${events.length}).`),
  )

// ── A call ──

/** What a call reads from outside the record: a standing's facts, and an import's register (read and mapped). */
export interface Reads {
  readonly facts: (snapshot: Snapshot) => Effect.Effect<Facts>
  readonly register: (from: string, run: string, now: number) => Effect.Effect<{ readonly command: Command; readonly counts: string }, string>
  /** The checkout the call runs in: where the evidence reader looks for a receipt or a declared document. */
  readonly checkout: string
}

/** Why a record call failed, in its words. */
export const whyOf = (failed: RecordRefused | RecordFailed | string): string =>
  Match.value(failed).pipe(
    Match.when(Predicate.isString, (why) => why),
    Match.tag("RecordRefused", (refused) => `${COMMITMENTS}: ${refused.reason}`),
    Match.orElse((other) => `${COMMITMENTS}: ${other.message}`),
  )

const imported = (events: ReadonlyArray<RecordEvent>): number => events.filter((event) => event.happening._tag === "imported").length

/**
 * A `commitments` call by `actor`: its answer, or why it is refused. The handler both the plugin's tool and the CLI
 * run, so a host with no plugin gets the same refusals.
 */
export const answerOf = (input: CommitmentsInput, actor: Actor, now: number, reads: Reads) =>
  Effect.gen(function* () {
    const record = yield* CommitmentRecord
    const refused = inputRefusal(input)
    if (Option.isSome(refused)) return yield* Effect.fail(refused.value)
    const action = input.action
    if (action === "list") {
      const snapshot = yield* record.read
      return listAnswer(input, snapshot, yield* reads.facts(snapshot))
    }
    const id = input.id ?? ""
    if (action === "history") return historyAnswer(id, yield* record.history("commitment", id))
    if (action === "landed") return yield* landedOf(input, actor, now, reads)
    if (action === "import") {
      if (actor.role !== ROOT) return yield* Effect.fail(`${COMMITMENTS}: only the root imports a register`)
      const run = input.run ?? DEFAULT_RUN
      const map = input.map ?? "ergo-register"
      const mapped = yield* Effect.mapError(reads.register(input.from ?? "", run, now), (why) => `${COMMITMENTS}: ${why}`)
      // The import's rows are the register's, so its events are the import's (actor `ergo-register`), on the root's call.
      const done = yield* record.run(mapped.command, { actor: { id: map, role: "import" }, now })
      return `${COMMITMENTS}: imported ${imported(done.events)} rows into ${run}; the rest were held already. Counts out from in: ${mapped.counts}.`
    }
    if (action === "defer") {
      // The receipt a measurement names is read here, before the record's transaction; the record checks the rest inside it.
      const reason = yield* Result.match(reasonOfInput(COMMITMENTS, input), { onFailure: (why) => Effect.fail(why), onSuccess: (each) => Effect.succeed(each) })
      const seen = yield* observedReason(COMMITMENTS, reason, reads.checkout)
      const command = Command.cases.defer.make({ id, reason: seen.reason, observed: seen.observed })
      const done = yield* record.run(command, { actor, now })
      return doneAnswer(command, done.events, done.snapshot)
    }
    if (action === "invariant") {
      if (actor.role !== ROOT) return yield* Effect.fail(`${COMMITMENTS}: only the root declares an invariant`)
      const evidence = yield* Evidence
      const observed = yield* Effect.mapError(evidence.document(reads.checkout, input.doc_path ?? ""), (refused: EvidenceRefused) => `${COMMITMENTS}: ${refused.reason}`)
      const command = Command.cases.invariant.make({ id, anchor: input.anchor ?? "", observed })
      const done = yield* record.run(command, { actor, now })
      return doneAnswer(command, done.events, done.snapshot)
    }
    const command = yield* Result.match(commandOf(input, action), { onFailure: (why) => Effect.fail(why), onSuccess: (each) => Effect.succeed(each) })
    const done = yield* record.run(command, { actor, now })
    return doneAnswer(command, done.events, done.snapshot)
  }).pipe(Effect.map(redact), Effect.mapError((failed) => redact(whyOf(failed))))

/** A `follow_up` call: one unowned follow-up commitment, by the calling session. */
export const followUpOf = (input: FollowUpInput, actor: Actor, callID: string, now: number, checkout: string) =>
  Effect.gen(function* () {
    const record = yield* CommitmentRecord
    if (Predicate.isNotUndefined(input.key) && !KEY.test(input.key)) return yield* Effect.fail(`${FOLLOW_UP}: the key is not a slug (letters, digits, ., _ and -, at most 80); the value is not repeated`)
    const reason = yield* Result.match(reasonOfInput(FOLLOW_UP, input), { onFailure: (why) => Effect.fail(why), onSuccess: (each) => Effect.succeed(each) })
    const seen = yield* observedReason(FOLLOW_UP, reason, checkout)
    const done = yield* record.run(followUpCommandOf(input, actor.id, callID, seen), { actor, now })
    if (done.events.length === 0) return `${FOLLOW_UP}: ${input.id} is filed already by this key; nothing filed again.`
    return `${FOLLOW_UP}: filed ${input.id}, unowned, waiting on ${lineOf(seen.reason)}; the root owns or decides it.`
  }).pipe(Effect.map(redact), Effect.mapError((failed) => redact(whyOf(failed))))

/** A lane's answer with `line` before its implementor's start, whose call and lane stay its last lines. */
export const beforeStart = (answer: string, line: string): string => {
  const lines = answer.split("\n")
  const at = Option.getOrElse(Arr.findFirstIndex(lines, (each) => each.startsWith("Start its implementor")), () => Math.max(0, lines.length - 1))
  return [...lines.slice(0, at), line, ...lines.slice(at)].join("\n")
}

/** The lane hook's line: the unit's commitment and every open commitment of the unit as its owner. */
export const laneLine = (unit: string, open: ReadonlyArray<string>): string =>
  `Commitments of ${unit}: ${namesOf(open)}. A land of its lane (orchestrate land, the work tool's) claims the head it merges; ${callOf("list", [["owner", `"${unit}"`]])} lists them.`
