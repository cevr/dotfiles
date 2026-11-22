// The commitment record over one SQLite file per repository per host (bun:sqlite), beside the memory mod's file and by
// its pattern: `$XDG_STATE_HOME/opencode-orchestrate/<repo key>.db`. WAL, a busy timeout and one immediate transaction
// per command let every OpenCode server location, subagent session and the CLI write side by side; a busy past the
// timeout is a `RecordFailed` the caller sees. Versions are `PRAGMA user_version` and a forward-only list of additive
// migrations applied in one transaction at open; a file of a newer version opens to read and refuses every write.
// At the first open of a UTC day the file is copied with `VACUUM INTO <dir>/backup/<key>-<date>.db`, the newest 7 kept.
import { Database, type SQLQueryBindings } from "bun:sqlite"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { Array as Arr, Clock, Effect, FileSystem, Layer, Option, Order, Path, Predicate, Result, Schedule, Schema, Stream } from "effect"
import { Digest } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  ACTOR_ROLES,
  type Commitment,
  EMPTY,
  fold,
  type HandBack,
  Happening,
  type Invariant,
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
  UNREASONED_CLOSES,
  VERDICTS,
  type Word,
  actedKey,
  wordKey,
} from "../record.ts"
import { REASON_CLASSES, type ReasonData, referentOf } from "../reasons.ts"
import { localKey, keyOfOrigin } from "../repo-key.ts"
import { CommitmentRecord, RecordFailed } from "../service.ts"
import { decideCommand } from "../standing.ts"

/** How many daily backups are kept. */
export const BACKUPS_KEPT = 7

/**
 * Version 1, the only one: the spec's DDL, with `word`, `notice` and `invariant` subjects, the `word` and `invariant`
 * tables, and each commitment's reason (reasons.ts) and close kind (record.ts `CLOSE_KINDS`). The development versions
 * before the first delivery (the lane's start head, the notice's closer, the lane's workspace) are folded in: no file
 * of them was delivered.
 *
 * A reason is a pair: `reason_class` and its canonical `referent`, both or neither, except the root's `not-asked` close
 * (unit C), whose referent is an `ask/<id>` with no class. A decided row's reason is a guarantee or none. `close_kind`
 * is derived from the row, never written: `guarantee` from the reason, `not-asked` from the `ask/` referent, and a
 * reasonless close from `unreasoned_close` (`placed` by the plugin, `historical` by an import). Every decided row has
 * exactly one kind and no other row has one.
 */
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
    start_head    TEXT,
    notice_by     TEXT,
    notice_outside_run INTEGER NOT NULL DEFAULT 0 CHECK (notice_outside_run IN (0, 1)),
    lane_path     TEXT,
    reason_class TEXT CHECK (reason_class IN ('guarantee','dependency','measured')),
    referent TEXT CHECK (referent IS NULL OR (length(referent) BETWEEN 1 AND 512 AND trim(referent) = referent)),
    unreasoned_close TEXT CHECK (unreasoned_close IS NULL OR unreasoned_close IN ('placed','historical')),
    close_kind TEXT GENERATED ALWAYS AS (CASE
      WHEN state <> 'decided' THEN NULL
      WHEN reason_class = 'guarantee' THEN 'guarantee'
      WHEN reason_class IS NULL AND substr(referent,1,4) = 'ask/' THEN 'not-asked'
      WHEN reason_class IS NULL AND referent IS NULL THEN unreasoned_close
    END) VIRTUAL,
    CHECK (owner_session IS NULL OR owner_lane IS NOT NULL),
    CHECK (owner_lane IS NULL OR review_by IS NOT NULL OR state <> 'open'),
    CHECK ((state = 'landed') = (landed_commit IS NOT NULL)),
    CHECK ((state = 'decided') = (decided_why IS NOT NULL)),
    CHECK (quote IS NULL OR source_kind IN ('owner-answer','owner-ask')),
    CHECK (
      (reason_class IS NULL AND referent IS NULL)
      OR (reason_class IS NOT NULL AND referent IS NOT NULL)
      OR (state = 'decided' AND reason_class IS NULL AND referent IS NOT NULL
          AND substr(referent,1,4) = 'ask/' AND length(referent) > 4)
    ),
    CHECK (state <> 'decided' OR reason_class IS NULL OR reason_class = 'guarantee'),
    CHECK ((state = 'decided') = (close_kind IS NOT NULL)),
    CHECK (unreasoned_close IS NULL OR (state = 'decided' AND reason_class IS NULL AND referent IS NULL))
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
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('commitment','hand_back','unit','batch','word','notice','invariant')),
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
  `CREATE TABLE invariant (
    id          TEXT PRIMARY KEY,
    doc_path    TEXT NOT NULL,
    anchor      TEXT NOT NULL,
    blob        TEXT NOT NULL,
    commit_sha  TEXT NOT NULL,
    declared_at TEXT NOT NULL,
    declared_by TEXT NOT NULL
  ) STRICT`,
  "CREATE INDEX commitment_owner_state ON commitment (owner_lane, state)",
  "CREATE INDEX hand_back_routing ON hand_back (routing, at)",
]

