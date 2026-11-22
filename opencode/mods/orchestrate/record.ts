// The commitment record's domain, pure: what a run owes (a commitment: an approved part, a plan part, a follow-up, a
// unit to land), the hand-backs that claim commits for them, and the root's words that meet manual waits. Every change
// is a command decided here into events (`decide`); the folded rows are the events' fold (`fold`), so a store writes a
// command's events and the rows they fold to in one transaction, and replaying the events into an empty store gives
// the same rows (laws.ts). Nothing here reads a document: every field comes from a tool call's input.
import { Array as Arr, DateTime, Effect, Match, Option, Order, Result, Schema } from "effect"
import { redact } from "@dotfiles/opencode-digest/redact"

export const SOURCE_KINDS = ["owner-answer", "owner-ask", "assignment", "follow-up", "bug", "plan-part"] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]
/** The kinds whose source is the owner: only the root closes them, and a root that does tells the owner. */
export const OWNER_KINDS: ReadonlyArray<SourceKind> = ["owner-answer", "owner-ask"]
/** The kinds a worker may file. */
export const WORKER_KINDS: ReadonlyArray<SourceKind> = ["follow-up", "bug"]
export const RANKS = ["A", "B", "C", "D"] as const
export type Rank = (typeof RANKS)[number]
export const STATES = ["open", "landed", "decided"] as const
export type State = (typeof STATES)[number]
export const PREREQUISITE_KINDS = ["commit-on-main", "commitment-closed", "date", "manual"] as const
export type PrerequisiteKind = (typeof PREREQUISITE_KINDS)[number]
export const ACTOR_ROLES = ["root", "worker", "plugin", "owner", "import"] as const
export type ActorRole = (typeof ACTOR_ROLES)[number]
export const VERDICTS = ["ready", "blocked", "accepted", "changes", "stuck", "done"] as const
export type Verdict = (typeof VERDICTS)[number]
export const ROUTINGS = ["unrouted", "routed", "rejected"] as const
export type Routing = (typeof ROUTINGS)[number]
export const SUBJECT_KINDS = ["commitment", "hand_back", "unit", "batch", "word", "notice"] as const
export type SubjectKind = (typeof SUBJECT_KINDS)[number]

/** A title, a quote and a pointer are one line of at most this many characters. */
export const TEXT_MAX = 200
/** A decision's reason, at most. */
export const WHY_MAX = 500
export const DAY_MS = 86_400_000
/** An assignment's review-by time unless it names one. */
export const REVIEW_MS = 7 * DAY_MS
/** How long a root's decision on an owner-sourced commitment is shown to the owner's queue (unit 2 reads it). */
export const NOTICE_MS = 7 * DAY_MS
/** The owner of a commitment the root holds itself. */
export const ROOT = "root"

/** An id: a slug, unique in the repository (`VET-ONE`, `digest-events.t4`). */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
/** A name a lane, a session, a commit or a word takes: one token, no spaces. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,119}$/
/** One line. */
const ONE_LINE = /^[^\n\r]*$/

// ── The rows ──

export interface Prerequisite {
  readonly kind: PrerequisiteKind
  readonly ref: string
  /** A manual wait: when the root gave its word. */
  readonly metAt: Option.Option<string>
}

export interface Commitment {
  readonly id: string
  readonly run: string
  readonly title: string
  readonly sourceKind: SourceKind
  readonly sourceRef: string
  readonly quote: Option.Option<string>
  readonly plan: Option.Option<string>
  readonly part: Option.Option<string>
  readonly rank: Option.Option<Rank>
  readonly ownerLane: Option.Option<string>
  readonly ownerSession: Option.Option<string>
  readonly state: State
  readonly startedAt: Option.Option<string>
  readonly reviewBy: Option.Option<string>
  readonly wokeAt: Option.Option<string>
  /** The commit its lane started at, as `orchestrate lane` made the lane: shown to a root resolving an orphan, deciding nothing. */
  readonly startHead: Option.Option<string>
  /** Its lane's workspace, as `orchestrate lane` made or found it: a land event of that workspace claims for it. */
  readonly lanePath: Option.Option<string>
  readonly head: Option.Option<string>
  readonly requestPath: Option.Option<string>
  readonly landedCommit: Option.Option<string>
  readonly decidedWhy: Option.Option<string>
  readonly noticeUntil: Option.Option<string>
  /** Who closed it with a notice (the deciding session), while the notice stands. */
  readonly noticeBy: Option.Option<string>
  /** The closing session had no earlier event in its run: listed first, named so to the owner. */
  readonly noticeOutsideRun: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly after: ReadonlyArray<Prerequisite>
}

export interface HandBack {
  readonly id: number
  readonly run: string
  readonly ownerLane: string
  readonly role: string
  readonly round: Option.Option<number>
  readonly session: string
  readonly verdict: Verdict
  readonly head: Option.Option<string>
  readonly file: Option.Option<string>
  readonly at: string
  readonly routing: Routing
  readonly routedAt: Option.Option<string>
  readonly routedBy: Option.Option<string>
}

/** A word the root gave in a run: it meets every manual wait of that run on it, then and later. */
export interface Word {
  readonly run: string
  readonly word: string
  readonly givenAt: string
  readonly givenBy: string
}

export interface Snapshot {
  readonly commitments: ReadonlyMap<string, Commitment>
  readonly handBacks: ReadonlyMap<number, HandBack>
  /** By `wordKey(run, word)`. */
  readonly words: ReadonlyMap<string, Word>
  /** Each actor and run it has an event in, by `actedKey(actor, run)`: who has acted in which run, folded from the history. */
  readonly acted: ReadonlySet<string>
}

export const EMPTY: Snapshot = { commitments: new Map(), handBacks: new Map(), words: new Map(), acted: new Set() }

export const actedKey = (actor: string, run: string): string => `${actor}\n${run}`

