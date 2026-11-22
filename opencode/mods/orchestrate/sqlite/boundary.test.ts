// The record's one boundary (record.ts `bounded`), proved column by column on the SQLite file: for every TEXT column the
// live schema has, a driver puts a token-shaped secret where that column is written from, through the commands a tool,
// a worker's follow_up or an import sends. A one-word column refuses the whole command, naming the column and never
// repeating the value; a free-text column keeps the text with the secret redacted; and afterwards no column of any
// table holds the secret. A column with no driver fails here: a new column is routed through the boundary and given a
// driver, or this test stays red.
import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { Effect, Option, Result, Schema } from "effect"
import * as Seed from "../../../sim/seed.ts"
import { scratch } from "../../../tests/scratch.ts"
import { DEFAULT_RUN, followUpOf } from "../commitments-tool.ts"
import { type Actor, Command, decodeCommand, PartInput } from "../record.ts"
import { CommitmentRecord } from "../service.ts"
import { connectSync, textColumnsOf } from "./record.ts"

const T0 = Date.parse("2027-01-15T08:00:00.000Z")
const ROOT: Actor = { id: "ses_root", role: "root" }
const IMPORT: Actor = { id: "ergo-register", role: "import" }
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
  | { readonly _tag: "refused"; readonly setup: ReadonlyArray<Sent>; readonly sent: Sent; readonly names: string }
  | { readonly _tag: "redacted"; readonly setup: ReadonlyArray<Sent>; readonly sent: Sent }
  /** A literal column: no command decodes with any other value in it (its field is a literal in the command's schema). */
  | { readonly _tag: "literal"; readonly encoded: unknown }
  /** A column no code writes: it stays empty. */
  | { readonly _tag: "unwritten" }

const by = (command: Command, actor: Actor = ROOT): Sent => ({ command, actor })
const part = (id: string, fields: Partial<{ title: string; part: string }> = {}) => PartInput.make({ id, title: fields.title ?? `the ${id} part`, part: Option.fromUndefinedOr(fields.part) })
const add = (ids: ReadonlyArray<string>, fields: Partial<{ run: string; sourceRef: string; quote: string; plan: string; title: string; part: string; suggestOwner: string }> = {}) =>
  Command.cases.add.make({
    run: fields.run ?? DEFAULT_RUN,
    sourceKind: Option.isSome(Option.fromUndefinedOr(fields.quote)) ? "owner-answer" : "plan-part",
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

/** A role as a caller that bypassed the types would give it: any string, read back from JSON. */
const roleOf = (value: string): Actor["role"] => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any))(JSON.stringify(value))

const refused = (names: string, sent: Sent, setup: ReadonlyArray<Sent> = []): Driver => ({ _tag: "refused", setup, sent, names })
const redacted = (sent: Sent, setup: ReadonlyArray<Sent> = []): Driver => ({ _tag: "redacted", setup, sent })
const literal = (encoded: unknown): Driver => ({ _tag: "literal", encoded })
const OWNED = [by(add(["c1"]))]
/** An import's history event carries `at` (every derived time column is a fold of an event's time) and its states. */
const historyAt = refused("event.at", by(imported("i1", {}, { at: S }), IMPORT))

