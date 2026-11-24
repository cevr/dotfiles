// @reads all
// @reads-reason computed read at mods/orchestrate/sqlite/boundary.test.ts: const emptyFile = yield* Effect.promise(() => file(schema).bytes())
// The record's one boundary (record.ts `bounded`), proved column by column on the SQLite file: for every TEXT column the
// live schema has, a driver puts a token-shaped secret where that column is written from, through the commands a tool,
// a worker's follow_up or an import sends. A one-word column refuses the whole command, naming the column and never
// repeating the value; a free-text column keeps the text with the secret redacted; and afterwards no column of any
// table holds the secret. A column with no driver fails here: a new column is routed through the boundary and given a
// driver, or this test stays red.
import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { file, write } from "bun"
import { Array as Arr, Effect, Layer, Match, Option, Result, Schema } from "effect"
import { simulationTest } from "../../../sim/seed.ts"
import { textsOf } from "../../../sim/canary.ts"
import { KINDS, leaked } from "../../../sim/tokens.ts"
import { generator } from "../../../sim/runtime.ts"
import { scratch } from "../../../tests/scratch.ts"
import { DEFAULT_RUN, followUpOf } from "../commitments-tool.ts"
import { type Actor, Command, decodeCommand, PartInput } from "../record.ts"
import { CommitmentRecord, Evidence } from "../service.ts"
import { evidenceOf } from "../reasons.ts"
import { hostServices } from "../../../sim/host-services.ts"
import { platform as ownPlatform } from "../node/platform.ts"
import { connected, make, textColumnsOf } from "./record.ts"

const T0 = Date.parse("2027-01-15T08:00:00.000Z")
/** A reader that finds no receipt and no document: the follow-ups here name a dependency. */
const NO_EVIDENCE = evidenceOf(new Map(), new Map())
const ROOT: Actor = { id: "ses_root", role: "root" }
const IMPORT: Actor = { id: "ergo-register", role: "import" }
/** The host's files, paths and processes (the fork gives a plugin these), and the plugin's own digest. */
const platform = Layer.mergeAll(hostServices, ownPlatform)

const AT = "2027-01-15T08:00:00.000Z"
/** A token-shaped secret (a GitHub token's form, invented): a slug by its characters, so only the secret check refuses it there. */
const SECRET = ["ghp", "0123456789abcdefghijABCDEFGHIJ0123"].join("_")
const S = SECRET

/** A command, the actor that sends it, and the column its refusal names (none: the secret is kept redacted). */
interface Sent {
  readonly command: Command
  readonly actor: Actor
}
/** How a column is reached: the commands before (no secret), the one that carries it, and what the record answers. */
type Driver =
  | { readonly kind: "refused"; readonly setup: ReadonlyArray<Sent>; readonly sent: Sent; readonly names: string }
  | { readonly kind: "redacted"; readonly setup: ReadonlyArray<Sent>; readonly sent: Sent }
  /** A literal column: no command decodes with any other value in it (its field is a literal in the command's schema). */
  | { readonly kind: "literal"; readonly encoded: string }
  /** A column no code writes: it stays empty. */
  | { readonly kind: "unwritten" }
  | { readonly kind: "derived" }

const by = (command: Command, actor: Actor = ROOT): Sent => ({ command, actor })
const part = (id: string, fields: Partial<{ title: string; part: string }> = {}) => PartInput.make({ id, title: fields.title ?? `the ${id} part`, part: Option.fromUndefinedOr(fields.part) })
const add = (ids: ReadonlyArray<string>, fields: Partial<{ run: string; sourceRef: string; quote: string; plan: string; title: string; part: string; suggestOwner: string }> = {}) =>
  Command.cases.add.make({
    run: fields.run ?? DEFAULT_RUN,
    sourceKind: Option.match(Option.fromUndefinedOr(fields.quote), { onNone: () => "plan-part" as const, onSome: () => "owner-answer" as const }),
    sourceRef: fields.sourceRef ?? "plan.md:1",
    quote: Option.fromUndefinedOr(fields.quote),
    plan: Option.fromUndefinedOr(fields.plan),
    suggestOwner: Option.fromUndefinedOr(fields.suggestOwner),
    parts: ids.map((id) => part(id, fields)),
  })
