// The `commitments` tool (the root's) and the `follow_up` tool (a worker's), pure: their inputs, their descriptions,
// each call's command for the record (record.ts), and the words of every answer, the record's section among them (what
// `orchestrate status`, every land and the queue check say of the record). The plugin (cmd/orchestrate/server.ts) runs
// the commands on the CommitmentRecord and reads the facts a standing needs (`factsOf`) at each call; nothing of a run
// is kept between calls. Nothing here reads prose: every field is the call's own.
import { Array as Arr, Effect, Match, Option, Order, Predicate, Result, Schema } from "effect"
import { toolInput } from "@dotfiles/decider/tool-input"
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
import { CommitmentRecord, type MainLine, type RecordFailed } from "./service.ts"
import { type Lane, lanesOf } from "./tools.ts"
import { asked, type Facts, LISTED, ownersOf, type Standing, STANDINGS, standingOf, standingsOf, unroutedOf } from "./standing.ts"

export const COMMITMENTS = "commitments"
export const FOLLOW_UP = "follow_up"
/** The run a call names none of: one record holds every run of its repository, `run` a column. */
export const DEFAULT_RUN = "default"
/** The ids the section names of each standing, at most. */
export const SECTION_IDS = 10

export const ACTIONS = ["add", "assign", "order", "release", "decide", "reopen", "word", "route", "list", "history", "import"] as const
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

export const CommitmentsInput = toolInput(
  Schema.Struct({
    action: Schema.Literals(ACTIONS).annotate({
      description:
        "add: N commitments from an approval or a plan, one per part (the call that records an owner's approval). assign: own or re-own one, with its waits and review-by time. order: start an owner's commitments; answers all its open ones. release: give one up. decide: close one by decision, with why. reopen: undo a decision. word: give a manual wait's word. route: answer a hand-back. list, history: read. import: an Ergo register, table to table.",
    }),
    run: Schema.optional(Schema.String).annotate({ description: `add, word, list: the run (default "${DEFAULT_RUN}").` }),
    source_kind: Schema.optional(Schema.Literals(SOURCE_KINDS)).annotate({ description: "add: where the commitments come from. owner-answer and owner-ask are the owner's: closing one by decision tells the owner." }),
    source_ref: Schema.optional(Schema.String).annotate({ description: "add: a pointer to the source: `<session>:<question id>`, `plan.md:12`, a spec's path." }),
    quote: Schema.optional(Schema.String).annotate({ description: "add: the owner's words, one line of at most 200 characters (owner-answer, owner-ask only)." }),
    plan: Schema.optional(Schema.String).annotate({ description: "add: the plan or placeholder commitment the parts split." }),
    parts: Schema.optional(Schema.Array(Part)).annotate({
      description: "add: the parts, one commitment each: { id (a slug), title (one line), part?, rank? (A-D), owner_lane?, after? [{ kind, ref }], review_by? (ISO time) }.",
    }),
    id: Schema.optional(Schema.String).annotate({ description: "assign, release, decide, reopen, history: the commitment." }),
    owner_lane: Schema.optional(Schema.String).annotate({ description: "assign, order: the owner (a unit, or `root`)." }),
    owner_session: Schema.optional(Schema.String).annotate({ description: "assign: the owner's session, when one holds it." }),
    after: Schema.optional(Schema.Array(AfterItem)).annotate({
      description: "assign: what it waits on, each { kind: commit-on-main | commitment-closed | date | manual, ref }; empty: due now.",
    }),
    review_by: Schema.optional(Schema.String).annotate({ description: "assign: when it is overdue if still open (ISO time; default 7 days)." }),
    ids: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "order: the commitments to start." }),
    why: Schema.optional(Schema.String).annotate({ description: "decide: the reason, one line." }),
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
  decide: ["id", "why"],
  reopen: ["id"],
  word: ["run", "word"],
  route: ["hand_back", "as"],
  list: ["owner", "standing", "run", "age", "all"],
  history: ["id"],
  import: ["run", "from", "map"],
} as const satisfies { readonly [A in Action]: ReadonlyArray<Field> }
export const REQUIRED = {
  add: ["source_kind", "source_ref", "parts"],
  assign: ["id", "owner_lane"],
  order: ["owner_lane", "ids"],
  release: ["id"],
  decide: ["id", "why"],
  reopen: ["id"],
  word: ["word"],
  route: ["hand_back", "as"],
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
  "assign owns it (re-owning keeps it open; every owned one has a review-by time, 7 days by default). order starts an owner's and answers all its open ones. decide closes one with a reason; one the owner approved tells the owner, who can have it reopened. Nobody says landed: a commitment lands when the commit its owner's hand-back claimed is on the default branch.",
  "The root's tool: a subagent files what it finds with follow_up instead.",
].join("\n")

