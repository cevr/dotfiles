// @reads all
// @reads-reason computed module resolver reads at mods/orchestrate/sqlite/record.test.ts: import { Effect, Exit } from "${resolveSync("effect", STORE)}"
// The SQLite record keeps the CommitmentRecord laws (laws.ts) on a scratch file, and what only a file does: two
// processes writing at once lose nothing, a file of a newer version reads and refuses writes, a read-only open reads,
// and the daily backup is written once a day with the newest seven kept.
import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { fileURLToPath, Glob, resolveSync, spawn, spawnSync, write } from "bun"
import { Array as Arr, Context, Effect, Layer, Match, Option, Result, type Scope } from "effect"
import { Digest } from "effect/crypto"
import * as Seed from "../../../sim/seed.ts"
import { hostServices } from "../../../sim/host-services.ts"
import { platform as ownPlatform } from "../node/platform.ts"
import { gitInit, withProcessEnv } from "../../../tests/git-repo.ts"
import { scratch as scratchDir } from "../../../tests/scratch.ts"
import { commitmentRecordLaws, RECORD_SCRIPT } from "../laws.ts"
import * as MemoryRecord from "../memory/record.ts"
import { type Actor, COLUMNS, Command, EMPTY, fold, type StoredEvent } from "../record.ts"
import { CommitmentRecord } from "../service.ts"
import type * as SqliteRecord from "./record.ts"
import { BACKUPS_KEPT, connected, keyOfCheckout, layer, layerOrFailed, MIGRATIONS, pathOf, stateDir, textColumnsOf, VERSION } from "./record.ts"

const T0 = 1_800_000_000_000
/** The host's files, paths and processes (the fork gives a plugin these), and the plugin's own digest. */
const platform = Layer.mergeAll(hostServices, ownPlatform)

const DAY = 86_400_000

const scratch = Effect.map(
  Effect.acquireRelease(
    Effect.sync(() => scratchDir("record-store-")),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  ),
  (dir) => dir.path,
)

commitmentRecordLaws(
  "the SQLite record",
  Effect.map(scratch, (dir) => Layer.orDie(layer(`${dir}/state/repo.db`, { readonly: false, now: T0 })).pipe(Layer.provide(platform))),
)

/** A body over a scratch directory, removed after. */
const inScratch = <A, E>(body: (dir: string) => Effect.Effect<A, E, SqliteRecord.Platform | Scope.Scope>) => Effect.scoped(Effect.flatMap(scratch, body)).pipe(Effect.provide(platform))

const add = (id: string) => Command.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "plan.md:1", parts: [{ id, title: `part ${id}` }] })
const ROOT: Actor = { id: "ses_root", role: "root" }
/** This folder's store module, as a writer process imports it. */
const STORE = fileURLToPath(import.meta.resolve("./record.ts"))
/** The host services the writer provides its open, as the fork's plugin host would. */
const HOST = fileURLToPath(import.meta.resolve("../../../sim/host-services.ts"))

Seed.effect(
  "the file is under XDG_STATE_HOME, else ~/.local/state",
  Effect.gen(function* () {
    expect(yield* pathOf(Option.some("/state"), "github.com-cevr-dotfiles")).toBe("/state/opencode-orchestrate/github.com-cevr-dotfiles.db")
    expect(yield* stateDir(Option.some(""))).toEndWith("/.local/state/opencode-orchestrate")
    expect(yield* stateDir(Option.none())).toEndWith("/.local/state/opencode-orchestrate")
  }).pipe(Effect.provide(platform)),
)

/**
 * A writer process: opens its own connection, declares the invariant (the second writer's declaration is the same, so
 * nothing), and adds `count` commitments named `<name>-<i>`, one transaction each; each odd one deferred on the one
 * before (a dependency), and every tenth decides the one before it on the invariant (a guarantee).
 */