export const wordKey = (run: string, word: string): string => `${run}\n${word}`

// ── The events ──

/** An optional field: an Option, its key left out when encoded, and none when a constructor leaves it out. */
const Opt = <S extends Schema.Constraint>(schema: S) => Schema.OptionFromOptionalKey(schema).pipe(Schema.withConstructorDefault(Effect.succeed(Option.none())))

export const AfterItem = Schema.Struct({ kind: Schema.Literals(PREREQUISITE_KINDS), ref: Schema.String })
export interface AfterItem extends Schema.Schema.Type<typeof AfterItem> {}

/** A commitment as an import writes it whole: Ergo's register, mapped. */
export const ImportedRow = Schema.Struct({
  title: Schema.String,
  sourceKind: Schema.Literals(SOURCE_KINDS),
  sourceRef: Schema.String,
  quote: Opt(Schema.String),
  plan: Opt(Schema.String),
  part: Opt(Schema.String),
  rank: Opt(Schema.Literals(RANKS)),
  ownerLane: Opt(Schema.String),
  ownerSession: Opt(Schema.String),
  state: Schema.Literals(STATES),
  startedAt: Opt(Schema.String),
  reviewBy: Opt(Schema.String),
  head: Opt(Schema.String),
  requestPath: Opt(Schema.String),
  landedCommit: Opt(Schema.String),
  decidedWhy: Opt(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  after: Schema.Array(AfterItem),
})
export interface ImportedRow extends Schema.Schema.Type<typeof ImportedRow> {}

/** What happened, by its type (the event table's `type`), with the fields the fold copies (its `data`). */
export const Happening = Schema.TaggedUnion({
  promised: {
    title: Schema.String,
    sourceKind: Schema.Literals(SOURCE_KINDS),
    sourceRef: Schema.String,
    quote: Opt(Schema.String),
    plan: Opt(Schema.String),
    part: Opt(Schema.String),
    rank: Opt(Schema.Literals(RANKS)),
    suggestOwner: Opt(Schema.String),
  },
  assigned: { ownerLane: Schema.String, ownerSession: Opt(Schema.String), after: Schema.Array(AfterItem), reviewBy: Schema.String },
  ordered: {},
  released: {},
  laned: { startHead: Opt(Schema.String), path: Opt(Schema.String) },
  claimed: { head: Schema.String, handBack: Schema.Int },
  landed: { commit: Schema.String },
  decided: { why: Schema.String, notice: Schema.Boolean, outsideRun: Opt(Schema.Boolean) },
  reopened: { outsideRun: Opt(Schema.Boolean) },
  woke: { root: Schema.String },
  seen: {},
  word_given: {},
  handed_back: {
    ownerLane: Schema.String,
    role: Schema.String,
    round: Opt(Schema.Int),
    session: Schema.String,
    verdict: Schema.Literals(VERDICTS),
    head: Opt(Schema.String),
    file: Opt(Schema.String),
  },
  routed: {},
  rejected: {},
  imported: { row: ImportedRow },
  imported_history: {},
})
export type Happening = typeof Happening.Type
export type EventType = Happening["_tag"]

export interface Actor {
  readonly id: string
  readonly role: ActorRole
}

export interface RecordEvent {
  readonly at: string
  readonly run: string
  readonly subjectKind: SubjectKind
  readonly subjectId: string
  readonly actor: Actor
  readonly fromState: Option.Option<string>
  readonly toState: Option.Option<string>
  readonly note: string
  readonly happening: Happening
}

/** An event as stored, with its place in the history. */
export interface StoredEvent extends RecordEvent {
  readonly seq: number
}

// ── Time ──

export const isoOf = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms))
export const msOf = (iso: string): number => Date.parse(iso)

// ── The fold ──

interface Draft {
  commitments: Map<string, Commitment>
  handBacks: Map<number, HandBack>
  words: Map<string, Word>
  acted: Set<string>
}

const touched = (row: Commitment, at: string, change: Partial<Commitment>): Commitment => ({ ...row, ...change, updatedAt: at })

/** The prerequisites of an assignment, each manual one met when its word was given already. */
const prerequisitesOf = (after: ReadonlyArray<AfterItem>, run: string, words: ReadonlyMap<string, Word>): ReadonlyArray<Prerequisite> =>
  after.map((item) => ({
    kind: item.kind,
    ref: item.ref,
    metAt: Option.map(Option.filter(Option.fromUndefinedOr(words.get(wordKey(run, item.ref))), () => item.kind === "manual"), (word) => word.givenAt),
  }))

const UNOWNED = { ownerLane: Option.none(), ownerSession: Option.none(), after: [], reviewBy: Option.none(), startedAt: Option.none(), wokeAt: Option.none() } satisfies Partial<Commitment>

const promisedRow = (event: RecordEvent, happened: Extract<Happening, { _tag: "promised" }>): Commitment => ({
  id: event.subjectId,
  run: event.run,
  title: happened.title,
  sourceKind: happened.sourceKind,
  sourceRef: happened.sourceRef,
  quote: happened.quote,
  plan: happened.plan,
  part: happened.part,
  rank: happened.rank,
  ...UNOWNED,
  state: "open",
  head: Option.none(),
  startHead: Option.none(),
  lanePath: Option.none(),
  requestPath: Option.none(),
  landedCommit: Option.none(),
  decidedWhy: Option.none(),
  noticeUntil: Option.none(),
  noticeBy: Option.none(),
  noticeOutsideRun: false,
  createdAt: event.at,
  updatedAt: event.at,
})

const importedRow = (event: RecordEvent, row: ImportedRow): Commitment => ({
  ...row,
  id: event.subjectId,
  run: event.run,
  startHead: Option.none(),
  lanePath: Option.none(),
  wokeAt: Option.none(),
  noticeUntil: Option.none(),
  noticeBy: Option.none(),
  noticeOutsideRun: false,
  after: row.after.map((item) => ({ kind: item.kind, ref: item.ref, metAt: Option.none() })),
})