/** Each version's statements, in order: forward-only and additive (a non-additive change is the owner's). */
export const MIGRATIONS: ReadonlyArray<ReadonlyArray<string>> = [V1]

/** The schema version this code writes: one per migration, so the two cannot disagree. */
export const VERSION = MIGRATIONS.length

// ── Where the file is ──

/** What finding and opening the file needs of the host: its files, paths, git and a digest. */
export type Platform = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Digest.Digest

/** The record files' directory: `<stateHome>/opencode-orchestrate` (`$XDG_STATE_HOME`), `~/.local/state` when unset or empty. */
export const stateDir = (stateHome: Option.Option<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(Option.getOrElse(Option.filter(stateHome, (dir) => dir !== ""), () => path.join(TuiDirs.dirs().home, ".local/state")), "opencode-orchestrate")
  })

/** The record file of the repository `key`. */
export const pathOf = (stateHome: Option.Option<string>, key: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(yield* stateDir(stateHome), `${key}.db`)
  })

/** What git prints for `args` in `checkout`, trimmed, when it exits 0 and prints something; else none. */
const gitOut = (checkout: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make("git", ["-C", checkout, ...args], { stdin: "ignore", stderr: "ignore", forceKillAfter: "3 seconds" }))
      const [code, out] = yield* Effect.all([handle.exitCode, handle.stdout.pipe(Stream.decodeText(), Stream.mkString)], { concurrency: 2 })
      return Option.filter(Option.some(out.trim()), (text) => Number(code) === 0 && text !== "")
    }),
  ).pipe(Effect.orElseSucceed(() => Option.none<string>()))

/**
 * The checkout a workspace was made from, when `top` is laid out as `work` lays one (`<parent>/.work/<repo>/<name>`,
 * or Rift's older `<parent>/.rifts/<repo>/<name>`) and `<parent>/<repo>` is a git checkout; else `top` itself.
 */
const baseOf = (top: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const parts = top.split(path.sep)
    const laid = Option.map(Option.liftPredicate(parts, (each) => each.length > 3 && [".work", ".rifts"].includes(each.at(-3) ?? "")), (each) => [...each.slice(0, -3), each.at(-2) ?? ""].join(path.sep))
    if (Option.isNone(laid)) return top
    const checked = yield* gitOut(laid.value, ["rev-parse", "--git-common-dir"])
    return Option.getOrElse(Option.as(checked, laid.value), () => top)
  })

/**
 * The repository key of the checkout at `checkout`: its origin's (repo-key.ts); else `local-` and the real path of
 * its repository's common git directory hashed, read from the checkout's base (`baseOf`) when it is a workspace, so
 * a workspace, a worktree and their base share one record, and two repositories never do.
 */