const writer = `import { connected } from "${STORE}"
import { hostServices } from "${HOST}"
import { Command } from "${STORE.replace(/sqlite\/record\.ts$/, "record.ts")}"
import { Effect, Exit } from "${resolveSync("effect", STORE)}"
const [path, name, count] = process.argv.slice(2)
const opened = await Effect.runPromise(connected(path, { readonly: false, now: ${T0} }).pipe(Effect.provide(hostServices)))
const run = (command, at) => {
  const exit = Effect.runSyncExit(opened.store.run(command, { actor: { id: name, role: "root" }, now: ${T0} + at }))
  if (Exit.isFailure(exit)) { console.error(String(exit.cause)); process.exit(1) }
}
run(Command.cases.invariant.make({ id: "one-writer", anchor: "one-writer", observed: { path: "docs/record.md", blob: "b".repeat(40), commit: "c".repeat(40) } }), 0)
for (let at = 0; at < Number(count); at++) {
  run(Command.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "plan.md:1", parts: [{ id: name + "-" + at, title: "part" }] }), at)
  if (at % 2 === 1) run(Command.cases.defer.make({ id: name + "-" + at, reason: { reasonClass: "dependency", referent: "commitment/" + name + "-" + (at - 1) } }), at)
  if (at % 10 === 9) run(Command.cases.decide.make({ id: name + "-" + (at - 1), why: "covered", reason: { reasonClass: "guarantee", referent: "invariant/one-writer" } }), at)
}
opened.close()
`

/** A writer process on the file at `path`, adding 100 commitments as `name`. */
const started = (script: string, path: string, name: string) => spawn(["bun", script, path, name, "100"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })

/** A process's exit code and what it wrote to stderr. */
const ended = (run: ReturnType<typeof started>) =>
  Effect.all({ code: Effect.promise(() => run.exited), errors: Effect.promise(() => new Response(run.stderr).text()) }, { concurrency: 2 })

Seed.effect("two processes writing 321 interleaved commands to one file, reasons included, lose none, and the replay law holds after",
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/repo.db`
      const script = `${dir}/writer.ts`
      yield* Effect.promise(() => write(script, writer))
      const runs = ["one", "two"].map((name) => started(script, path, name))
      const outcomes = yield* Effect.forEach(runs, ended, { concurrency: 2 })
      expect(outcomes).toEqual([
        { code: 0, errors: "" },
        { code: 0, errors: "" },
      ])
      const opened = yield* connected(path, { readonly: true, now: T0 })
      const snapshot = yield* opened.store.read
      const events = yield* opened.store.events
      opened.close()
      expect(snapshot.commitments.size).toBe(200)
      // 200 adds, 100 deferrals, 20 decisions and one declaration: the second writer's was the same, so nothing.
      expect(events.length).toBe(321)
      expect([...snapshot.commitments.values()].filter((row) => row.state === "decided" && Option.contains(Option.map(row.reason, (reason) => reason.reasonClass), "guarantee")).length).toBe(20)
      expect([...snapshot.commitments.values()].filter((row) => row.state === "open" && Option.isSome(row.reason)).length).toBe(100)
      expect(fold(EMPTY, events)).toEqual(snapshot)
    }),
  ))

Seed.effect("a file of a newer version than this code reads, and refuses every write with the version it needs",
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/repo.db`
      const first = yield* connected(path, { readonly: false, now: T0 })
      yield* first.store.run(add("kept-1"), { actor: ROOT, now: T0 })
      first.close()
      const raw = new Database(path)
      raw.run(`PRAGMA user_version = ${VERSION + 1}`)
      raw.close()
      const newer = yield* connected(path, { readonly: false, now: T0 })
      const refused = yield* Effect.flip(newer.store.run(add("kept-2"), { actor: ROOT, now: T0 }))
      expect(refused._tag).toBe("RecordFailed")
      expect(refused.message).toContain(`version ${VERSION + 1}; this code writes version ${VERSION}`)
      expect([...(yield* newer.store.read).commitments.keys()]).toEqual(["kept-1"])
      newer.close()
    }),
  ))

/** A table's columns as `PRAGMA table_xinfo` gives them: name, type, NOT NULL, default ("-" for none), primary key, hidden (2: generated). */
const columnsOf = (db: Database, table: string) =>
  db
    .query<{ name: string; type: string; notnull: number; dflt: string; pk: number; hidden: number }, []>(`SELECT name, type, "notnull", coalesce(dflt_value, '-') AS dflt, pk, hidden FROM pragma_table_xinfo('${table}')`)
    .all()
    .map((each) => [each.name, each.type, each.notnull, each.dflt, each.pk, each.hidden])