export const FollowUpInput = toolInput(
  Schema.Struct({
    id: Schema.String.annotate({ description: "A slug for it, unique in the repository: letters, digits, ., _ and -." }),
    title: Schema.String.annotate({ description: "What is owed, one line of at most 200 characters." }),
    rank: Schema.optional(Schema.Literals(RANKS)).annotate({ description: "A (most) to D, only to sort." }),
    suggest_owner: Schema.optional(Schema.String).annotate({ description: "The lane you think should own it; the root decides." }),
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
export const commandOf = (input: CommitmentsInput, action: Exclude<Action, "list" | "history" | "import">): Result.Result<Command, string> => {
  const id = input.id ?? ""
  return Match.value(action).pipe(
    Match.when("add", () => addOf(input)),
    Match.when("assign", () => assignOf(input)),
    Match.when("order", () => Result.succeed(Command.cases.order.make({ ownerLane: input.owner_lane ?? "", ids: input.ids ?? [] }))),
    Match.when("release", () => Result.succeed(Command.cases.release.make({ id }))),
    Match.when("decide", () => Result.succeed(Command.cases.decide.make({ id, why: input.why ?? "" }))),
    Match.when("reopen", () => Result.succeed(Command.cases.reopen.make({ id }))),
    Match.when("word", () => Result.succeed(Command.cases.word.make({ run: input.run ?? DEFAULT_RUN, word: input.word ?? "" }))),
    Match.when("route", () => Result.succeed(Command.cases.route.make({ handBack: input.hand_back ?? 0, as: input.as ?? "routed" }))),
    Match.exhaustive,
  )
}

/** A worker's follow-up as the record's `add`: one unowned `follow-up` commitment, its source the call. */
export const followUpCommandOf = (input: FollowUpInput, sessionID: string, callID: string): Command =>
  Command.cases.add.make({
    run: input.run ?? DEFAULT_RUN,
    sourceKind: "follow-up",
    sourceRef: `${sessionID}:${callID}`,
    suggestOwner: Option.fromUndefinedOr(input.suggest_owner),
    parts: [PartInput.make({ id: input.id, title: input.title, rank: Option.fromUndefinedOr(input.rank) })],
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
    const tip = yield* mainLine.tip(checkout, Option.none())
    const commits = asked(snapshot)
    const onMain = yield* Option.match(tip, {
      onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
      onSome: (head) => Effect.filter(commits, onMainOf(mainLine, checkout, head.head), { concurrency: 4 }),
    })
    const owners = ownersOf(snapshot)
    const away = yield* Arr.match(owners, { onEmpty: () => Effect.succeed<ReadonlySet<string>>(new Set()), onNonEmpty: gone })
    return { now, onMain: new Set(onMain), gone: away } satisfies Facts
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
  return `- ${standing}: ${named.join(", ")}${more.join("")}`
}

/** What the section lists: each listed standing's commitments, the unrouted hand-backs and the unseen notices. */
export interface Listed {
  readonly by: ReadonlyMap<Standing, ReadonlyArray<Commitment>>
  readonly unrouted: ReadonlyArray<number>
  readonly notices: ReadonlyArray<string>
}

export const listedOf = (snapshot: Snapshot, facts: Facts): Listed => ({ by: standingsOf(snapshot, facts), unrouted: unroutedOf(snapshot), notices: noticesOf(snapshot) })

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
    ...Arr.match(listed.unrouted, { onEmpty: () => [], onNonEmpty: (ids) => [`- unrouted hand-backs: ${ids.join(", ")}: ${callOf("route")}`] }),
    ...Arr.match(listed.notices, { onEmpty: () => [], onNonEmpty: (ids) => [`- closed by decision, not yet seen by the owner: ${ids.join(", ")}`] }),
  ]
}

/** The section's keys: one per listed id, so the queue check says it again only when the set changes. */
export const sectionKeys = (listed: Listed): ReadonlyArray<string> => [
  ...LISTED.flatMap((standing) => (listed.by.get(standing) ?? []).map((row) => `commitment:${standing}:${row.id}`)),
  ...listed.unrouted.map((id) => `hand-back:${id}`),
  ...listed.notices.map((id) => `notice:${id}`),
]

const DAY = 86_400_000

const rowLine = (snapshot: Snapshot, facts: Facts) => (row: Commitment): string => {
  const where = Match.value(row.state).pipe(
    Match.when("open", () => standingOf(snapshot, row, facts)),
    Match.orElse((state) => state),
  )
  const owner = Option.getOrElse(row.ownerLane, () => "-")
  const review = Option.match(row.reviewBy, { onNone: () => "", onSome: (at) => ` review by ${at}` })
  return `${row.id} [${where}] ${owner}: ${row.title} (${row.sourceKind} ${row.sourceRef}; ${row.run})${review}`
}

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
  return `${event.seq} ${event.at} ${event.happening._tag}${states} by ${event.actor.role} ${event.actor.id}${note.join("")}`
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
      return `${COMMITMENTS}: added ${namesOf(add.parts.map((part) => part.id))}. Unowned until assigned: ${namesOf(unowned)}.`
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
      return `${COMMITMENTS}: ${decide.id} closed by decision.${told.join("")}`
    }),
    Match.tag("word", (word) => `${COMMITMENTS}: word ${word.word} given in ${word.run}.`),
    Match.tag("route", (route) => `${COMMITMENTS}: hand-back ${route.handBack} ${route.as}.`),
    Match.orElse((other) => `${COMMITMENTS}: ${other._tag} done (changes: ${events.length}).`),
  )