export const keyOfCheckout = (checkout: string) =>
  Effect.gen(function* () {
    const origin = Option.flatMap(yield* gitOut(checkout, ["config", "--get", "remote.origin.url"]), keyOfOrigin)
    if (Option.isSome(origin)) return origin.value
    const fs = yield* FileSystem.FileSystem
    const top = Option.getOrElse(yield* gitOut(checkout, ["rev-parse", "--show-toplevel"]), () => checkout)
    const common = Option.getOrElse(yield* gitOut(yield* baseOf(yield* fs.realPath(top)), ["rev-parse", "--path-format=absolute", "--git-common-dir"]), () => top)
    const digest = yield* Digest.Digest
    return localKey(yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(yield* fs.realPath(common))))
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

/**
 * A row's reason, decoded strictly: none for the null pair, the class and a canonical pointer for a full one, and why
 * not for anything else (a referent the grammar does not take, a class with no referent; unit C's `ask/` close).
 */
const reasonRead = (row: Raw): Result.Result<Option.Option<ReasonData>, string> => {
  const reasonClass = optLiteral(REASON_CLASSES)(row, "reason_class")
  const referent = textOf(row, "referent")
  if (Option.isNone(reasonClass) && Option.isNone(referent) && Option.isNone(textOf(row, "reason_class"))) return Result.succeed(Option.none())
  return Option.match(Option.all([reasonClass, Option.filter(referent, (pointer) => Option.isSome(referentOf(pointer)))]), {
    onNone: () => Result.fail(`commitment ${textIn(row, "id")}: its reason is not one this code reads (a class and a canonical referent)`),
    onSome: ([each, pointer]) => Result.succeed(Option.some({ reasonClass: each, referent: pointer })),
  })
}

const commitmentOf = (row: Raw, after: ReadonlyArray<Prerequisite>, reason: Option.Option<ReasonData>): Commitment => ({
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
  lanePath: textOf(row, "lane_path"),
  noticeBy: textOf(row, "notice_by"),
  noticeOutsideRun: Option.contains(intOf(row, "notice_outside_run"), 1),
  reason,
  unreasonedClose: optLiteral(UNREASONED_CLOSES)(row, "unreasoned_close"),
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

const invariantOf = (row: Raw): Invariant => ({
  id: textIn(row, "id"),
  docPath: textIn(row, "doc_path"),
  anchor: textIn(row, "anchor"),
  blob: textIn(row, "blob"),
  commit: textIn(row, "commit_sha"),
  declaredAt: textIn(row, "declared_at"),
  declaredBy: textIn(row, "declared_by"),
})

/** The rows as they stand, or why a row does not read (a reason this code does not decode). */
const snapshotOf = (db: Database): Result.Result<Snapshot, string> => {
  const after = new Map<string, Array<Prerequisite>>()
  for (const row of db.query<Raw, []>("SELECT * FROM prerequisite ORDER BY rowid").all()) {
    const id = textIn(row, "commitment_id")
    after.set(id, [...(after.get(id) ?? []), prerequisiteOf(row)])
  }
  const rows = Result.all(db.query<Raw, []>("SELECT * FROM commitment").all().map((row) => Result.map(reasonRead(row), (reason) => [textIn(row, "id"), commitmentOf(row, after.get(textIn(row, "id")) ?? [], reason)] as const)))
  const handBacks = new Map(db.query<Raw, []>("SELECT * FROM hand_back").all().map((row) => [Option.getOrElse(intOf(row, "id"), () => 0), handBackOf(row)] as const))
  const words = new Map(db.query<Raw, []>("SELECT * FROM word").all().map((row) => [wordKey(textIn(row, "run"), textIn(row, "word")), wordOf(row)] as const))
  const acted = new Set(db.query<Raw, []>("SELECT DISTINCT actor, run FROM event").all().map((row) => actedKey(textIn(row, "actor"), textIn(row, "run"))))
  const invariants = new Map(db.query<Raw, []>("SELECT * FROM invariant").all().map((row) => [textIn(row, "id"), invariantOf(row)] as const))
  return Result.map(rows, (each): Snapshot => ({ commitments: new Map(each), handBacks, words, acted, invariants }))
}

const DataCodec = Schema.fromJsonString(Happening)
const encodeData = Schema.encodeSync(DataCodec)
const decodeData = Schema.decodeUnknownResult(DataCodec)

const nullable = <A>(value: Option.Option<A>) => Option.getOrNull(value)

const COMMITMENT_COLUMNS = [
  "id", "run", "title", "source_kind", "source_ref", "quote", "plan", "part", "rank", "owner_lane", "owner_session", "state", "started_at",
  "review_by", "woke_at", "head", "request_path", "landed_commit", "decided_why", "notice_until", "created_at", "updated_at",
  "start_head", "notice_by", "notice_outside_run", "lane_path", "reason_class", "referent", "unreasoned_close",
]

const UPSERT_COMMITMENT = `INSERT INTO commitment (${COMMITMENT_COLUMNS.join(", ")}) VALUES (${COMMITMENT_COLUMNS.map(() => "?").join(", ")})
  ON CONFLICT (id) DO UPDATE SET ${COMMITMENT_COLUMNS.slice(1).map((column) => `${column} = excluded.${column}`).join(", ")}`

const commitmentValues = (row: Commitment): ReadonlyArray<SQLQueryBindings> => [
  row.id, row.run, row.title, row.sourceKind, row.sourceRef, nullable(row.quote), nullable(row.plan), nullable(row.part), nullable(row.rank),
  nullable(row.ownerLane), nullable(row.ownerSession), row.state, nullable(row.startedAt), nullable(row.reviewBy), nullable(row.wokeAt),
  nullable(row.head), nullable(row.requestPath), nullable(row.landedCommit), nullable(row.decidedWhy), nullable(row.noticeUntil), row.createdAt, row.updatedAt,
  nullable(row.startHead), nullable(row.noticeBy), Number(row.noticeOutsideRun), nullable(row.lanePath),
  nullable(Option.map(row.reason, (each) => each.reasonClass)), nullable(Option.map(row.reason, (each) => each.referent)), nullable(row.unreasonedClose),
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

const writeInvariant = (db: Database, row: Invariant): void => {
  db.query<Raw, Array<SQLQueryBindings>>("INSERT OR IGNORE INTO invariant (id, doc_path, anchor, blob, commit_sha, declared_at, declared_by) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    row.id, row.docPath, row.anchor, row.blob, row.commit, row.declaredAt, row.declaredBy,
  )
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
  for (const row of changed(before.invariants, after.invariants)) writeInvariant(db, row)
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
                // A file whose rows this code cannot read refuses the write; the commitments it holds stay as they are.
                return Result.map(snapshotOf(db), (before) => Result.map(decideCommand(before, command, context), (events) => ({ events, snapshot: write(db, before, events) })))
              })
              .immediate(),
          ).pipe(Effect.flatMap((read) => decoded(command._tag, read)), Effect.flatMap((result) => Result.match(result, { onFailure: (refused: RecordRefused) => Effect.fail(refused), onSuccess: (done) => Effect.succeed(done) }))),
      }),
    read: attempt("read", () => db.transaction(() => snapshotOf(db)).deferred()).pipe(Effect.flatMap((read) => decoded("read", read))),
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