Seed.effect("version 2 preserves the commitment and invariant columns, reason pair and generated close kind",
  inScratch((dir) =>
    Effect.gen(function* () {
      const made = yield* connected(`${dir}/repo.db`, { readonly: false, now: T0 })
      made.close()
      const db = new Database(`${dir}/repo.db`, { readonly: true })
      const tables = {
        version: Option.map(Option.fromNullishOr(db.query<{ user_version: number }, []>("PRAGMA user_version").get()), (each) => each.user_version),
        commitment: columnsOf(db, "commitment"),
        invariant: columnsOf(db, "invariant"),
      }
      const visible = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('commitment')").all().map((each) => each.name)
      db.close()
      const text = (name: string, notnull = 0, pk = 0) => [name, "TEXT", notnull, "-", pk, 0]
      expect([VERSION, MIGRATIONS.length]).toEqual([2, 2])
      expect(tables).toEqual({
        version: Option.some(2),
        commitment: [
          text("id", 1, 1), text("run", 1), text("title", 1), text("source_kind", 1), text("source_ref", 1), text("quote"), text("plan"), text("part"), text("rank"),
          text("owner_lane"), text("owner_session"), text("state", 1), text("started_at"), text("review_by"), text("woke_at"), text("head"), text("request_path"),
          text("landed_commit"), text("decided_why"), text("notice_until"), text("created_at", 1), text("updated_at", 1), text("start_head"), text("notice_by"),
          ["notice_outside_run", "INTEGER", 1, "0", 0, 0], text("lane_path"), text("reason_class"), text("referent"), text("unreasoned_close"),
          ["close_kind", "TEXT", 0, "-", 0, 2],
        ],
        invariant: [text("id", 1, 1), text("doc_path", 1), text("anchor", 1), text("blob", 1), text("commit_sha", 1), text("declared_at", 1), text("declared_by", 1)],
      })
      // The brief's two columns at `PRAGMA table_info`; the derived kind is generated, hidden there.
      expect(visible.slice(-3)).toEqual(["reason_class", "referent", "unreasoned_close"])
    }),
  ))

/** One row's reason fields, as a direct INSERT or UPDATE sets them. */
interface Cell {
  readonly state: "open" | "landed" | "decided"
  /** Each column's value, none for SQL NULL. */
  readonly reasonClass: Option.Option<string>
  readonly referent: Option.Option<string>
  readonly unreasoned: Option.Option<string>
}
/** A column's values: NULL, then each of `values`. */
const orNull = (values: ReadonlyArray<string>): ReadonlyArray<Option.Option<string>> => [Option.none(), ...values.map(Option.some)]
const STATES_ = ["open", "landed", "decided"] as const
const CLASSES_ = orNull(["guarantee", "dependency", "measured", "effort"])
const REFERENTS_ = orNull(["", " invariant/x", "invariant/root-owns", "commitment/a", "ask/", "ask/q1", "r".repeat(513)])
const UNREASONED_ = orNull(["placed", "historical", "guessed"])
const MATRIX: ReadonlyArray<Cell> = STATES_.flatMap((state) =>
  CLASSES_.flatMap((reasonClass) => REFERENTS_.flatMap((referent) => UNREASONED_.map((unreasoned) => ({ state, reasonClass, referent, unreasoned })))),
)
/** A blank row of `state`: no reason, no unreasoned close. */
const blank = (state: Cell["state"]): Cell => ({ state, reasonClass: Option.none(), referent: Option.none(), unreasoned: Option.none() })

/** Whether a column's value, when it has one, passes `check`. */
const nullOr = (value: Option.Option<string>, check: (each: string) => boolean) => Option.match(value, { onNone: () => true, onSome: check })
/** The kind a reasoned pair names: a guarantee with its referent, or no class with an `ask/<id>`; none for any other. */
const pairedOf = ({ reasonClass, referent }: Cell): Option.Option<string> => {
  if (Option.contains(reasonClass, "guarantee") && Option.isSome(referent)) return Option.some("guarantee")
  if (Option.isNone(reasonClass) && Option.exists(referent, (each) => each.startsWith("ask/") && each.length > 4)) return Option.some("not-asked")
  return Option.none()
}
/** An unreasoned close names the kind of a null pair alone; a reasoned pair names its own kind and no unreasoned close. */
const kindOf = (cell: Cell): Option.Option<string> => {
  if (Option.isNone(cell.reasonClass) && Option.isNone(cell.referent)) return cell.unreasoned
  if (Option.isNone(cell.unreasoned)) return pairedOf(cell)
  return Option.none()
}

