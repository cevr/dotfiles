// The commitment record over one SQLite file per repository per host (bun:sqlite), beside the memory mod's file and by
// its pattern: `$XDG_STATE_HOME/opencode-orchestrate/<repo key>.db`. WAL, a busy timeout and one immediate transaction
// per command let every OpenCode server location, subagent session and the CLI write side by side; a busy past the
// timeout is a `RecordFailed` the caller sees. Versions are `PRAGMA user_version` and a forward-only list of additive
// migrations applied in one transaction at open; a file of a newer version opens to read and refuses every write.
// At the first open of a UTC day the file is copied with `VACUUM INTO <dir>/backup/<key>-<date>.db`, the newest 7 kept.
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, unlinkSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { Array as Arr, Clock, Effect, Layer, Option, Order, Predicate, Result, Schema } from "effect"
import {
  ACTOR_ROLES,
  type Commitment,
  EMPTY,
  fold,
  type HandBack,
  Happening,
  isoOf,
  PREREQUISITE_KINDS,
  type Prerequisite,
  RANKS,
  type RecordEvent,
  type RecordRefused,
  ROUTINGS,
  type Snapshot,
  SOURCE_KINDS,
  STATES,
  type StoredEvent,
  SUBJECT_KINDS,
  VERDICTS,
  type Word,
  actedKey,
  wordKey,
} from "../record.ts"
import { localKey, keyOfOrigin } from "../repo-key.ts"
import { CommitmentRecord, RecordFailed } from "../service.ts"
import { decideCommand } from "../standing.ts"

/** How many daily backups are kept. */
export const BACKUPS_KEPT = 7

/** Version 1: the spec's DDL, with `word` and `notice` subjects and the `word` table (record.ts). */
const V1 = [
  `CREATE TABLE commitment (
    id            TEXT PRIMARY KEY,
    run           TEXT NOT NULL,
    title         TEXT NOT NULL,
    source_kind   TEXT NOT NULL CHECK (source_kind IN ('owner-answer','owner-ask','assignment','follow-up','bug','plan-part')),
    source_ref    TEXT NOT NULL,
    quote         TEXT CHECK (quote IS NULL OR length(quote) <= 200),
    plan          TEXT,
    part          TEXT,
    rank          TEXT CHECK (rank IS NULL OR rank IN ('A','B','C','D')),
    owner_lane    TEXT,
    owner_session TEXT,
    state         TEXT NOT NULL CHECK (state IN ('open','landed','decided')),
    started_at    TEXT,
    review_by     TEXT,
    woke_at       TEXT,
    head          TEXT,
    request_path  TEXT,
    landed_commit TEXT,
    decided_why   TEXT,
    notice_until  TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    CHECK (owner_session IS NULL OR owner_lane IS NOT NULL),
    CHECK (owner_lane IS NULL OR review_by IS NOT NULL OR state <> 'open'),
    CHECK ((state = 'landed') = (landed_commit IS NOT NULL)),
    CHECK ((state = 'decided') = (decided_why IS NOT NULL)),
    CHECK (quote IS NULL OR source_kind IN ('owner-answer','owner-ask'))
  ) STRICT`,
  `CREATE TABLE prerequisite (
    commitment_id TEXT NOT NULL REFERENCES commitment(id),
    kind          TEXT NOT NULL CHECK (kind IN ('commit-on-main','commitment-closed','date','manual')),
    ref           TEXT NOT NULL,
    met_at        TEXT,
    PRIMARY KEY (commitment_id, kind, ref)
  ) STRICT`,
  `CREATE TABLE event (
    seq          INTEGER PRIMARY KEY,
    at           TEXT NOT NULL,
    run          TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('commitment','hand_back','unit','batch','word','notice')),
    subject_id   TEXT NOT NULL,
    type         TEXT NOT NULL,
    actor        TEXT NOT NULL,
    actor_role   TEXT NOT NULL CHECK (actor_role IN ('root','worker','plugin','owner','import')),
    from_state   TEXT,
    to_state     TEXT,
    note         TEXT NOT NULL DEFAULT '',
    data         TEXT NOT NULL DEFAULT '{}'
  ) STRICT`,
  "CREATE INDEX event_subject ON event (subject_kind, subject_id, seq DESC)",
  `CREATE TABLE hand_back (
    id         INTEGER PRIMARY KEY,
    run        TEXT NOT NULL,
    owner_lane TEXT NOT NULL,
    role       TEXT NOT NULL,
    round      INTEGER,
    session    TEXT NOT NULL,
    verdict    TEXT NOT NULL CHECK (verdict IN ('ready','blocked','accepted','changes','stuck','done')),
    head       TEXT,
    file       TEXT,
    at         TEXT NOT NULL,
    routing    TEXT NOT NULL DEFAULT 'unrouted' CHECK (routing IN ('unrouted','routed','rejected')),
    routed_at  TEXT,
    routed_by  TEXT
  ) STRICT`,
  `CREATE TABLE lane_session (
    lane    TEXT PRIMARY KEY,
    session TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE word (
    run      TEXT NOT NULL,
    word     TEXT NOT NULL,
    given_at TEXT NOT NULL,
    given_by TEXT NOT NULL,
    PRIMARY KEY (run, word)
  ) STRICT`,
  "CREATE INDEX commitment_owner_state ON commitment (owner_lane, state)",
  "CREATE INDEX hand_back_routing ON hand_back (routing, at)",
]