/** A name no other process picks: SQLite's own random bytes, as hex. */
const ownSuffix = (db: Database): string => String(db.query<Raw, []>("SELECT lower(hex(randomblob(8))) AS own").get()?.["own"] ?? "")

/** The day's backup beside the file, once a UTC day, the newest `BACKUPS_KEPT` kept. */
export const backup = (db: Database, file: string, now: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = path.join(path.dirname(file), "backup")
    const key = path.basename(file, ".db")
    const day = path.join(dir, `${key}-${isoOf(now).slice(0, 10)}.db`)
    if (yield* fs.exists(day)) return
    yield* fs.makeDirectory(dir, { recursive: true })
    // Into a file of this process's own, then renamed: two processes opening at once each write whole copies, never one file.
    const own = `${day}.${ownSuffix(db)}.tmp`
    yield* Effect.try({ try: () => db.query<Raw, [string]>("VACUUM INTO ?").run(own), catch: (cause) => new RecordFailed({ message: `record: backup ${day}: ${messageOf(cause)}` }) })
    yield* fs.rename(own, day)
    const days = Arr.sort(
      (yield* fs.readDirectory(dir)).filter((name) => name.startsWith(`${key}-`) && name.endsWith(".db") && name.length === key.length + 14),
      Order.String,
    )
    yield* Effect.forEach(days.slice(0, Math.max(0, days.length - BACKUPS_KEPT)), (name) => fs.remove(path.join(dir, name)))
  })