/**
 * The oracle, the owner's rule in one line: a decided row has exactly one close kind and no other row has one, each
 * kind bound to its pair (guarantee ⇔ a guarantee with its referent; not-asked ⇔ no class and an `ask/<id>`; placed and
 * historical ⇔ the null pair), and every row's pair is well-formed (both or neither, a known class, a trimmed referent of
 * 1 to 512 characters). Answers the row's kind ("none" for an open or landed row), or "refused".
 */
const oracle = (cell: Cell): string => {
  const formed =
    nullOr(cell.reasonClass, (each) => ["guarantee", "dependency", "measured"].includes(each)) &&
    nullOr(cell.referent, (each) => each.length >= 1 && each.length <= 512 && each.trim() === each) &&
    nullOr(cell.unreasoned, (each) => each === "placed" || each === "historical")
  if (!formed) return "refused"
  if (cell.state === "decided") return Option.getOrElse(kindOf(cell), () => "refused")
  if (Option.isNone(cell.unreasoned) && Option.isNone(cell.reasonClass) === Option.isNone(cell.referent)) return "none"
  return "refused"
}

const INSERT_CELL = `INSERT INTO commitment (id, run, title, source_kind, source_ref, state, landed_commit, decided_why, reason_class, referent, unreasoned_close, created_at, updated_at)
  VALUES (?, 'r1', 't', 'plan-part', 'p', ?, ?, ?, ?, ?, ?, 't', 't')`
const UPDATE_CELL = "UPDATE commitment SET state = ?, landed_commit = ?, decided_why = ?, reason_class = ?, referent = ?, unreasoned_close = ? WHERE id = ?"
/** `value` when `holds`, else SQL NULL. */
const sqlIf = (holds: boolean, value: string) => Option.getOrNull(Option.liftPredicate(value, () => holds))
const bindings = (cell: Cell) =>
  [cell.state, sqlIf(cell.state === "landed", "1234567"), sqlIf(cell.state === "decided", "why"), Option.getOrNull(cell.reasonClass), Option.getOrNull(cell.referent), Option.getOrNull(cell.unreasoned)] as const
/** What the file did with `put`: the row's stored close kind ("none" for none), or "refused" when a CHECK refused it. */
const outcome = (db: Database, id: string, put: () => void): string => {
  if (Result.isFailure(Result.try(put))) return "refused"
  const stored = Option.fromNullishOr(db.query<{ kind: string }, [string]>("SELECT coalesce(close_kind, 'none') AS kind FROM commitment WHERE id = ?").get(id))
  return Option.getOrElse(Option.map(stored, (each) => each.kind), () => "no row")
}

Seed.effect(`the close kind over (state × reason class × referent form × unreasoned close), ${MATRIX.length} cells, by direct INSERT and UPDATE on a scratch file, agrees with the one-line oracle`,
  inScratch((dir) =>
    Effect.gen(function* () {
      const made = yield* connected(`${dir}/matrix.db`, { readonly: false, now: T0 })
      made.close()
      const db = new Database(`${dir}/matrix.db`, { strict: true })
      const inserted = MATRIX.map((cell, at) => outcome(db, `i${at}`, () => db.run(INSERT_CELL, [`i${at}`, ...bindings(cell)])))
      // Each UPDATE starts from a valid row of its own (an open row with no reason) and moves it to the cell.
      const updated = MATRIX.map((cell, at) => {
        db.run(INSERT_CELL, [`u${at}`, ...bindings(blank("open"))])
        return outcome(db, `u${at}`, () => db.run(UPDATE_CELL, [...bindings(cell), `u${at}`]))
      })
      // A decided row cannot be moved off its kind: back to open with its unreasoned close, or to no kind at all.
      db.run(INSERT_CELL, ["h", ...bindings({ ...blank("decided"), unreasoned: Option.some("historical") })])
      const reopenedKeepingClose = outcome(db, "h", () => db.run("UPDATE commitment SET state = 'open', decided_why = NULL WHERE id = 'h'"))
      const writtenKind = outcome(db, "h", () => db.run("UPDATE commitment SET close_kind = 'guarantee' WHERE id = 'h'"))
      db.close()
      const expected = MATRIX.map(oracle)
      expect(inserted).toEqual(expected)
      expect(updated).toEqual(expected)
      expect([reopenedKeepingClose, writtenKind]).toEqual(["refused", "refused"])
      // Every kind is reachable, and each only from its pair.
      expect([...new Set(expected)].toSorted()).toEqual(["guarantee", "historical", "not-asked", "placed", "refused", "none"].toSorted())
    }),
  ))