/** A change to one commitment an event makes, from the row as it was. */
const commitmentChange = (event: RecordEvent, draft: Draft) => (row: Commitment): Commitment =>
  Match.value(event.happening).pipe(
    Match.tagsExhaustive({
      promised: () => row,
      imported: () => row,
      imported_history: () => row,
      assigned: (happened) =>
        touched(row, event.at, {
          ownerLane: Option.some(happened.ownerLane),
          ownerSession: happened.ownerSession,
          after: prerequisitesOf(happened.after, row.run, draft.words),
          reviewBy: Option.some(happened.reviewBy),
          startedAt: Option.none(),
          wokeAt: Option.none(),
        }),
      ordered: () => touched(row, event.at, { startedAt: Option.some(event.at) }),
      released: () => touched(row, event.at, UNOWNED),
      laned: (happened) => touched(row, event.at, { startHead: Option.orElse(happened.startHead, () => row.startHead), lanePath: Option.orElse(happened.path, () => row.lanePath) }),
      claimed: (happened) => touched(row, event.at, { head: Option.some(happened.head) }),
      landed: (happened) => touched(row, event.at, { state: "landed", landedCommit: Option.some(happened.commit) }),
      decided: (happened) =>
        touched(row, event.at, {
          state: "decided",
          decidedWhy: Option.some(happened.why),
          noticeUntil: Option.map(Option.liftPredicate(event.at, () => happened.notice), (at) => isoOf(msOf(at) + NOTICE_MS)),
          noticeBy: Option.as(Option.liftPredicate(event.at, () => happened.notice), event.actor.id),
          noticeOutsideRun: happened.notice && Option.contains(happened.outsideRun, true),
        }),
      reopened: () =>
        touched(row, event.at, { ...UNOWNED, state: "open", head: Option.none(), landedCommit: Option.none(), decidedWhy: Option.none(), noticeUntil: Option.none(), noticeBy: Option.none(), noticeOutsideRun: false }),
      woke: () => touched(row, event.at, { wokeAt: Option.some(event.at) }),
      seen: () => touched(row, event.at, { noticeUntil: Option.none(), noticeBy: Option.none(), noticeOutsideRun: false }),
      word_given: () => row,
      handed_back: () => row,
      routed: () => row,
      rejected: () => row,
    }),
  )

const applyCommitment = (draft: Draft, event: RecordEvent): void => {
  const happened = event.happening
  if (happened._tag === "promised") {
    draft.commitments.set(event.subjectId, promisedRow(event, happened))
    return
  }
  if (happened._tag === "imported") {
    draft.commitments.set(event.subjectId, importedRow(event, happened.row))
    return
  }
  Option.map(Option.fromUndefinedOr(draft.commitments.get(event.subjectId)), (row) => draft.commitments.set(event.subjectId, commitmentChange(event, draft)(row)))
}

/** `each` met at `at` when `meets` it, else as it was. */
const metWhen = (each: Prerequisite, meets: (each: Prerequisite) => boolean, at: string): Prerequisite =>
  Option.match(Option.liftPredicate(each, meets), { onNone: () => each, onSome: (met) => ({ ...met, metAt: Option.some(at) }) })

/** A word meets every manual wait on it of its run's open commitments. */
const applyWord = (draft: Draft, event: RecordEvent): void => {
  draft.words.set(wordKey(event.run, event.subjectId), { run: event.run, word: event.subjectId, givenAt: event.at, givenBy: event.actor.id })
  for (const row of draft.commitments.values()) {
    const meets = (each: Prerequisite) => each.kind === "manual" && each.ref === event.subjectId && Option.isNone(each.metAt)
    if (row.run !== event.run || row.state !== "open" || !row.after.some(meets)) continue
    draft.commitments.set(row.id, { ...row, after: row.after.map((each) => metWhen(each, meets, event.at)) })
  }
}

const applyHandBack = (draft: Draft, event: RecordEvent): void => {
  const id = Number(event.subjectId)
  const happened = event.happening
  if (happened._tag === "handed_back") {
    const { _tag, ...fields } = happened
    draft.handBacks.set(id, { ...fields, id, run: event.run, at: event.at, routing: "unrouted", routedAt: Option.none(), routedBy: Option.none() })
    return
  }
  if (happened._tag !== "routed" && happened._tag !== "rejected") return
  const routing = happened._tag
  Option.map(Option.fromUndefinedOr(draft.handBacks.get(id)), (row) =>
    draft.handBacks.set(id, { ...row, routing, routedAt: Option.some(event.at), routedBy: Option.some(event.actor.id) }),
  )
}

const apply = (draft: Draft, event: RecordEvent): void => {
  draft.acted.add(actedKey(event.actor.id, event.run))
  Match.value(event.subjectKind).pipe(
    Match.when("commitment", () => applyCommitment(draft, event)),
    Match.when("notice", () => applyCommitment(draft, event)),
    Match.when("word", () => applyWord(draft, event)),
    Match.when("hand_back", () => applyHandBack(draft, event)),
    Match.orElse(() => {}),
  )
}

/** The rows `events` fold `snapshot` into: total, it never fails, and an event about nothing known changes nothing. */
export const fold = (snapshot: Snapshot, events: Iterable<RecordEvent>): Snapshot => {
  const draft: Draft = { commitments: new Map(snapshot.commitments), handBacks: new Map(snapshot.handBacks), words: new Map(snapshot.words), acted: new Set(snapshot.acted) }
  for (const event of events) apply(draft, event)
  return draft
}

// ── The commands ──

const Ms = Schema.Finite