export interface OpenOptions {
  /** Open to read only (`mode=ro`): the CLI's reads. */
  readonly readonly: boolean
  /** Now, epoch ms: the day of the backup. */
  readonly now: number
}

/** How long a writer waits on another's lock, ms: SQLite's busy timeout, and the open's own retries. */
const BUSY_MS = 5000
/** The pause between the open's retries while another writer holds the file. */
const BUSY_PAUSE_MS = 20
const PRAGMAS = [`PRAGMA busy_timeout = ${BUSY_MS}`, "PRAGMA foreign_keys = ON"]

const isBusy = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "SQLITE_BUSY"

/** `work`, retried every 20 ms while SQLite answers SQLITE_BUSY, for as long as the busy timeout; its last try's failure else. */
const settled = <A>(work: () => A) =>
  Effect.try({ try: work, catch: (cause) => cause }).pipe(Effect.retry({ while: isBusy, schedule: Schedule.spaced(`${BUSY_PAUSE_MS} millis`), times: BUSY_MS / BUSY_PAUSE_MS }))

/** An open database, and why its writes are refused when they are. */
interface Connected {
  readonly db: Database
  readonly refusal: Option.Option<string>
}

/** The database at `path`, existing, attached with the record's pragmas: no migration, no backup (`connect` does both). */
const attached = (path: string, readonly: boolean): Database => {
  const db = new Database(path, { readonly, create: !readonly, strict: true })
  for (const pragma of PRAGMAS.slice(0, 2 - Number(readonly))) db.run(pragma)
  return db
}

/** The database at `path` opened, created and migrated (or read-only), and why its writes are refused when they are. */
const connect = (path: string, options: OpenOptions) =>
  Effect.gen(function* () {
    if (options.readonly) return { db: attached(path, true), refusal: Option.some(`record: ${path} is open to read only`) }
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true })
    const db = attached(path, false)
    // Two writers opening a new file at once (two server locations, the CLI) race for the switch to WAL, which SQLite
    // answers SQLITE_BUSY at once, past the busy timeout: retried for as long as the timeout.
    yield* settled(() => db.run("PRAGMA journal_mode = WAL"))
    db.run("PRAGMA synchronous = NORMAL")
    const version = yield* settled(() => versionOf(db))
    if (version > VERSION) return { db, refusal: Option.some(`record: ${path} is version ${version}; this code writes version ${VERSION}: update it to write`) }
    yield* settled(() => migrate(db))
    yield* backup(db, path, options.now)
    return { db, refusal: Option.none() }
  }).pipe(Effect.mapError((cause) => new RecordFailed({ message: `record: open ${path}: ${messageOf(cause)}` })))