Seed.effect("which close kind each writer makes: decide a guarantee, the plugin's placeholder close placed, an import historical; open and landed rows none",
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/writers.db`
      const opened = yield* connected(path, { readonly: false, now: T0 })
      const run = (command: Command, actor: Actor = ROOT) => opened.store.run(command, { actor, now: T0 })
      yield* run(Command.cases.invariant.make({ id: "one-writer", anchor: "one-writer", observed: { path: "docs/record.md", blob: "b".repeat(40), commit: "c".repeat(40) } }))
      yield* run(add("by-decide"))
      yield* run(Command.cases.decide.make({ id: "by-decide", why: "covered", reason: { reasonClass: "guarantee", referent: "invariant/one-writer" } }))
      yield* run(Command.cases.add.make({ run: "r1", sourceKind: "owner-answer", sourceRef: "ses_root:q1", parts: [{ id: "placeholder", title: "their answer" }] }))
      yield* run(Command.cases.add.make({ run: "r1", sourceKind: "plan-part", sourceRef: "plan.md:2", plan: Option.some("placeholder"), parts: [{ id: "split-a", title: "a part" }] }))
      const row = (id: string, state: "open" | "decided") => ({
        id,
        row: {
          title: `row ${id}`, sourceKind: "plan-part" as const, sourceRef: "register", quote: Option.none(), plan: Option.none(), part: Option.none(), rank: Option.none(),
          ownerLane: Option.none(), ownerSession: Option.none(), state, startedAt: Option.none(), reviewBy: Option.none(), head: Option.none(), requestPath: Option.none(),
          landedCommit: Option.none(), decidedWhy: Option.liftPredicate("dropped", () => state === "decided"), createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", after: [],
        },
        history: [],
      })
      yield* run(Command.cases.import.make({ run: "wf1", rows: [row("by-import", "decided"), row("by-import-open", "open")] }), { id: "ergo-register", role: "import" })
      opened.close()
      const db = new Database(path, { readonly: true })
      const kinds = db.query<{ id: string; close_kind: string; actor_role: string }, []>(
        "SELECT c.id, coalesce(c.close_kind, 'none') AS close_kind, coalesce((SELECT e.actor_role FROM event e WHERE e.subject_id = c.id AND e.to_state = 'decided'), 'none') AS actor_role FROM commitment c ORDER BY c.id",
      ).all()
      db.close()
      expect(kinds).toEqual([
        { id: "by-decide", close_kind: "guarantee", actor_role: "root" },
        { id: "by-import", close_kind: "historical", actor_role: "import" },
        { id: "by-import-open", close_kind: "none", actor_role: "none" },
        { id: "placeholder", close_kind: "placed", actor_role: "plugin" },
        { id: "split-a", close_kind: "none", actor_role: "none" },
      ])
    }),
  ))

/** Whether two writes that both took wrote as many events; true when either refused. */
const sameCount = <E1, E2>(one: Result.Result<{ readonly events: ReadonlyArray<unknown> }, E1>, other: Result.Result<{ readonly events: ReadonlyArray<unknown> }, E2>): boolean => {
  if (Result.isSuccess(one) && Result.isSuccess(other)) return one.success.events.length === other.success.events.length
  return true
}

Seed.effect("the file and the memory record agree on every kind of command, reasons included; reopened, the file's rows are its events' fold; an import again is nothing",
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/agree.db`
      const file = yield* connected(path, { readonly: false, now: T0 })
      const memory = MemoryRecord.make(yield* MemoryRecord.empty)
      const both = (command: Command, actor: Actor, now: number) =>
        Effect.all([Effect.result(file.store.run(command, { actor, now })), Effect.result(memory.run(command, { actor, now }))]).pipe(
          Effect.map(([inFile, inMemory]) => [inFile._tag, inMemory._tag, sameCount(inFile, inMemory)]),
        )
      const outcomes = yield* Effect.forEach(RECORD_SCRIPT, ([command, actor, now]) => both(command, actor, now))
      expect(outcomes).toEqual(RECORD_SCRIPT.map(() => ["Success", "Success", true]))
      const imported = Arr.findLast(RECORD_SCRIPT, ([command]) => command._tag === "import")
      const again = yield* Effect.forEach(Option.toArray(imported), ([command, actor, now]) => Effect.all([file.store.run(command, { actor, now: now + 1 }), memory.run(command, { actor, now: now + 1 })]))
      expect(again.map(([inFile, inMemory]) => [inFile.events.length, inMemory.events.length])).toEqual([[0, 0]])
      file.close()
      const reopened = yield* connected(path, { readonly: true, now: T0 })
      const [rows, events] = [yield* reopened.store.read, yield* reopened.store.events]
      reopened.close()
      const { filings: diskFilings, ...diskRows } = rows
      const { filings: memoryFilings, ...memoryRows } = yield* memory.read
      expect(diskRows).toEqual(memoryRows)
      const identities = (filings: typeof diskFilings) => [...filings].map(([id, each]) => [id, each.actor, Option.isSome(each.identity)])
      expect(identities(diskFilings)).toEqual(identities(memoryFilings))
      const withoutMac = (each: StoredEvent): StoredEvent => {
        const happening = each.happening
        if (happening._tag !== "promised") return each
        return { ...each, happening: { ...happening, filing: Option.none() } }
      }
      expect(events.map(withoutMac)).toEqual((yield* memory.events).map(withoutMac))
      expect(fold(EMPTY, events)).toEqual(rows)
      // The reasons the script gave survive the file: a decided guarantee, a deferral's dependency, a reopen's clear.
      expect([...rows.commitments.values()].map((row) => [row.id, row.state, Option.map(row.reason, (reason) => reason.referent), row.unreasonedClose])).toEqual(
        [...(yield* memory.read).commitments.values()].map((row) => [row.id, row.state, Option.map(row.reason, (reason) => reason.referent), row.unreasonedClose]),
      )
    }),
  ))