export const PartInput = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  part: Opt(Schema.String),
  rank: Opt(Schema.Literals(RANKS)),
  ownerLane: Opt(Schema.String),
  after: Opt(Schema.Array(AfterItem)),
  reviewBy: Opt(Ms),
})
export interface PartInput extends Schema.Schema.Type<typeof PartInput> {}

export const ImportRow = Schema.Struct({ id: Schema.String, row: ImportedRow, history: Schema.Array(Schema.Struct({ at: Schema.String, actor: Schema.String, fromState: Opt(Schema.String), toState: Opt(Schema.String), note: Schema.String })) })
export interface ImportRow extends Schema.Schema.Type<typeof ImportRow> {}

export const Command = Schema.TaggedUnion({
  add: {
    run: Schema.String,
    sourceKind: Schema.Literals(SOURCE_KINDS),
    sourceRef: Schema.String,
    quote: Opt(Schema.String),
    plan: Opt(Schema.String),
    suggestOwner: Opt(Schema.String),
    parts: Schema.Array(PartInput),
  },
  assign: { id: Schema.String, ownerLane: Schema.String, ownerSession: Opt(Schema.String), after: Schema.Array(AfterItem), reviewBy: Opt(Ms) },
  order: { ownerLane: Schema.String, ids: Schema.Array(Schema.String) },
  release: { id: Schema.String },
  decide: { id: Schema.String, why: Schema.String },
  reopen: { id: Schema.String },
  word: { run: Schema.String, word: Schema.String },
  seen: { id: Schema.String },
  hand_back: {
    run: Schema.String,
    ownerLane: Schema.String,
    role: Schema.String,
    round: Opt(Schema.Int),
    session: Schema.String,
    verdict: Schema.Literals(VERDICTS),
    head: Opt(Schema.String),
    file: Opt(Schema.String),
    claims: Schema.Array(Schema.String),
  },
  route: { handBack: Schema.Int, as: Schema.Literals(["routed", "rejected"]) },
  lane: { run: Schema.String, unit: Schema.String, session: Opt(Schema.String), startHead: Opt(Schema.String), path: Opt(Schema.String) },
  pass: { onMain: Schema.Array(Schema.String), gone: Schema.Array(Schema.String), root: Opt(Schema.String) },
  import: { run: Schema.String, rows: Schema.Array(ImportRow) },
})
export type Command = typeof Command.Type

/** A command from its encoded form (a tool's input, a CLI's JSON): its optional fields left out. */
export const decodeCommand = Schema.decodeUnknownResult(Command)

/** Why a command is refused, in words the caller acts on. */
export class RecordRefused extends Schema.TaggedError<RecordRefused>()("RecordRefused", { reason: Schema.String }) {}

/** Who decides, and when. */
export interface Context {
  readonly actor: Actor
  readonly now: number
}

type Decided = Result.Result<ReadonlyArray<RecordEvent>, RecordRefused>

const refuse = (reason: string): Decided => Result.fail(new RecordRefused({ reason }))
const decided = (events: ReadonlyArray<RecordEvent>): Decided => Result.succeed(events)

/** The first refusal of `checks`, else none. */
const firstOf = (checks: ReadonlyArray<Option.Option<string>>): Option.Option<string> => Option.firstSomeOf(checks)

const when = (refused: boolean, reason: string): Option.Option<string> => Option.liftPredicate(reason, () => refused)

/** A slug id, or why not. */
/** A value as a refusal names it: quoted, cut. */
const named = (value: string, max = 80): string => `"${value.slice(0, max)}"`

export const idRefusal = (id: string): Option.Option<string> => when(!ID.test(id), `the id ${named(id)} is not a slug (letters, digits, ".", "_", "-", at most 80, starting with a letter or digit)`)
/** A one-token name (a lane, a session, a commit, a word), or why not. */
export const tokenRefusal = (what: string, value: string): Option.Option<string> => when(!TOKEN.test(value), `${what} ${named(value)} is not one token of at most 120 characters`)
/** One line of at most `max` characters that says something, or why not. */
export const lineRefusal = (what: string, value: string, max = TEXT_MAX): Option.Option<string> =>
  firstOf([when(value.trim() === "", `${what} is empty`), when(!ONE_LINE.test(value), `${what} is more than one line`), when(value.length > max, `${what} is ${value.length} characters, more than ${max}`)])

/** The text a record keeps of `text`: every secret shape the digest redacts replaced, ends trimmed. */
export const kept = (text: string): string => redact(text).trim()

/** The longest note an event keeps: longer (an imported history's) is cut there. */
export const NOTE_MAX = 1000

type Held<A> = Result.Result<A, RecordRefused>

/** One free-text field as the record holds it: one line of at most `max` that says something, redacted (`kept`); else refused. */
const freeText = (what: string, value: string, max = TEXT_MAX): Held<string> =>
  Option.match(lineRefusal(what, value, max), { onSome: (reason) => Result.fail(new RecordRefused({ reason })), onNone: () => Result.succeed(kept(value)) })

const freeTextOf = (what: string, value: Option.Option<string>, max = TEXT_MAX): Held<Option.Option<string>> =>
  Option.match(value, { onNone: () => Result.succeed(Option.none()), onSome: (text) => Result.map(freeText(what, text, max), Option.some) })

/** A one-token field (a lane, a session, a commit): kept as given, else refused. */
const tokenOf = (what: string, value: Option.Option<string>): Held<Option.Option<string>> =>
  Option.match(Option.flatMap(value, (text) => tokenRefusal(what, text)), { onSome: (reason) => Result.fail(new RecordRefused({ reason })), onNone: () => Result.succeed(value) })