/** The record at `path`, open for the scope's life. */
export const open = (path: string, options: OpenOptions) => Effect.acquireRelease(connect(path, options), (opened: Connected) => Effect.sync(() => opened.db.close()))

/** The store on the file at `path` outside a scope, for a script that runs commands one after another (a writer process, a test); `close` ends it. */
export const connected = (path: string, options: OpenOptions) => Effect.map(connect(path, options), (each) => ({ store: make(each.db, each.refusal), close: () => each.db.close() }))

/** The record at `path` as the layer's store. A file that cannot be opened is a defect at setup, naming why. */
export const layer = (path: string, options: OpenOptions) => Layer.effect(CommitmentRecord, Effect.map(open(path, options), (each) => make(each.db, each.refusal)))

/** A store that refuses every call with `failed`: the record whose file did not open, so its callers say why and go on. */
export const failedStore = (failed: RecordFailed): CommitmentRecord["Service"] =>
  CommitmentRecord.of({ run: () => Effect.fail(failed), read: Effect.fail(failed), history: () => Effect.fail(failed), events: Effect.fail(failed) })

/** The record at `path`, opened at the layer's build with now's backup; a file that does not open gives `failedStore`, never a dead plugin. */
export const layerOrFailed = (path: Effect.Effect<string, unknown, Platform>) =>
  Layer.effect(
    CommitmentRecord,
    Effect.gen(function* () {
      const file = yield* Effect.mapError(path, (cause) => new RecordFailed({ message: `record: no file: ${messageOf(cause)}` }))
      const now = yield* Clock.currentTimeMillis
      return yield* open(file, { readonly: false, now })
    }).pipe(
      Effect.map((each) => make(each.db, each.refusal)),
      Effect.catch((failed) => Effect.succeed(failedStore(failed))),
    ),
  )

/** Every TEXT column of the file's tables, as `<table>.<column>`: what the boundary's column map (record.ts `COLUMNS`) must name. */
export const textColumnsOf = (db: Database): ReadonlyArray<string> =>
  db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .flatMap((table) => db.query<{ name: string; type: string }, []>(`PRAGMA table_info(${table.name})`).all().flatMap((column) => Arr.filter([`${table.name}.${column.name}`], () => column.type === "TEXT")))

/**
 * The record at `path` in an existing folder, opened and migrated with SQLite alone: no backup, no folder made, no
 * wait on another writer. A test's or the simulated host's scratch file (`options.record`), opened where nothing may
 * wait on the platform; the plugin OpenCode loads opens through `layerOrFailed`.
 */
export const layerScratch = (path: string) =>
  Layer.effect(
    CommitmentRecord,
    Effect.try({
      try: () => {
        const db = attached(path, false)
        db.run("PRAGMA journal_mode = WAL")
        db.run("PRAGMA synchronous = NORMAL")
        const version = versionOf(db)
        if (version > VERSION) return make(db, Option.some(`record: ${path} is version ${version}; this code writes version ${VERSION}: update it to write`))
        migrate(db)
        return make(db, Option.none())
      },
      catch: (cause) => new RecordFailed({ message: `record: open ${path}: ${messageOf(cause)}` }),
    }).pipe(Effect.catch((failed) => Effect.succeed(failedStore(failed)))),
  )

/**
 * The store on a file `open` made and migrated, attached again outside a scope (a restart in the model run: a new
 * connection and store on the same file); `close` ends it.
 */
export const reattached = (path: string) => {
  const db = attached(path, false)
  return { store: make(db, Option.none()), close: () => db.close() }
}


/** The replay law's read: the rows the events fold to from an empty record. */
export const replayed = (events: ReadonlyArray<RecordEvent>): Snapshot => fold(EMPTY, events)

const encodeHappening = Schema.encodeSync(Happening)

const jsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

/** One event as the CLI's `export` writes it: a JSON line with the event table's columns, `data` its fields. */
export const exportLine = (event: StoredEvent): string =>
  jsonLine({
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