/**
 * Version 2, additive: the commit a lane started at (`start_head`: a read claims only work past it), and who closed an
 * owner-sourced commitment and whether from outside every run it had acted in (`notice_by`, `notice_outside_run`).
 */
const V2 = [
  "ALTER TABLE commitment ADD COLUMN start_head TEXT",
  "ALTER TABLE commitment ADD COLUMN notice_by TEXT",
  "ALTER TABLE commitment ADD COLUMN notice_outside_run INTEGER NOT NULL DEFAULT 0 CHECK (notice_outside_run IN (0, 1))",
]

/** Each version's statements, in order: forward-only and additive (a non-additive change is the owner's). */
export const MIGRATIONS: ReadonlyArray<ReadonlyArray<string>> = [V1, V2]

/** The schema version this code writes: one per migration, so the two cannot disagree. */
export const VERSION = MIGRATIONS.length

// ── Where the file is ──

/** The record files' directory: `<stateHome>/opencode-orchestrate` (`$XDG_STATE_HOME`), `~/.local/state` when unset or empty. */
export const stateDir = (stateHome: Option.Option<string>): string =>
  join(Option.getOrElse(Option.filter(stateHome, (dir) => dir !== ""), () => join(TuiDirs.dirs().home, ".local/state")), "opencode-orchestrate")

/** The record file of the repository `key`. */
export const pathOf = (stateHome: Option.Option<string>, key: string): string => join(stateDir(stateHome), `${key}.db`)