/** An imported row's free text and tokens, each column as `row <id>, column <name>` names it. */
const boundedRow = (id: string, row: ImportedRow): Held<ImportedRow> => {
  const column = (name: string) => `row ${id}, column ${name}: ${name}`
  return Result.map(
    Result.all({
      title: freeText(column("title"), row.title),
      sourceRef: freeText(column("source_ref"), row.sourceRef),
      quote: freeTextOf(column("quote"), row.quote),
      plan: freeTextOf(column("plan"), row.plan),
      part: freeTextOf(column("part"), row.part),
      decidedWhy: freeTextOf(column("decided_why"), row.decidedWhy, WHY_MAX),
      requestPath: freeTextOf(column("request_path"), row.requestPath),
      ownerLane: tokenOf(column("owner_lane"), row.ownerLane),
      ownerSession: tokenOf(column("owner_session"), row.ownerSession),
      head: tokenOf(column("head"), row.head),
      landedCommit: tokenOf(column("landed_commit"), row.landedCommit),
    }),
    (fields) => ImportedRow.make({ ...row, ...fields }),
  )
}

/**
 * What happened as the record keeps it: every free-text field (the columns `FREE_TEXT_COLUMNS` names, and the event
 * data and note they come from) one line, bounded and redacted, else the whole command refused. The one boundary
 * every command's events pass (standing.ts `decideCommand`), so no column holds a secret or an unbounded text.
 */
const boundedHappening = (subject: string, happening: Happening): Held<Happening> =>
  Match.value(happening).pipe(
    Match.tag("promised", (happened) =>
      Result.map(
        Result.all({
          title: freeText(`the title of ${subject}`, happened.title),
          sourceRef: freeText("the source_ref", happened.sourceRef),
          quote: freeTextOf("the quote", happened.quote),
          plan: freeTextOf("the plan", happened.plan),
          part: freeTextOf(`the part of ${subject}`, happened.part),
          suggestOwner: freeTextOf("the suggested owner", happened.suggestOwner),
        }),
        (fields): Happening => Happening.cases.promised.make({ ...happened, ...fields }),
      ),
    ),
    Match.tag("decided", (happened) => Result.map(freeText("the reason (why)", happened.why, WHY_MAX), (why): Happening => Happening.cases.decided.make({ ...happened, why }))),
    Match.tag("handed_back", (happened) =>
      Result.map(
        Result.all({ role: freeText("the role", happened.role), file: freeTextOf("the file", happened.file) }),
        (fields): Happening => Happening.cases.handed_back.make({ ...happened, ...fields }),
      ),
    ),
    Match.tag("laned", (happened) => Result.map(tokenOf("the start head", happened.startHead), () => happening)),
    Match.tag("imported", (happened) => Result.map(boundedRow(subject, happened.row), (row): Happening => Happening.cases.imported.make({ row }))),
    Match.orElse(() => Result.succeed(happening)),
  )

/** Every event of a command through `boundedHappening`, its note redacted and cut at `NOTE_MAX`: the record's one text boundary. */
export const bounded = (events: ReadonlyArray<RecordEvent>): Held<ReadonlyArray<RecordEvent>> =>
  Result.all(events.map((each) => Result.map(boundedHappening(each.subjectId, each.happening), (happening): RecordEvent => ({ ...each, happening, note: kept(each.note).slice(0, NOTE_MAX) }))))

/**
 * Every free-text column of the record's tables, as `<table>.<column>`: what `bounded` redacts and bounds. A test
 * lists the tables' TEXT columns and requires each be here or a known token, time or literal column, so no new
 * column skips the boundary.
 */
export const FREE_TEXT_COLUMNS: ReadonlyArray<string> = [
  "commitment.title",
  "commitment.source_ref",
  "commitment.quote",
  "commitment.plan",
  "commitment.part",
  "commitment.request_path",
  "commitment.decided_why",
  "hand_back.role",
  "hand_back.file",
  "event.note",
  "event.data",
]

const isOwnerSourced = (row: Commitment): boolean => OWNER_KINDS.includes(row.sourceKind)

const openRow = (snapshot: Snapshot, id: string): Option.Option<Commitment> =>
  Option.filter(Option.fromUndefinedOr(snapshot.commitments.get(id)), (row) => row.state === "open")

const event = (context: Context, run: string, subjectKind: SubjectKind, subjectId: string, happening: Happening, states: readonly [Option.Option<string>, Option.Option<string>] = [Option.none(), Option.none()], note = ""): RecordEvent => ({
  at: isoOf(context.now),
  run,
  subjectKind,
  subjectId,
  actor: context.actor,
  fromState: states[0],
  toState: states[1],
  note,
  happening,
})

const onCommitment = (context: Context, row: Commitment, happening: Happening, to: Option.Option<State> = Option.none(), note = ""): RecordEvent =>
  event(context, row.run, "commitment", row.id, happening, [Option.some(row.state), Option.orElse(to, () => Option.some(row.state))], note)

const rootOnly = (context: Context, what: string): Option.Option<string> =>
  when(context.actor.role !== "root" && context.actor.role !== "plugin", `${what} is the root's: a ${context.actor.role} cannot`)

// ── add ──

const afterRefusal = (snapshot: Snapshot, after: ReadonlyArray<AfterItem>): Option.Option<string> =>
  firstOf(
    after.map((item) =>
      Match.value(item.kind).pipe(
        Match.when("commitment-closed", () => firstOf([idRefusal(item.ref), when(!snapshot.commitments.has(item.ref), `the wait names ${item.ref}, which is no commitment`)])),
        Match.when("date", () => when(Number.isNaN(msOf(item.ref)), `the wait's date ${named(item.ref, 60)} is not an ISO time`)),
        Match.orElse(() => tokenRefusal(`the ${item.kind} wait`, item.ref)),
      ),
    ),
  )

/** The waits once each, in the order given. */
const uniqueAfter = (after: ReadonlyArray<AfterItem>): ReadonlyArray<AfterItem> => Arr.dedupeWith(after, (a, b) => a.kind === b.kind && a.ref === b.ref)