/** Each TEXT column's driver, by `<table>.<column>`. */
const DRIVERS: Readonly<Record<string, Driver>> = {
  "commitment.id": refused("event.subject_id", by(add([S]))),
  "commitment.run": refused("event.run", by(add(["c1"], { run: S }))),
  "commitment.title": redacted(by(add(["c1"], { title: `the title ${S}` }))),
  "commitment.source_kind": literal({ _tag: "add", run: "r", sourceKind: S, sourceRef: "x", parts: [] }),
  "commitment.source_ref": redacted(by(add(["c1"], { sourceRef: `plan.md ${S}` }))),
  "commitment.quote": redacted(by(add(["c1"], { quote: `the owner said ${S}` }))),
  "commitment.plan": redacted(by(add(["c1"], { plan: `the plan ${S}` }))),
  "commitment.part": redacted(by(add(["c1"], { part: `the part ${S}` }))),
  "commitment.rank": literal({ _tag: "add", run: "r", sourceKind: "plan-part", sourceRef: "x", parts: [{ id: "c1", title: "t", rank: S }] }),
  "commitment.owner_lane": refused("commitment.owner_lane", by(assign("c1", { ownerLane: S })), OWNED),
  "commitment.owner_session": refused("commitment.owner_session", by(assign("c1", { ownerSession: S })), OWNED),
  "commitment.state": literal({ _tag: "import", run: "r", rows: [{ id: "i1", row: { state: S }, history: [] }] }),
  "commitment.started_at": refused("commitment.started_at", by(imported("i1", { startedAt: S }), IMPORT)),
  "commitment.review_by": refused("commitment.review_by", by(imported("i1", { reviewBy: S }), IMPORT)),
  "commitment.woke_at": historyAt,
  "commitment.head": refused("commitment.head", by(imported("i1", { head: S }), IMPORT)),
  "commitment.request_path": redacted(by(imported("i1", { requestPath: `requests/${S}.md` }), IMPORT)),
  "commitment.landed_commit": refused("commitment.landed_commit", by(imported("i1", { state: "landed", landedCommit: S }), IMPORT)),
  "commitment.decided_why": redacted(by(Command.cases.decide.make({ id: "c1", why: `because ${S}` })), OWNED),
  "commitment.notice_until": historyAt,
  "commitment.created_at": refused("commitment.created_at", by(imported("i1", { createdAt: S }), IMPORT)),
  "commitment.updated_at": refused("commitment.updated_at", by(imported("i1", { updatedAt: S }), IMPORT)),
  "commitment.start_head": refused("commitment.start_head", by(Command.cases.lane.make({ run: DEFAULT_RUN, unit: "u1", startHead: Option.some(S) }))),
  "commitment.notice_by": refused("event.actor", by(add(["c1"]), { id: S, role: "root" })),
  "commitment.lane_path": refused("commitment.lane_path", by(Command.cases.lane.make({ run: DEFAULT_RUN, unit: "u1", path: Option.some(`/work/${S}`) }))),
  "prerequisite.commitment_id": refused("event.subject_id", by(add([S]))),
  "prerequisite.kind": literal({ _tag: "assign", id: "c1", ownerLane: "u1", after: [{ kind: S, ref: "x" }] }),
  "prerequisite.ref": refused("prerequisite.ref", by(assign("c1", { manual: S })), OWNED),
  "prerequisite.met_at": historyAt,
  "event.at": historyAt,
  "event.run": refused("event.run", by(Command.cases.word.make({ run: S, word: "go" }))),
  "event.subject_kind": literal({ _tag: "nothing", subjectKind: S }),
  "event.subject_id": refused("event.subject_id", by(Command.cases.word.make({ run: DEFAULT_RUN, word: S }))),
  "event.type": literal({ _tag: S }),
  "event.actor": refused("event.actor", by(imported("i1", {}, { actor: S }), IMPORT)),
  // A role is the caller's own (the tool's root, a worker, the import), never a field of a command: one that is no role is refused.
  "event.actor_role": refused("event.actor_role", by(add(["c1"]), { id: "ses_root", role: roleOf(S) })),
  "event.from_state": refused("event.from_state", by(imported("i1", {}, { from: S }), IMPORT)),
  "event.to_state": refused("event.to_state", by(imported("i1", {}, { to: S }), IMPORT)),
  "event.note": redacted(by(imported("i1", {}, { note: `filed ${S}` }), IMPORT)),
  "event.data": refused("suggest_owner", by(add(["c1"], { suggestOwner: S }))),
  "hand_back.run": refused("event.run", by(handBack({ run: S }))),
  "hand_back.owner_lane": refused("hand_back.owner_lane", by(handBack({ ownerLane: S }))),
  "hand_back.role": refused("hand_back.role", by(handBack({ role: S }))),
  "hand_back.session": refused("hand_back.session", by(handBack({ session: S }))),
  "hand_back.verdict": literal({ _tag: "hand_back", run: "r", ownerLane: "u1", role: "x", session: "s", verdict: S, claims: [] }),
  "hand_back.head": refused("hand_back.head", by(handBack({ head: S }))),
  "hand_back.file": redacted(by(handBack({ file: `requests/${S}.md` }))),
  "hand_back.at": historyAt,
  "hand_back.routing": literal({ _tag: "route", handBack: 1, as: S }),
  "hand_back.routed_at": historyAt,
  "hand_back.routed_by": refused("event.actor", by(Command.cases.route.make({ handBack: 1, as: "routed" }), { id: S, role: "root" }), [by(handBack())]),
  "lane_session.lane": { _tag: "unwritten" },
  "lane_session.session": { _tag: "unwritten" },
  "word.run": refused("event.run", by(Command.cases.word.make({ run: S, word: "go" }))),
  "word.word": refused("event.subject_id", by(Command.cases.word.make({ run: DEFAULT_RUN, word: S }))),
  "word.given_at": historyAt,
  "word.given_by": refused("event.actor", by(Command.cases.word.make({ run: DEFAULT_RUN, word: "go" }), { id: S, role: "root" })),
}