const gitOut = (checkout: string, args: ReadonlyArray<string>): Option.Option<string> => {
  const ran = Bun.spawnSync(["git", "-C", checkout, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  return Option.filter(Option.some(ran.stdout.toString().trim()), (text) => ran.exitCode === 0 && text !== "")
}

/** The repository key of the checkout at `checkout`: its origin's (repo-key.ts), else `local-` and its top folder's real path hashed. */
export const keyOfCheckout = (checkout: string): string =>
  Option.getOrElse(Option.flatMap(gitOut(checkout, ["config", "--get", "remote.origin.url"]), keyOfOrigin), () => {
    const top = Option.getOrElse(gitOut(checkout, ["rev-parse", "--show-toplevel"]), () => checkout)
    return localKey(createHash("sha256").update(realpathSync(top)).digest("hex"))
  })

// ── Rows ──

type Raw = Readonly<Record<string, SQLQueryBindings>>

const textOf = (row: Raw, column: string): Option.Option<string> => Option.liftPredicate(row[column], Predicate.isString)
const intOf = (row: Raw, column: string): Option.Option<number> => Option.liftPredicate(row[column], Predicate.isNumber)
const textIn = (row: Raw, column: string): string => Option.getOrElse(textOf(row, column), () => "")
const literalOf =
  <A extends string>(values: ReadonlyArray<A>, fallback: A) =>
  (row: Raw, column: string): A =>
    Option.getOrElse(
      Option.flatMap(textOf(row, column), (text) => Arr.findFirst(values, (value) => value === text)),
      () => fallback,
    )
const optLiteral =
  <A extends string>(values: ReadonlyArray<A>) =>
  (row: Raw, column: string): Option.Option<A> =>
    Option.flatMap(textOf(row, column), (text) => Arr.findFirst(values, (value) => value === text))

const prerequisiteOf = (row: Raw): Prerequisite => ({ kind: literalOf(PREREQUISITE_KINDS, "manual")(row, "kind"), ref: textIn(row, "ref"), metAt: textOf(row, "met_at") })

const commitmentOf = (row: Raw, after: ReadonlyArray<Prerequisite>): Commitment => ({
  id: textIn(row, "id"),
  run: textIn(row, "run"),
  title: textIn(row, "title"),
  sourceKind: literalOf(SOURCE_KINDS, "follow-up")(row, "source_kind"),
  sourceRef: textIn(row, "source_ref"),
  quote: textOf(row, "quote"),
  plan: textOf(row, "plan"),
  part: textOf(row, "part"),
  rank: optLiteral(RANKS)(row, "rank"),
  ownerLane: textOf(row, "owner_lane"),
  ownerSession: textOf(row, "owner_session"),
  state: literalOf(STATES, "open")(row, "state"),
  startedAt: textOf(row, "started_at"),
  reviewBy: textOf(row, "review_by"),
  wokeAt: textOf(row, "woke_at"),
  head: textOf(row, "head"),
  requestPath: textOf(row, "request_path"),
  landedCommit: textOf(row, "landed_commit"),
  decidedWhy: textOf(row, "decided_why"),
  noticeUntil: textOf(row, "notice_until"),
  startHead: textOf(row, "start_head"),
  noticeBy: textOf(row, "notice_by"),
  noticeOutsideRun: Option.contains(intOf(row, "notice_outside_run"), 1),
  createdAt: textIn(row, "created_at"),
  updatedAt: textIn(row, "updated_at"),
  after,
})

const handBackOf = (row: Raw): HandBack => ({
  id: Option.getOrElse(intOf(row, "id"), () => 0),
  run: textIn(row, "run"),
  ownerLane: textIn(row, "owner_lane"),
  role: textIn(row, "role"),
  round: intOf(row, "round"),
  session: textIn(row, "session"),
  verdict: literalOf(VERDICTS, "done")(row, "verdict"),
  head: textOf(row, "head"),
  file: textOf(row, "file"),
  at: textIn(row, "at"),
  routing: literalOf(ROUTINGS, "unrouted")(row, "routing"),
  routedAt: textOf(row, "routed_at"),
  routedBy: textOf(row, "routed_by"),
})

const wordOf = (row: Raw): Word => ({ run: textIn(row, "run"), word: textIn(row, "word"), givenAt: textIn(row, "given_at"), givenBy: textIn(row, "given_by") })

/** The rows as they stand. */
const snapshotOf = (db: Database): Snapshot => {
  const after = new Map<string, Array<Prerequisite>>()
  for (const row of db.query<Raw, []>("SELECT * FROM prerequisite ORDER BY rowid").all()) {
    const id = textIn(row, "commitment_id")
    after.set(id, [...(after.get(id) ?? []), prerequisiteOf(row)])
  }
  const commitments = new Map(db.query<Raw, []>("SELECT * FROM commitment").all().map((row) => [textIn(row, "id"), commitmentOf(row, after.get(textIn(row, "id")) ?? [])] as const))
  const handBacks = new Map(db.query<Raw, []>("SELECT * FROM hand_back").all().map((row) => [Option.getOrElse(intOf(row, "id"), () => 0), handBackOf(row)] as const))
  const words = new Map(db.query<Raw, []>("SELECT * FROM word").all().map((row) => [wordKey(textIn(row, "run"), textIn(row, "word")), wordOf(row)] as const))
  const acted = new Set(db.query<Raw, []>("SELECT DISTINCT actor, run FROM event").all().map((row) => actedKey(textIn(row, "actor"), textIn(row, "run"))))
  return { commitments, handBacks, words, acted }
}

const DataCodec = Schema.fromJsonString(Happening)
const encodeData = Schema.encodeSync(DataCodec)
const decodeData = Schema.decodeUnknownResult(DataCodec)

const nullable = <A>(value: Option.Option<A>) => Option.getOrNull(value)

const COMMITMENT_COLUMNS = [
  "id", "run", "title", "source_kind", "source_ref", "quote", "plan", "part", "rank", "owner_lane", "owner_session", "state", "started_at",
  "review_by", "woke_at", "head", "request_path", "landed_commit", "decided_why", "notice_until", "created_at", "updated_at",
  "start_head", "notice_by", "notice_outside_run",
]

const UPSERT_COMMITMENT = `INSERT INTO commitment (${COMMITMENT_COLUMNS.join(", ")}) VALUES (${COMMITMENT_COLUMNS.map(() => "?").join(", ")})
  ON CONFLICT (id) DO UPDATE SET ${COMMITMENT_COLUMNS.slice(1).map((column) => `${column} = excluded.${column}`).join(", ")}`

const commitmentValues = (row: Commitment): ReadonlyArray<SQLQueryBindings> => [
  row.id, row.run, row.title, row.sourceKind, row.sourceRef, nullable(row.quote), nullable(row.plan), nullable(row.part), nullable(row.rank),
  nullable(row.ownerLane), nullable(row.ownerSession), row.state, nullable(row.startedAt), nullable(row.reviewBy), nullable(row.wokeAt),
  nullable(row.head), nullable(row.requestPath), nullable(row.landedCommit), nullable(row.decidedWhy), nullable(row.noticeUntil), row.createdAt, row.updatedAt,
  nullable(row.startHead), nullable(row.noticeBy), Number(row.noticeOutsideRun),
]

const writeCommitment = (db: Database, row: Commitment): void => {
  db.query<Raw, Array<SQLQueryBindings>>(UPSERT_COMMITMENT).run(...commitmentValues(row))
  db.query<Raw, [string]>("DELETE FROM prerequisite WHERE commitment_id = ?").run(row.id)
  for (const each of row.after) db.query<Raw, Array<SQLQueryBindings>>("INSERT INTO prerequisite (commitment_id, kind, ref, met_at) VALUES (?, ?, ?, ?)").run(row.id, each.kind, each.ref, nullable(each.metAt))
}

const writeHandBack = (db: Database, row: HandBack): void => {
  db.query<Raw, Array<SQLQueryBindings>>(
    `INSERT INTO hand_back (id, run, owner_lane, role, round, session, verdict, head, file, at, routing, routed_at, routed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET routing = excluded.routing, routed_at = excluded.routed_at, routed_by = excluded.routed_by`,
  ).run(row.id, row.run, row.ownerLane, row.role, nullable(row.round), row.session, row.verdict, nullable(row.head), nullable(row.file), row.at, row.routing, nullable(row.routedAt), nullable(row.routedBy))
}

const writeWord = (db: Database, row: Word): void => {
  db.query<Raw, Array<SQLQueryBindings>>("INSERT OR IGNORE INTO word (run, word, given_at, given_by) VALUES (?, ?, ?, ?)").run(row.run, row.word, row.givenAt, row.givenBy)
}

const writeEvent = (db: Database, event: RecordEvent): void => {
  db.query<Raw, Array<SQLQueryBindings>>(
    "INSERT INTO event (at, run, subject_kind, subject_id, type, actor, actor_role, from_state, to_state, note, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(event.at, event.run, event.subjectKind, event.subjectId, event.happening._tag, event.actor.id, event.actor.role, nullable(event.fromState), nullable(event.toState), event.note, encodeData(event.happening))
}

/** Each row the fold changed: a row object is replaced only when an event touched it. */
const changed = <K, V>(before: ReadonlyMap<K, V>, after: ReadonlyMap<K, V>): ReadonlyArray<V> =>
  [...after].flatMap(([key, value]) => Arr.filter([value], () => before.get(key) !== value))

const write = (db: Database, before: Snapshot, events: ReadonlyArray<RecordEvent>): Snapshot => {
  const after = fold(before, events)
  for (const event of events) writeEvent(db, event)
  for (const row of changed(before.commitments, after.commitments)) writeCommitment(db, row)
  for (const row of changed(before.handBacks, after.handBacks)) writeHandBack(db, row)
  for (const row of changed(before.words, after.words)) writeWord(db, row)
  return after
}

const eventOf = (row: Raw): Result.Result<StoredEvent, string> =>
  Result.map(
    Result.mapError(decodeData(textIn(row, "data")), (issue) => `event ${Option.getOrElse(intOf(row, "seq"), () => 0)}: ${String(issue)}`),
    (happening): StoredEvent => ({
      seq: Option.getOrElse(intOf(row, "seq"), () => 0),
      at: textIn(row, "at"),
      run: textIn(row, "run"),
      subjectKind: literalOf(SUBJECT_KINDS, "commitment")(row, "subject_kind"),
      subjectId: textIn(row, "subject_id"),
      actor: { id: textIn(row, "actor"), role: literalOf(ACTOR_ROLES, "plugin")(row, "actor_role") },
      fromState: textOf(row, "from_state"),
      toState: textOf(row, "to_state"),
      note: textIn(row, "note"),
      happening,
    }),
  )

const eventsOf = (rows: ReadonlyArray<Raw>): Result.Result<ReadonlyArray<StoredEvent>, string> => Result.all(rows.map(eventOf))

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/** The store on an open database; `refusal`: why every write is refused (a file of a newer version), when it is. */
export const make = (db: Database, refusal: Option.Option<string>): CommitmentRecord["Service"] => {
  const attempt = <A>(name: string, body: () => A) => Effect.try({ try: body, catch: (cause) => new RecordFailed({ message: `record ${name}: ${messageOf(cause)}` }) })
  const decoded = <A>(name: string, result: Result.Result<A, string>) =>
    Result.match(result, { onFailure: (message) => Effect.fail(new RecordFailed({ message: `record ${name}: ${message}` })), onSuccess: (value) => Effect.succeed(value) })
  return CommitmentRecord.of({
    run: (command, context) =>
      Option.match(refusal, {
        onSome: (why) => Effect.fail(new RecordFailed({ message: why })),
        onNone: () =>
          attempt(command._tag, () =>
            db
              .transaction(() => {
                const before = snapshotOf(db)
                return Result.map(decideCommand(before, command, context), (events) => ({ events, snapshot: write(db, before, events) }))
              })
              .immediate(),
          ).pipe(Effect.flatMap((result) => Result.match(result, { onFailure: (refused: RecordRefused) => Effect.fail(refused), onSuccess: (done) => Effect.succeed(done) }))),
      }),
    read: attempt("read", () => db.transaction(() => snapshotOf(db)).deferred()),
    history: (subjectKind, subjectId) =>
      attempt("history", () => db.query<Raw, [string, string]>("SELECT * FROM event WHERE subject_kind = ? AND subject_id = ? ORDER BY seq").all(subjectKind, subjectId)).pipe(
        Effect.flatMap((rows) => decoded("history", eventsOf(rows))),
      ),
    events: attempt("events", () => db.query<Raw, []>("SELECT * FROM event ORDER BY seq").all()).pipe(Effect.flatMap((rows) => decoded("events", eventsOf(rows)))),
  })
}

// ── Opening ──

const versionOf = (db: Database): number => Option.getOrElse(intOf(db.query<Raw, []>("PRAGMA user_version").get() ?? {}, "user_version"), () => 0)

/** Every migration past the file's version, in one immediate transaction; none when another writer did them first. */
const migrate = (db: Database): void =>
  db
    .transaction(() => {
      const from = versionOf(db)
      for (const statements of MIGRATIONS.slice(from)) for (const statement of statements) db.run(statement)
      if (from < MIGRATIONS.length) db.run(`PRAGMA user_version = ${MIGRATIONS.length}`)
    })
    .immediate()

/** The day's backup beside the file, once a UTC day, the newest `BACKUPS_KEPT` kept. */
export const backup = (db: Database, path: string, now: number): void => {
  const dir = join(dirname(path), "backup")
  const key = basename(path, ".db")
  const file = join(dir, `${key}-${isoOf(now).slice(0, 10)}.db`)
  if (existsSync(file)) return
  mkdirSync(dir, { recursive: true })
  // Into a file of this process's own, then renamed: two processes opening at once each write whole copies, never one file.
  const own = `${file}.${process.pid}.tmp`
  db.query<Raw, [string]>("VACUUM INTO ?").run(own)
  renameSync(own, file)
  const days = Arr.sort(
    readdirSync(dir).filter((name) => name.startsWith(`${key}-`) && name.endsWith(".db") && name.length === key.length + 14),
    Order.String,
  )
  for (const name of days.slice(0, Math.max(0, days.length - BACKUPS_KEPT))) unlinkSync(join(dir, name))
}

export interface OpenOptions {
  /** Open to read only (`mode=ro`): the CLI's reads. */
  readonly readonly: boolean
  /** Now, epoch ms: the day of the backup. */
  readonly now: number
}

/** How long a writer waits on another's lock, ms: SQLite's busy timeout, and the open's own retries. */
const BUSY_MS = 5000
const PRAGMAS = [`PRAGMA busy_timeout = ${BUSY_MS}`, "PRAGMA foreign_keys = ON"]

const isBusy = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "SQLITE_BUSY"

/** `work`, retried every 20 ms while SQLite answers SQLITE_BUSY until `deadline`; its last try's outcome, thrown as it throws. */
const settled = <A>(work: () => A, deadline: number): A => {
  const done = Result.try({ try: work, catch: (cause) => cause })
  if (Result.isSuccess(done)) return done.success
  if (!isBusy(done.failure) || Date.now() >= deadline) return work()
  Bun.sleepSync(20)
  return settled(work, deadline)
}

/** An open database, and why its writes are refused when they are. */
interface Connected {
  readonly db: Database
  readonly refusal: Option.Option<string>
}

/** The database at `path` opened, created and migrated (or read-only), and why its writes are refused when they are. */
const connect = (path: string, options: OpenOptions): Connected => {
  if (options.readonly) {
    const db = new Database(path, { readonly: true, strict: true })
    db.run("PRAGMA busy_timeout = 5000")
    return { db, refusal: Option.some(`record: ${path} is open to read only`) }
  }
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true, strict: true })
  for (const pragma of PRAGMAS) db.run(pragma)
  // Two writers opening a new file at once (two server locations, the CLI) race for the switch to WAL, which SQLite
  // answers SQLITE_BUSY at once, past the busy timeout: retried for as long as the timeout.
  const deadline = Date.now() + BUSY_MS
  settled(() => db.run("PRAGMA journal_mode = WAL"), deadline)
  db.run("PRAGMA synchronous = NORMAL")
  const version = settled(() => versionOf(db), deadline)
  if (version > VERSION) return { db, refusal: Option.some(`record: ${path} is version ${version}; this code writes version ${VERSION}: update it to write`) }
  settled(() => migrate(db), deadline)
  backup(db, path, options.now)
  return { db, refusal: Option.none() }
}

/** The record at `path`, open for the scope's life. */
export const open = (path: string, options: OpenOptions) =>
  Effect.acquireRelease(
    Effect.try({ try: () => connect(path, options), catch: (cause) => new RecordFailed({ message: `record: open ${path}: ${messageOf(cause)}` }) }),
    (opened) => Effect.sync(() => opened.db.close()),
  )

/** The record at `path` as the layer's store. A file that cannot be opened is a defect at setup, naming why. */
export const layer = (path: string, options: OpenOptions) => Layer.effect(CommitmentRecord, Effect.map(open(path, options), (opened) => make(opened.db, opened.refusal)))

/** A store that refuses every call with `failed`: the record whose file did not open, so its callers say why and go on. */
export const failedStore = (failed: RecordFailed): CommitmentRecord["Service"] =>
  CommitmentRecord.of({ run: () => Effect.fail(failed), read: Effect.fail(failed), history: () => Effect.fail(failed), events: Effect.fail(failed) })

/** The record at `path`, opened at the layer's build with now's backup; a file that does not open gives `failedStore`, never a dead plugin. */
export const layerOrFailed = (path: string) =>
  Layer.effect(
    CommitmentRecord,
    Effect.flatMap(Clock.currentTimeMillis, (now) => open(path, { readonly: false, now })).pipe(
      Effect.map((opened) => make(opened.db, opened.refusal)),
      Effect.catch((failed) => Effect.succeed(failedStore(failed))),
    ),
  )

/** The store on the file at `path` outside a scope, for a script that runs commands one after another (the CLI, a writer test); `close` ends it. */
export const connectSync = (path: string, options: OpenOptions) => {
  const opened = connect(path, options)
  return { store: make(opened.db, opened.refusal), close: () => opened.db.close() }
}

/** The replay law's read: the rows the events fold to from an empty record. */
export const replayed = (events: ReadonlyArray<RecordEvent>): Snapshot => fold(EMPTY, events)

const encodeHappening = Schema.encodeSync(Happening)

/** One event as the CLI's `export` writes it: a JSON line with the event table's columns, `data` its fields. */
export const exportLine = (event: StoredEvent): string =>
  JSON.stringify({
    seq: event.seq,
    at: event.at,
    run: event.run,
    subject_kind: event.subjectKind,
    subject_id: event.subjectId,
    type: event.happening._tag,
    actor: event.actor.id,
    actor_role: event.actor.role,
    from_state: nullable(event.fromState),
    to_state: nullable(event.toState),
    note: event.note,
    data: encodeHappening(event.happening),
  })