const assign = (id: string, fields: Partial<{ ownerLane: string; ownerSession: string; manual: string }> = {}) =>
  Command.cases.assign.make({
    id,
    ownerLane: fields.ownerLane ?? "u1",
    ownerSession: Option.fromUndefinedOr(fields.ownerSession),
    after: Option.match(Option.fromUndefinedOr(fields.manual), { onNone: () => [], onSome: (ref) => [{ kind: "manual" as const, ref }] }),
  })
const handBack = (fields: Partial<{ run: string; ownerLane: string; role: string; session: string; head: string; file: string }> = {}) =>
  Command.cases.hand_back.make({
    run: fields.run ?? DEFAULT_RUN,
    ownerLane: fields.ownerLane ?? "u1",
    role: fields.role ?? "implementor",
    session: fields.session ?? "ses_worker",
    verdict: "done",
    head: Option.fromUndefinedOr(fields.head),
    file: Option.fromUndefinedOr(fields.file),
    claims: [],
  })
/** An import of one row `id` (an invented register row), its fields and its one history event changed by `change`. */
const imported = (
  id: string,
  row: Partial<{ ownerLane: string; ownerSession: string; startedAt: string; reviewBy: string; head: string; requestPath: string; landedCommit: string; createdAt: string; updatedAt: string; state: "open" | "landed" }> = {},
  history: Partial<{ at: string; actor: string; from: string; to: string; note: string }> = {},
) =>
  Command.cases.import.make({
    run: DEFAULT_RUN,
    rows: [
      {
        id,
        row: {
          title: `the ${id} row`,
          sourceKind: "plan-part",
          sourceRef: "register:1",
          quote: Option.none(),
          plan: Option.none(),
          part: Option.none(),
          rank: Option.none(),
          ownerLane: Option.fromUndefinedOr(row.ownerLane),
          ownerSession: Option.fromUndefinedOr(row.ownerSession),
          state: row.state ?? "open",
          startedAt: Option.fromUndefinedOr(row.startedAt),
          reviewBy: Option.some(row.reviewBy ?? "2027-01-22T08:00:00.000Z"),
          head: Option.fromUndefinedOr(row.head),
          requestPath: Option.fromUndefinedOr(row.requestPath),
          landedCommit: Option.fromUndefinedOr(row.landedCommit),
          decidedWhy: Option.none(),
          createdAt: row.createdAt ?? AT,
          updatedAt: row.updatedAt ?? AT,
          after: [],
        },
        history: [{ at: history.at ?? AT, actor: history.actor ?? "ORCH", fromState: Option.fromUndefinedOr(history.from), toState: Option.some(history.to ?? "open"), note: history.note ?? "filed" }],
      },
    ],
  })

/** A role as a caller that bypassed the types would give it. */
const roleOf = (value: string): Actor["role"] => Schema.decodeUnknownSync(Schema.Any)(value)

const refused = (names: string, sent: Sent, setup: ReadonlyArray<Sent> = []): Driver => ({ kind: "refused", setup, sent, names })
const redacted = (sent: Sent, setup: ReadonlyArray<Sent> = []): Driver => ({ kind: "redacted", setup, sent })
/** A command as JSON a caller sends, decoded only by the command's schema. */
const literal = (encoded: string): Driver => ({ kind: "literal", encoded })
const UNWRITTEN: Driver = { kind: "unwritten" }
/** A column the fold derives from an event's kind alone (a close with no reason: `placed`, `historical`), no command field: its CHECK holds it to them. */
const DERIVED: Driver = { kind: "derived" }
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any))
const jsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String))
const OWNED = [by(add(["c1"]))]
/** The invariant a guarantee names, declared by the root as the evidence reader would have found its document. */
const DOCUMENT = { path: "docs/record.md", blob: "b".repeat(40), commit: "c".repeat(40) }
const declare = (fields: Partial<{ id: string; anchor: string; path: string; blob: string; commit: string }> = {}) =>
  Command.cases.invariant.make({ id: fields.id ?? "one-writer", anchor: fields.anchor ?? "one-writer", observed: { path: fields.path ?? DOCUMENT.path, blob: fields.blob ?? DOCUMENT.blob, commit: fields.commit ?? DOCUMENT.commit } })
const GUARANTEE = { reasonClass: "guarantee" as const, referent: "invariant/one-writer" }
const DECLARED = [...OWNED, by(declare())]
/** An import's history event carries `at` (every derived time column is a fold of an event's time) and its states. */
const historyAt = refused("event.at", by(imported("i1", {}, { at: S }), IMPORT))

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,119}$/