/** Every TEXT value of every table in the file, with its column. */
const storedIn = (path: string): ReadonlyArray<readonly [string, string]> => {
  const db = new Database(path, { readonly: true })
  const stored = textColumnsOf(db).flatMap((column) => {
    const [table, name] = column.split(".")
    return db.query<{ value: string }, []>(`SELECT coalesce(${name}, '') AS value FROM ${table}`).all().map((each) => [column, each.value] as const)
  })
  db.close()
  return stored
}

/** What the record did with the driver's secret command on a fresh file: refused (its reason), or kept. */
const drive = (path: string, driver: Extract<Driver, { readonly setup: unknown }>) =>
  Effect.gen(function* () {
    const opened = connectSync(path, { readonly: false, now: T0 })
    for (const each of driver.setup) yield* opened.store.run(each.command, { actor: each.actor, now: T0 })
    const done = yield* Effect.result(opened.store.run(driver.sent.command, { actor: driver.sent.actor, now: T0 }))
    opened.close()
    return Result.match(done, { onSuccess: () => Option.none<string>(), onFailure: (failed) => Option.some(failed._tag === "RecordRefused" ? failed.reason : failed.message) })
  })

Seed.effect(
  "a secret driven into each TEXT column is refused naming the column, or kept redacted; no column of any table holds it",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("record-boundary-")),
    (dir) =>
      Effect.gen(function* () {
        const schema = `${dir.path}/schema.db`
        connectSync(schema, { readonly: false, now: T0 }).close()
        const db = new Database(schema, { readonly: true })
        const columns = textColumnsOf(db)
        db.close()
        expect(columns.filter((column) => DRIVERS[column] === undefined)).toEqual([])
        const outcomes = yield* Effect.forEach(columns, (column, at) =>
          Effect.gen(function* () {
            const driver = DRIVERS[column] ?? { _tag: "unwritten" as const }
            const path = `${dir.path}/c${at}.db`
            if (driver._tag === "literal") return [column, Result.isFailure(decodeCommand(driver.encoded)) ? "literal" : "decoded"] as const
            if (driver._tag === "unwritten") return [column, "unwritten"] as const
            const why = yield* drive(path, driver)
            const leaked = storedIn(path).filter(([, value]) => value.includes(SECRET)).map(([held]) => held)
            const answer = Option.match(why, {
              onNone: () => (driver._tag === "redacted" && storedIn(path).some(([, value]) => value.includes("[redacted]")) ? "redacted" : "kept"),
              onSome: (reason) => (reason.includes(SECRET) ? "refused, repeating it" : reason.includes(`column ${driver._tag === "refused" ? driver.names : column} `) ? "refused" : `refused: ${reason}`),
            })
            return [column, leaked.length > 0 ? `leaked into ${leaked.join(", ")}` : answer] as const
          }),
        )
        const expected = columns.map((column) => {
          const driver = DRIVERS[column]
          return [column, driver?._tag === "refused" ? "refused" : (driver?._tag ?? "no driver")] as const
        })
        expect(outcomes).toEqual(expected)
      }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ),
)

Seed.effect(
  "a worker's follow_up with a secret as its id or run is refused whole, naming the column, and writes nothing",
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("record-boundary-")),
    (dir) =>
      Effect.gen(function* () {
        const path = `${dir.path}/repo.db`
        const opened = connectSync(path, { readonly: false, now: T0 })
        const worker: Actor = { id: "ses_worker", role: "worker" }
        const record = Effect.provideService(CommitmentRecord, opened.store)
        const byId = yield* Effect.flip(record(followUpOf({ id: S, title: "a missing test" }, worker, "call_1", T0)))
        const byRun = yield* Effect.flip(record(followUpOf({ id: "f1", title: "a missing test", run: S }, worker, "call_2", T0)))
        opened.close()
        expect([byId.includes("column event.subject_id "), byRun.includes("column event.run "), byId.includes(SECRET), byRun.includes(SECRET)]).toEqual([true, true, false, false])
        expect(storedIn(path).filter(([column]) => column.startsWith("commitment.") || column.startsWith("event."))).toEqual([])
      }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ),
)