/** A review-by time ahead of now, the default when none is named. */
const reviewOf = (context: Context, reviewBy: Option.Option<number>): Result.Result<string, RecordRefused> => {
  const at = Option.getOrElse(reviewBy, () => context.now + REVIEW_MS)
  if (at <= context.now) return Result.fail(new RecordRefused({ reason: `the review-by time ${isoOf(at)} is not ahead of now (${isoOf(context.now)})` }))
  return Result.succeed(isoOf(at))
}

const assignedEvent = (context: Context, row: Commitment, input: { readonly ownerLane: string; readonly ownerSession: Option.Option<string>; readonly after: ReadonlyArray<AfterItem>; readonly reviewBy: string }): RecordEvent =>
  onCommitment(context, row, Happening.cases.assigned.make({ ownerLane: input.ownerLane, ownerSession: input.ownerSession, after: uniqueAfter(input.after), reviewBy: input.reviewBy }))

const addRefusal = (snapshot: Snapshot, command: Extract<Command, { _tag: "add" }>, context: Context): Option.Option<string> => {
  const ids = command.parts.map((part) => part.id)
  const worker = context.actor.role === "worker"
  return firstOf([
    when(command.parts.length === 0, "an add names at least one part"),
    tokenRefusal("the run", command.run),
    when(worker && !WORKER_KINDS.includes(command.sourceKind), `a worker files only ${WORKER_KINDS.join(" or ")}; ${command.sourceKind} is the root's`),
    when(worker && command.parts.some((part) => Option.isSome(part.ownerLane)), "a worker files a follow-up unowned; suggest an owner instead"),
    when(Option.isSome(command.quote) && !OWNER_KINDS.includes(command.sourceKind), "a quote is the owner's words: only an owner-answer or owner-ask carries one"),
    firstOf(ids.map(idRefusal)),
    when(Arr.dedupe(ids).length !== ids.length, "two parts share an id"),
    Option.map(Arr.findFirst(ids, (id) => snapshot.commitments.has(id)), (id) => `the id ${id} is taken`),
    firstOf(command.parts.map((part) => Option.flatMap(part.ownerLane, (lane) => tokenRefusal("the owner", lane)))),
    firstOf(command.parts.map((part) => afterRefusal(snapshot, Option.getOrElse(part.after, () => [])))),
  ])
}

const promisedOf = (command: Extract<Command, { _tag: "add" }>, part: PartInput) =>
  Happening.cases.promised.make({
    title: part.title,
    sourceKind: command.sourceKind,
    sourceRef: command.sourceRef,
    quote: command.quote,
    plan: command.plan,
    part: part.part,
    rank: part.rank,
    suggestOwner: command.suggestOwner,
  })

const decideAdd = (snapshot: Snapshot, command: Extract<Command, { _tag: "add" }>, context: Context): Decided => {
  const refused = addRefusal(snapshot, command, context)
  if (Option.isSome(refused)) return refuse(refused.value)
  const events: Array<RecordEvent> = []
  for (const part of command.parts) {
    const promised = event(context, command.run, "commitment", part.id, promisedOf(command, part), [Option.none(), Option.some("open")])
    events.push(promised)
    if (Option.isNone(part.ownerLane)) continue
    const review = reviewOf(context, part.reviewBy)
    if (Result.isFailure(review)) return Result.fail(review.failure)
    const lane = part.ownerLane.value
    const row = Option.fromUndefinedOr(fold(snapshot, events).commitments.get(part.id))
    events.push(...Option.toArray(row).map((each) => assignedEvent(context, each, { ownerLane: lane, ownerSession: Option.none(), after: Option.getOrElse(part.after, () => []), reviewBy: review.success })))
  }
  return decided(events)
}

// ── assign, order, release ──

const decideAssign = (snapshot: Snapshot, command: Extract<Command, { _tag: "assign" }>, context: Context): Decided => {
  const row = openRow(snapshot, command.id)
  const refused = firstOf([
    rootOnly(context, "owning a commitment"),
    when(Option.isNone(row), `${command.id} is not an open commitment`),
    tokenRefusal("the owner", command.ownerLane),
    Option.flatMap(command.ownerSession, (session) => tokenRefusal("the session", session)),
    afterRefusal(snapshot, command.after),
  ])
  if (Option.isSome(refused) || Option.isNone(row)) return refuse(Option.getOrElse(refused, () => ""))
  const review = reviewOf(context, command.reviewBy)
  if (Result.isFailure(review)) return Result.fail(review.failure)
  return decided([assignedEvent(context, row.value, { ownerLane: command.ownerLane, ownerSession: command.ownerSession, after: command.after, reviewBy: review.success })])
}

const decideOrder = (snapshot: Snapshot, command: Extract<Command, { _tag: "order" }>, context: Context): Decided => {
  const rows = command.ids.map((id) => openRow(snapshot, id))
  const refused = firstOf([
    rootOnly(context, "an order"),
    when(rows.some((row) => !Option.exists(row, (each) => Option.contains(each.ownerLane, command.ownerLane))), `each id must be an open commitment of ${command.ownerLane}`),
  ])
  if (Option.isSome(refused)) return refuse(refused.value)
  const unstarted = Arr.dedupeWith(Arr.getSomes(rows), (a, b) => a.id === b.id).filter((row) => Option.isNone(row.startedAt))
  return decided(unstarted.map((row) => onCommitment(context, row, Happening.cases.ordered.make({}))))
}

const decideRelease = (snapshot: Snapshot, command: Extract<Command, { _tag: "release" }>, context: Context): Decided => {
  const row = Option.filter(openRow(snapshot, command.id), (each) => Option.isSome(each.ownerLane))
  if (Option.isNone(row)) return refuse(`${command.id} is not an owned open commitment`)
  const own = context.actor.role === "worker" && Option.contains(row.value.ownerSession, context.actor.id)
  if (Option.isSome(rootOnly(context, "releasing a commitment")) && !own) return refuse("only the root, or the owner's own session, releases a commitment")
  return decided([onCommitment(context, row.value, Happening.cases.released.make({}))])
}