const dependency = (token: string): Driver => {
  const referent = `commitment/${token}`
  // A dependency's public pointer accepts a slug up to 80 characters; other shapes must fail the decoder.
  if (!SLUG.test(token))
    return literal(`{ "_tag": "defer", "id": "c1", "reason": { "reasonClass": "dependency", "referent": ${jsonString(referent)} } }`)
  return refused("commitment.referent", by(Command.cases.defer.make({ id: "c1", reason: { reasonClass: "dependency", referent } })), OWNED)
}

/** Each TEXT column's driver, by `<table>.<column>`. */
const driversOf = (S: string) => new Map<string, Driver>([
  ["commitment.id", refused("event.subject_id", by(add([S])))],
  ["commitment.run", refused("event.run", by(add(["c1"], { run: S })))],
  ["commitment.title", redacted(by(add(["c1"], { title: `the title ${S}` })))],
  ["commitment.source_kind", literal(`{ "_tag": "add", "run": "r", "sourceKind": ${jsonString(S)}, "sourceRef": "x", "parts": [] }`)],
  ["commitment.source_ref", redacted(by(add(["c1"], { sourceRef: `plan.md ${S}` })))],
  ["commitment.quote", redacted(by(add(["c1"], { quote: `the owner said ${S}` })))],
  ["commitment.plan", redacted(by(add(["c1"], { plan: `the plan ${S}` })))],
  ["commitment.part", redacted(by(add(["c1"], { part: `the part ${S}` })))],
  ["commitment.rank", literal(`{ "_tag": "add", "run": "r", "sourceKind": "plan-part", "sourceRef": "x", "parts": [{ "id": "c1", "title": "t", "rank": ${jsonString(S)} }] }`)],
  ["commitment.owner_lane", refused("commitment.owner_lane", by(assign("c1", { ownerLane: S })), OWNED)],
  ["commitment.owner_session", refused("commitment.owner_session", by(assign("c1", { ownerSession: S })), OWNED)],
  ["commitment.state", literal(`{ "_tag": "import", "run": "r", "rows": [{ "id": "i1", "row": { "title": "t", "sourceKind": "plan-part", "sourceRef": "plan:1", "after": [], "createdAt": "${AT}", "updatedAt": "${AT}", "state": ${jsonString(S)} }, "history": [] }] }`)],
  ["commitment.started_at", refused("commitment.started_at", by(imported("i1", { startedAt: S }), IMPORT))],
  ["commitment.review_by", refused("commitment.review_by", by(imported("i1", { reviewBy: S }), IMPORT))],
  ["commitment.woke_at", historyAt],
  ["commitment.head", refused("commitment.head", by(imported("i1", { head: S }), IMPORT))],
  ["commitment.request_path", redacted(by(imported("i1", { requestPath: `requests/${S}.md` }), IMPORT))],
  ["commitment.landed_commit", refused("commitment.landed_commit", by(imported("i1", { state: "landed", landedCommit: S }), IMPORT))],
  ["commitment.decided_why", redacted(by(Command.cases.decide.make({ id: "c1", why: `because ${S}`, reason: GUARANTEE })), DECLARED)],
  ["commitment.notice_until", historyAt],
  ["commitment.created_at", refused("commitment.created_at", by(imported("i1", { createdAt: S }), IMPORT))],
  ["commitment.updated_at", refused("commitment.updated_at", by(imported("i1", { updatedAt: S }), IMPORT))],
  ["commitment.start_head", refused("commitment.start_head", by(Command.cases.lane.make({ run: DEFAULT_RUN, unit: "u1", startHead: Option.some(S) })))],
  ["commitment.notice_by", refused("event.actor", by(add(["c1"]), { id: S, role: "root" }))],
  ["commitment.lane_path", refused("commitment.lane_path", by(Command.cases.lane.make({ run: DEFAULT_RUN, unit: "u1", path: Option.some(`/work/${S}`) })))],
  ["commitment.reason_class", literal(`{ "_tag": "defer", "id": "c1", "reason": { "reasonClass": ${jsonString(S)}, "referent": "commitment/c2" } }`)],
  ["commitment.referent", dependency(S)],
  ["commitment.unreasoned_close", DERIVED],
  ["invariant.id", refused("event.subject_id", by(declare({ id: S })))],
  ["invariant.doc_path", refused("invariant.doc_path", by(declare({ path: `docs/${S}.md` })))],
  ["invariant.anchor", refused("invariant.anchor", by(declare({ anchor: S })))],
  ["invariant.blob", refused("invariant.blob", by(declare({ blob: S })))],
  ["invariant.commit_sha", refused("invariant.commit_sha", by(declare({ commit: S })))],
  ["invariant.declared_at", historyAt],
  ["invariant.declared_by", refused("event.actor", by(declare(), { id: S, role: "root" }))],
  ["prerequisite.commitment_id", refused("event.subject_id", by(add([S])))],
  ["prerequisite.kind", literal(`{ "_tag": "assign", "id": "c1", "ownerLane": "u1", "after": [{ "kind": ${jsonString(S)}, "ref": "x" }] }`)],
  ["prerequisite.ref", refused("prerequisite.ref", by(assign("c1", { manual: S })), OWNED)],
  ["prerequisite.met_at", historyAt],
  ["event.at", historyAt],
  ["event.run", refused("event.run", by(Command.cases.word.make({ run: S, word: "go" })))],
  ["event.subject_kind", DERIVED],
  ["event.subject_id", refused("event.subject_id", by(Command.cases.word.make({ run: DEFAULT_RUN, word: S })))],
  ["event.type", literal(`{ "_tag": ${jsonString(S)} }`)],
  ["event.actor", refused("event.actor", by(imported("i1", {}, { actor: S }), IMPORT))],
  // A role is the caller's own (the tool's root, a worker, the import), never a field of a command: one that is no role is refused.
  ["event.actor_role", refused("event.actor_role", by(add(["c1"]), { id: "ses_root", role: roleOf(S) }))],
  ["event.from_state", refused("event.from_state", by(imported("i1", {}, { from: S }), IMPORT))],
  ["event.to_state", refused("event.to_state", by(imported("i1", {}, { to: S }), IMPORT))],
  ["event.note", redacted(by(imported("i1", {}, { note: `filed ${S}` }), IMPORT))],
  ["event.data", refused("suggest_owner", by(add(["c1"], { suggestOwner: S })))],
  ["hand_back.run", refused("event.run", by(handBack({ run: S })))],
  ["hand_back.owner_lane", refused("hand_back.owner_lane", by(handBack({ ownerLane: S })))],
  ["hand_back.role", refused("hand_back.role", by(handBack({ role: S })))],
  ["hand_back.session", refused("hand_back.session", by(handBack({ session: S })))],
  ["hand_back.verdict", literal(`{ "_tag": "hand_back", "run": "r", "ownerLane": "u1", "role": "x", "session": "s", "verdict": ${jsonString(S)}, "claims": [] }`)],
  ["hand_back.head", refused("hand_back.head", by(handBack({ head: S })))],
  ["hand_back.file", redacted(by(handBack({ file: `requests/${S}.md` })))],
  ["hand_back.at", historyAt],
  ["hand_back.routing", literal(`{ "_tag": "route", "handBack": 1, "as": ${jsonString(S)} }`)],
  ["hand_back.routed_at", historyAt],
  ["hand_back.routed_by", refused("event.actor", by(Command.cases.route.make({ handBack: 1, as: "routed" }), { id: S, role: "root" }), [by(handBack())])],
  ["lane_session.lane", UNWRITTEN],
  ["lane_session.session", UNWRITTEN],
  ["word.run", refused("event.run", by(Command.cases.word.make({ run: S, word: "go" })))],
  ["word.word", refused("event.subject_id", by(Command.cases.word.make({ run: DEFAULT_RUN, word: S })))],
  ["word.given_at", historyAt],
  ["word.given_by", refused("event.actor", by(Command.cases.word.make({ run: DEFAULT_RUN, word: "go" }), { id: S, role: "root" }))],
])