// ── A call ──

/** What a call reads from outside the record: a standing's facts, and an import's register (read and mapped). */
export interface Reads {
  readonly facts: (snapshot: Snapshot) => Effect.Effect<Facts>
  readonly register: (from: string, run: string, now: number) => Effect.Effect<{ readonly command: Command; readonly counts: string }, string>
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
    if (action === "import") {
      const run = input.run ?? DEFAULT_RUN
      const mapped = yield* reads.register(input.from ?? "", run, now)
      const done = yield* record.run(mapped.command, { actor, now })
      return `${COMMITMENTS}: imported ${imported(done.events)} rows into ${run}; the rest were held already. Counts out from in: ${mapped.counts}.`
    }
    const command = yield* Result.match(commandOf(input, action), { onFailure: (why) => Effect.fail(why), onSuccess: (each) => Effect.succeed(each) })
    const done = yield* record.run(command, { actor, now })
    return doneAnswer(command, done.events, done.snapshot)
  }).pipe(Effect.mapError(whyOf))

/** A `follow_up` call: one unowned follow-up commitment, by the calling session. */
export const followUpOf = (input: FollowUpInput, actor: Actor, callID: string, now: number) =>
  Effect.gen(function* () {
    const record = yield* CommitmentRecord
    yield* record.run(followUpCommandOf(input, actor.id, callID), { actor, now })
    return `${FOLLOW_UP}: filed ${input.id}, unowned; the root owns or decides it.`
  }).pipe(Effect.mapError(whyOf))

/** A lane's answer with `line` before its implementor's start, whose call and lane stay its last lines. */
export const beforeStart = (answer: string, line: string): string => {
  const lines = answer.split("\n")
  const at = Option.getOrElse(Arr.findFirstIndex(lines, (each) => each.startsWith("Start its implementor")), () => Math.max(0, lines.length - 1))
  return [...lines.slice(0, at), line, ...lines.slice(at)].join("\n")
}

/** The lane hook's line: the unit's commitment and every open commitment of the unit as its owner. */
export const laneLine = (unit: string, open: ReadonlyArray<string>): string =>
  `Commitments of ${unit}: ${namesOf(open)}. Its hand-back claims what it lands; ${callOf("list", [["owner", `"${unit}"`]])} lists them.`