// ── decide, reopen, seen, word ──

/**
 * Whether the deciding or reopening session has no earlier event in the commitment's run. Unit 1 refuses nothing for
 * it (no durable session-to-run binding exists before unit 3's step rows): the history and the owner's notice carry it,
 * and the notices list such closes first.
 */
const outsideRunOf = (snapshot: Snapshot, row: Commitment, context: Context): boolean => !snapshot.acted.has(actedKey(context.actor.id, row.run))

const decideDecide = (snapshot: Snapshot, command: Extract<Command, { _tag: "decide" }>, context: Context): Decided => {
  const row = openRow(snapshot, command.id)
  if (Option.isNone(row)) return refuse(`${command.id} is not an open commitment`)
  const ownerSourced = isOwnerSourced(row.value)
  const refused = firstOf([
    when(ownerSourced && context.actor.role === "worker", "only the root closes what the owner approved"),
    when(context.actor.role === "import" || context.actor.role === "owner", `a ${context.actor.role} does not decide`),
  ])
  if (Option.isSome(refused)) return refuse(refused.value)
  const why = command.why
  const outsideRun = Option.some(outsideRunOf(snapshot, row.value, context))
  return decided([onCommitment(context, row.value, Happening.cases.decided.make({ why, notice: ownerSourced, outsideRun }), Option.some("decided"), why)])
}

const decideReopen = (snapshot: Snapshot, command: Extract<Command, { _tag: "reopen" }>, context: Context): Decided => {
  const row = Option.filter(Option.fromUndefinedOr(snapshot.commitments.get(command.id)), (each) => each.state === "decided")
  const refused = firstOf([rootOnly(context, "reopening a decision"), when(Option.isNone(row), `${command.id} is not a decided commitment`)])
  if (Option.isSome(refused) || Option.isNone(row)) return refuse(Option.getOrElse(refused, () => ""))
  return decided([onCommitment(context, row.value, Happening.cases.reopened.make({ outsideRun: Option.some(outsideRunOf(snapshot, row.value, context)) }), Option.some("open"))])
}

const decideSeen = (snapshot: Snapshot, command: Extract<Command, { _tag: "seen" }>, context: Context): Decided => {
  const row = Option.filter(Option.fromUndefinedOr(snapshot.commitments.get(command.id)), (each) => Option.isSome(each.noticeUntil))
  if (Option.isNone(row)) return decided([])
  return decided([event(context, row.value.run, "notice", row.value.id, Happening.cases.seen.make({}))])
}

const decideWord = (snapshot: Snapshot, command: Extract<Command, { _tag: "word" }>, context: Context): Decided => {
  const refused = firstOf([rootOnly(context, "a manual word"), tokenRefusal("the run", command.run), tokenRefusal("the word", command.word)])
  if (Option.isSome(refused)) return refuse(refused.value)
  if (snapshot.words.has(wordKey(command.run, command.word))) return decided([])
  return decided([event(context, command.run, "word", command.word, Happening.cases.word_given.make({}))])
}

// ── hand_back, route ──

const nextHandBack = (snapshot: Snapshot): number => Math.max(0, ...snapshot.handBacks.keys()) + 1

const decideHandBack = (snapshot: Snapshot, command: Extract<Command, { _tag: "hand_back" }>, context: Context): Decided => {
  const rows = command.claims.map((id) => openRow(snapshot, id))
  const refused = firstOf([
    when(context.actor.role === "import" || context.actor.role === "owner", `a ${context.actor.role} does not hand back`),
    tokenRefusal("the owner", command.ownerLane),
    tokenRefusal("the session", command.session),
    Option.flatMap(command.head, (head) => tokenRefusal("the head", head)),
    when(command.claims.length > 0 && Option.isNone(command.head), "a hand-back that claims commitments names its head"),
    when(rows.some((row) => !Option.exists(row, (each) => Option.contains(each.ownerLane, command.ownerLane))), `each claimed id must be an open commitment of ${command.ownerLane}`),
  ])
  if (Option.isSome(refused)) return refuse(refused.value)
  const id = nextHandBack(snapshot)
  const { _tag, claims: _claims, run, ...fields } = command
  const handedBack = event(context, run, "hand_back", String(id), Happening.cases.handed_back.make(fields), [Option.none(), Option.some("unrouted")])
  const head = Option.getOrElse(command.head, () => "")
  const claimed = Arr.getSomes(rows).map((row) => onCommitment(context, row, Happening.cases.claimed.make({ head, handBack: id })))
  return decided([handedBack, ...claimed])
}

const decideRoute = (snapshot: Snapshot, command: Extract<Command, { _tag: "route" }>, context: Context): Decided => {
  const row = Option.filter(Option.fromUndefinedOr(snapshot.handBacks.get(command.handBack)), (each) => each.routing === "unrouted")
  const refused = firstOf([rootOnly(context, "routing a hand-back"), when(Option.isNone(row), `hand-back ${command.handBack} is not an unrouted hand-back`)])
  if (Option.isSome(refused) || Option.isNone(row)) return refuse(Option.getOrElse(refused, () => ""))
  const happening = Match.value(command.as).pipe(
    Match.when("routed", () => Happening.cases.routed.make({})),
    Match.orElse(() => Happening.cases.rejected.make({})),
  )
  return decided([event(context, row.value.run, "hand_back", String(row.value.id), happening, [Option.some("unrouted"), Option.some(command.as)])])
}

// ── lane ──