Seed.effect("a not-asked row (unit C's) is a legal row this code does not read: its read and every write fail whole, naming the row, never guessing",
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/c.db`
      const made = yield* connected(path, { readonly: false, now: T0 })
      yield* made.store.run(add("kept"), { actor: ROOT, now: T0 })
      made.close()
      const raw = new Database(path, { strict: true })
      raw.run(INSERT_CELL, ["asked", ...bindings({ ...blank("decided"), referent: Option.some("ask/q1") })])
      raw.close()
      const opened = yield* connected(path, { readonly: false, now: T0 })
      const read = yield* Effect.flip(opened.store.read)
      const write = yield* Effect.flip(opened.store.run(add("more"), { actor: ROOT, now: T0 }))
      opened.close()
      expect<ReadonlyArray<string>>([read.message, Match.value(write).pipe(Match.tag("RecordFailed", (failed) => failed.message), Match.orElse((refused) => refused.reason))]).toEqual([
        "record read: commitment asked: its reason is not one this code reads (a class and a canonical referent)",
        "record add: commitment asked: its reason is not one this code reads (a class and a canonical referent)",
      ])
    }),
  ))

Seed.effect("a read-only open reads what a writer wrote and refuses writes; a reopened store sees the same rows",
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/repo.db`
      const writing = yield* connected(path, { readonly: false, now: T0 })
      yield* writing.store.run(add("ro-1"), { actor: ROOT, now: T0 })
      const reading = yield* connected(path, { readonly: true, now: T0 })
      expect([...(yield* reading.store.read).commitments.keys()]).toEqual(["ro-1"])
      const refused = yield* Effect.flip(reading.store.run(add("ro-2"), { actor: ROOT, now: T0 }))
      expect(refused._tag).toBe("RecordFailed")
      reading.close()
      writing.close()
      const again = yield* connected(path, { readonly: false, now: T0 })
      expect([...(yield* again.store.read).commitments.keys()]).toEqual(["ro-1"])
      again.close()
    }),
  ))