/** Every TEXT value of every table in the file, with its column. */
const storedIn = (db: Database): ReadonlyArray<readonly [string, string]> =>
  textColumnsOf(db).flatMap((column) => valuesIn(db, column).map((value) => [column, value] as const))

const valuesIn = (db: Database, column: string): ReadonlyArray<string> => {
  const [table, name] = column.split(".")
  return db.query<{ value: string }, []>(`SELECT coalesce(${name}, '') AS value FROM ${table}`).all().map((each) => each.value)
}

/** A driver that runs commands: the ones before, and the one with the secret. */
type Driving = Extract<Driver, { readonly kind: "refused" | "redacted" }>

/** The driver's refusal, if any, and the bytes of the DB and WAL while the writer still has them open. */
const drive = (schema: Uint8Array, path: string, column: string, driver: Driving) =>
  Effect.gen(function* () {
    // A private copy of the empty migrated fixture for each field. The real writer is the same; there is no need
    // to repeat migration or daily backup for 17,688 independent combinations. Read before the WAL is closed.
    yield* Effect.promise(() => write(path, schema))
    using db = new Database(path, { strict: true })
    db.run("PRAGMA foreign_keys = ON")
    db.run("PRAGMA synchronous = NORMAL")
    const store = make(db, Option.none())
    for (const each of driver.setup) yield* store.run(each.command, { actor: each.actor, now: T0 })
    const done = yield* Effect.result(store.run(driver.sent.command, { actor: driver.sent.actor, now: T0 }))
    const bytes = yield* textsOf([path, `${path}-wal`])
    const redacted = Result.isSuccess(done) && driver.kind === "redacted" && valuesIn(db, column).some((value) => value.includes("[redacted]"))
    const why = Result.match(done, {
      onSuccess: () => Option.none<string>(),
      onFailure: (failed) => Option.some(Match.value(failed).pipe(Match.tag("RecordRefused", (each) => each.reason), Match.orElse((each) => each.message))),
    })
    return { why, bytes, redacted }
  })