/** `orchestrate lane`: the unit's commitment got or made (source `assignment`), owned by the unit and started. */
const decideLane = (snapshot: Snapshot, command: Extract<Command, { _tag: "lane" }>, context: Context): Decided => {
  const refused = firstOf([rootOnly(context, "a lane"), idRefusal(command.unit), tokenRefusal("the run", command.run)])
  if (Option.isSome(refused)) return refuse(refused.value)
  const found = Option.fromUndefinedOr(snapshot.commitments.get(command.unit))
  if (Option.exists(found, (row) => row.state !== "open")) return decided([])
  const promised = Option.match(found, {
    onSome: (): ReadonlyArray<RecordEvent> => [],
    onNone: () => [
      event(
        context,
        command.run,
        "commitment",
        command.unit,
        Happening.cases.promised.make({ title: `land unit ${command.unit}`, sourceKind: "assignment", sourceRef: `orchestrate lane ${command.unit}`, quote: Option.none(), plan: Option.none(), part: Option.none(), rank: Option.none(), suggestOwner: Option.none() }),
        [Option.none(), Option.some("open")],
      ),
    ],
  })
  const made = Option.fromUndefinedOr(fold(snapshot, promised).commitments.get(command.unit))
  if (Option.isNone(made)) return decided(promised)
  const row = made.value
  const owned = Option.contains(row.ownerLane, command.unit)
  const assigned = Arr.filter([assignedEvent(context, row, { ownerLane: command.unit, ownerSession: command.session, after: [], reviewBy: isoOf(context.now + REVIEW_MS) })], () => !owned)
  const ownedRow = fold(snapshot, [...promised, ...assigned]).commitments.get(command.unit)
  const ordered = Arr.filter(Option.toArray(Option.fromUndefinedOr(ownedRow)), (each) => Option.isNone(each.startedAt)).map((each) => onCommitment(context, each, Happening.cases.ordered.make({})))
  // The lane's workspace (a land event of it claims for this commitment) and, made now, the commit it started at; the
  // same lane again records nothing.
  const startHead = Option.filter(command.startHead, (head) => !Option.contains(row.startHead, head))
  const path = Option.filter(command.path, (each) => !Option.contains(row.lanePath, each))
  const laned = Arr.filter([onCommitment(context, row, Happening.cases.laned.make({ startHead, path }))], () => Option.isSome(startHead) || Option.isSome(path))
  return decided([...promised, ...assigned, ...ordered, ...laned])
}

// ── import ──

const importRefusal = (row: ImportRow): Option.Option<string> =>
  firstOf([
    Option.map(idRefusal(row.id), (why) => `row ${row.id}, column id: ${why}`),
    when(row.row.state === "landed" && Option.isNone(row.row.landedCommit), `row ${row.id}, column landed_commit: a landed row needs the commit on the default branch`),
    when(row.row.state === "decided" && Option.isNone(row.row.decidedWhy), `row ${row.id}, column state: a decided row needs a closing event's note`),
    when(Option.isSome(row.row.ownerLane) && Option.isNone(row.row.reviewBy) && row.row.state === "open", `row ${row.id}, column review_by: an owned open row needs one`),
  ])

const decideImport = (snapshot: Snapshot, command: Extract<Command, { _tag: "import" }>, context: Context): Decided => {
  const refused = firstOf([when(context.actor.role !== "import", "only an import imports"), tokenRefusal("the run", command.run), firstOf(command.rows.map(importRefusal))])
  if (Option.isSome(refused)) return refuse(refused.value)
  const fresh = command.rows.filter((row) => !snapshot.commitments.has(row.id))
  return decided(
    fresh.flatMap((row) => [
      ...row.history.map((each) => ({
        ...event(context, command.run, "commitment", row.id, Happening.cases.imported_history.make({}), [each.fromState, each.toState], each.note),
        at: each.at,
        actor: { id: each.actor, role: context.actor.role },
      })),
      event(context, command.run, "commitment", row.id, Happening.cases.imported.make({ row: row.row }), [Option.none(), Option.some(row.row.state)]),
    ]),
  )
}

/** A command's events against the record as it stands, or why it is refused. `pass` is decided in standing.ts. */
export const decide = (snapshot: Snapshot, command: Exclude<Command, { _tag: "pass" }>, context: Context): Decided =>
  Match.value(command).pipe(
    Match.tagsExhaustive({
      add: (each) => decideAdd(snapshot, each, context),
      assign: (each) => decideAssign(snapshot, each, context),
      order: (each) => decideOrder(snapshot, each, context),
      release: (each) => decideRelease(snapshot, each, context),
      decide: (each) => decideDecide(snapshot, each, context),
      reopen: (each) => decideReopen(snapshot, each, context),
      seen: (each) => decideSeen(snapshot, each, context),
      word: (each) => decideWord(snapshot, each, context),
      hand_back: (each) => decideHandBack(snapshot, each, context),
      route: (each) => decideRoute(snapshot, each, context),
      lane: (each) => decideLane(snapshot, each, context),
      import: (each) => decideImport(snapshot, each, context),
    }),
  )

// ── Reads ──

/** Ascending by id, by UTF-16 code units. */
export const byId = Order.mapInput(Order.String, (row: Commitment) => row.id)

/** The open commitments of `owner`, by id. */
export const openOf = (snapshot: Snapshot, owner: string): ReadonlyArray<string> =>
  Arr.sort(
    [...snapshot.commitments.values()].flatMap((row) => Arr.filter([row.id], () => row.state === "open" && Option.contains(row.ownerLane, owner))),
    Order.String,
  )

/** The owner-sourced commitments a root closed by decision that the owner has not seen, by id. */
export const noticesOf = (snapshot: Snapshot): ReadonlyArray<string> =>
  Arr.sort(
    [...snapshot.commitments.values()].flatMap((row) => Arr.filter([row.id], () => row.state === "decided" && Option.isSome(row.noticeUntil))),
    Order.String,
  )