Seed.effect("the daily backup is written at a day's first open only, and the eighth day's prunes the oldest",
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/repo.db`
      const days = Array.from({ length: BACKUPS_KEPT + 1 }, (_, at) => T0 + at * DAY)
      for (const now of days) {
        const opened = yield* connected(path, { readonly: false, now })
        yield* opened.store.run(add(`day-${now}`), { actor: ROOT, now })
        opened.close()
        const later = yield* connected(path, { readonly: false, now: now + 1_000 })
        later.close()
      }
      const kept = Array.from(new Glob("*").scanSync(`${dir}/backup`)).toSorted()
      expect(kept).toHaveLength(BACKUPS_KEPT)
      expect([kept.at(0), kept.at(-1)]).toEqual(["repo-2027-01-16.db", "repo-2027-01-22.db"])
      // Each backup is a whole database: the last holds every row written before its day's first open.
      const last = new Database(`${dir}/backup/repo-2027-01-22.db`, { readonly: true })
      expect(last.query("SELECT count(*) AS n FROM commitment").get()).toEqual({ n: BACKUPS_KEPT })
      last.close()
    }),
  ))

Seed.effect("a repository with no origin: its workspace, a subfolder and the base share one key; another repository has its own",
  inScratch((dir) =>
    Effect.gen(function* () {
      const env = withProcessEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" })
      const init = (path: string) =>
        Effect.map(Effect.promise(() => write(`${path}/sub/f`, path)), () => {
          gitInit(path, ["-q", "-b", "main"], env)
          for (const args of [["add", "-A"], ["commit", "-q", "-m", "root"]]) spawnSync(["git", "-C", path, ...args], { env, stdout: "ignore", stderr: "ignore" })
        })
      const base = `${dir}/repo`
      yield* init(base)
      // A workspace as `work` makes one: a copy of the base, laid out beside it.
      const workspace = `${dir}/.work/repo/lane-1`
      expect([spawnSync(["mkdir", "-p", `${dir}/.work/repo`]).exitCode, spawnSync(["cp", "-R", base, workspace]).exitCode]).toEqual([0, 0])
      const other = `${dir}/other`
      yield* init(other)
      const keys = yield* Effect.forEach([base, `${base}/sub`, workspace, `${workspace}/sub`], keyOfCheckout)
      expect(new Set(keys).size).toBe(1)
      expect(keys[0]).toStartWith("local-")
      expect(yield* keyOfCheckout(other)).not.toBe(keys[0])
    }),
  ))

Seed.effect("the boundary's column map names exactly the file's TEXT columns: a new column fails here until it is given a kind",
  inScratch((dir) =>
    Effect.gen(function* () {
      const made = yield* connected(`${dir}/repo.db`, { readonly: false, now: T0 })
      made.close()
      const db = new Database(`${dir}/repo.db`, { readonly: true })
      const columns = textColumnsOf(db)
      db.close()
      expect(columns.toSorted()).toEqual(Object.keys(COLUMNS).toSorted())
    }),
  ))

Seed.effect("a free-text field past its bound is refused whole, naming the column",
  inScratch((dir) =>
    Effect.gen(function* () {
      const opened = yield* connected(`${dir}/repo.db`, { readonly: false, now: T0 })
      const long = yield* Effect.flip(opened.store.run(Command.cases.add.make({ run: "r1", sourceKind: "follow-up", sourceRef: "x", plan: Option.some("p".repeat(2_000_000)), parts: [{ id: "s3", title: "t" }] }), { actor: ROOT, now: T0 }))
      const events = yield* opened.store.events
      opened.close()
      expect([long, events.length]).toMatchObject([{ reason: "column commitment.plan is 2000000 characters, more than 200" }, 0])
    }),
  ))

Seed.effect(
  "the repository key's digest is SHA-256 (a known vector), so a file named before this code keeps its name",
  Effect.gen(function* () {
    const digest = yield* Digest.Digest
    expect(yield* digest.digestHex(Digest.sha256, new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  }).pipe(Effect.provide(platform)),
)

Seed.effect(
  "the plugin's record (layerOrFailed on the platform) makes its folder, opens, writes and keeps the day's backup; a file it cannot open refuses every call",
  inScratch((dir) =>
    Effect.gen(function* () {
      const path = `${dir}/state/deep/repo.db`
      const live = Context.get(yield* Layer.build(layerOrFailed(Effect.succeed(path))), CommitmentRecord)
      const done = yield* live.run(add("live-1"), { actor: ROOT, now: T0 })
      expect([...done.snapshot.commitments.keys()]).toEqual(["live-1"])
      expect(Array.from(new Glob("*").scanSync(`${dir}/state/deep/backup`))).toHaveLength(1)
      // Under a file, no folder can be made: the record refuses every call, naming why, and the plugin still starts.
      const dead = Context.get(yield* Layer.build(layerOrFailed(Effect.succeed("/dev/null/loop-probe-x/repo.db"))), CommitmentRecord)
      const failed = yield* Effect.flip(dead.read)
      expect(failed._tag).toBe("RecordFailed")
    }),
  ))