/** The column a driven refusal must name: its driver's, else the column itself. */
const namedBy = (driver: Driving, column: string): string => Match.value(driver).pipe(Match.when({ kind: "refused" }, (each) => each.names), Match.orElse(() => column))

const slugColumns = new Set(["commitment.id", "prerequisite.commitment_id", "invariant.id", "invariant.anchor"])
const tokenColumns = new Map([
  ["commitment.run", "run"], ["commitment.owner_lane", "owner"], ["commitment.owner_session", "session"],
  ["prerequisite.ref", "manual wait"], ["event.run", "run"], ["event.subject_id", "word"],
  ["hand_back.owner_lane", "owner"], ["hand_back.session", "session"], ["hand_back.head", "head"],
  ["word.run", "run"], ["word.word", "word"],
])

/** Some invalid shapes fail the public grammar before they can reach the corresponding SQL column check. */
const refusalOf = (secret: string, driver: Driving, column: string): string => {
  if (!SLUG.test(secret) && slugColumns.has(column)) return "the id is not a slug"
  if (!TOKEN.test(secret)) {
    const word = Option.fromUndefinedOr(tokenColumns.get(column))
    if (Option.isSome(word)) return `the ${word.value} is not one token`
  }
  return `column ${namedBy(driver, column)} `
}

/** What a driven command did with the secret, in a word. */
const answerOf = (redacted: boolean, expected: string, why: Option.Option<string>): string =>
  Option.match(why, {
    onNone: () => Match.value(redacted).pipe(Match.when(true, () => "redacted"), Match.orElse(() => "kept")),
    onSome: (reason) =>
      Match.value(reason).pipe(
        Match.when((text) => text.includes(expected), () => "refused"),
        Match.orElse((text) => `refused: ${text}`),
      ),
  })

/** What the record does with one column's driver: its outcome in a word, the secret's leaks first. */
const outcomeOf = (dir: string, schema: Uint8Array, column: string, at: number, driver: Driver, secret: string, fragments: string) =>
  Match.value(driver).pipe(
    Match.when({ kind: "literal" }, (each) => Effect.sync(() => Result.match(decodeCommand(decodeJson(each.encoded)), { onFailure: () => "literal", onSuccess: () => "decoded" }))),
    Match.when({ kind: "unwritten" }, () => Effect.succeed("unwritten")),
    Match.when({ kind: "derived" }, () => Effect.succeed("derived")),
    Match.orElse((each) =>
      Effect.gen(function* () {
        const path = `${dir}/c${at}.db`
        const { why, bytes, redacted } = yield* drive(schema, path, column, each)
        const fixture = { value: fragments, secrets: [fragments] }
        if (bytes.some((file) => leaked(file, fixture).length > 0)) return "fragment in SQLite bytes"
        if (Option.exists(why, (message) => leaked(message, fixture).length > 0)) return "fragment in refusal"
        return answerOf(redacted, refusalOf(secret, each, column), why)
      }),
    ),
  )

// An outer random run and two crossing fixed-width shapes. At each offset the last known form ends past
// the first; the whole run is the sensitive region, including the pieces a sequential replacement leaves.
const overlapping = (at: number): string => {
  const stem = "t8Q3v6Z5b1D0p7X4m9J2f"
  const fixed = ["AK", "IA", "J8BX", "AK", "IA", "M2W7V9H0Z4G6Q5L3"].join("")
  return `${stem.slice(0, at)}${fixed}${stem.slice(at)}`
}

/** All known forms crossed with the offset and then with columns by `checkColumns`. */
const crossingForms = KINDS.map(([kind, draw]) => {
  const token = draw(generator(`record-column-overlap/${kind}`))
  return { kind, token }
})

const checkColumns = (secret: string, fragments = secret, multiline = false) =>
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("record-boundary-")),
    (dir) =>
      Effect.gen(function* () {
        const schema = `${dir.path}/schema.db`
        const made = yield* connected(schema, { readonly: false, now: T0 })
        made.close()
        const db = new Database(schema, { readonly: true })
        const columns = textColumnsOf(db)
        db.close()
        const emptyFile = yield* Effect.promise(() => file(schema).bytes())
        const drivers = driversOf(secret)
        expect([...columns].sort()).toEqual([...drivers.keys()].sort())
        const outcomes = yield* Effect.forEach(columns, (column, at) =>
          Effect.map(outcomeOf(dir.path, emptyFile, column, at, Option.getOrElse(Option.fromUndefinedOr(drivers.get(column)), () => UNWRITTEN), secret, fragments), (outcome) => [column, outcome] as const),
        )
        const expected = columns.map((column) => [column, Option.match(Option.fromUndefinedOr(drivers.get(column)), {
          onNone: () => "no driver",
          onSome: (driver) => {
            if (multiline && driver.kind === "redacted" && column !== "event.note") return "refused"
            return driver.kind
          },
        })] as const)
        expect(outcomes).toEqual(expected)
        return outcomes.length
      }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ).pipe(Effect.provide(platform))

simulationTest(
  "a secret driven into each TEXT column is refused naming the column, or kept redacted; no column of any table holds it",
  checkColumns(SECRET),
)

simulationTest(
  "crossing tokens moved across every offset in every TEXT field leave no fragment in the DB, WAL or refusal",
  Effect.forEach(Arr.range(0, 21), (at) => checkColumns(overlapping(at)), { discard: true }),
)

for (const { kind, token } of crossingForms) {
  simulationTest(`form × offset × column: ${kind} leaves no six-character fragment even when glued to both edges`, Effect.gen(function* () {
    const cases = Arr.range(0, 21)
    expect(cases.length).toBe(22)
    const tested = yield* Effect.forEach(cases, (offset) =>
      checkColumns(`${"q".repeat(offset)}${token.text}${"z".repeat(21 - offset)}`, token.secret, kind === "private key"))
    const generated = cases.length * driversOf(token.text).size
    expect({ generated, checked: tested.reduce((sum, each) => sum + each, 0), discarded: 0 })
      .toEqual({ generated: 22 * 67, checked: 22 * 67, discarded: 0 })
  }))
}

simulationTest(
  "a worker's follow_up with a secret as its id or run is refused whole, naming the column, and writes nothing",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("record-boundary-")),
    (dir) =>
      Effect.gen(function* () {
        const path = `${dir.path}/repo.db`
        const opened = yield* connected(path, { readonly: false, now: T0 })
        const worker: Actor = { id: "ses_worker", role: "worker" }
        yield* opened.store.run(add(["p1"]), { actor: ROOT, now: T0 })
        const record = <A, E>(work: Effect.Effect<A, E, CommitmentRecord | Evidence>) => work.pipe(Effect.provideService(CommitmentRecord, opened.store), Effect.provideService(Evidence, NO_EVIDENCE))
        const waits = { reason_class: "dependency", referent: { kind: "commitment", id: "p1" } } as const
        const byId = yield* Effect.flip(record(followUpOf({ id: S, title: "a missing test", ...waits }, worker, "call_1", T0, dir.path)))
        const byRun = yield* Effect.flip(record(followUpOf({ id: "f1", title: "a missing test", run: S, ...waits }, worker, "call_2", T0, dir.path)))
        opened.close()
        expect([byId.includes("column event.subject_id "), byRun.includes("column event.run "), byId.includes(SECRET), byRun.includes(SECRET)]).toEqual([true, true, false, false])
        using db = new Database(path, { readonly: true })
        expect(storedIn(db).filter(([column, value]) => (column.startsWith("commitment.") || column.startsWith("event.")) && value.includes("f1"))).toEqual([])
      }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ).pipe(Effect.provide(platform)),
)
