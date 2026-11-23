// One committed event precedes every folded write. The two fences are exercised separately: a stale
// application connection must give the typed version refusal, and an unguarded SQL writer must still fail.
import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { Effect, Layer, Option, Result } from "effect"
import { hostServices } from "../../../sim/host-services.ts"
import * as Seed from "../../../sim/seed.ts"
import { scratch } from "../../../tests/scratch.ts"
import { RECORD_SCRIPT } from "../laws.ts"
import { platform } from "../node/platform.ts"
import { Command } from "../record.ts"
import { connected, MIGRATIONS, reattached, VERSION } from "./record.ts"

const NOW = 1_800_000_000_000
const ROOT = { id: "root", role: "root" } as const
const WORKER = { id: "worker", role: "worker" } as const
const followUp = (id: string) => Command.cases.add.make({
  sourceKind: "follow-up", sourceRef: `worker:${id}`, run: "one",
  parts: [{ id, title: "a pending follow-up" }],
  reason: Option.some({ reasonClass: "dependency", referent: "commitment/base" }),
})
const fixture = Command.cases.add.make({ sourceKind: "plan-part", sourceRef: "p:1", run: "one", parts: [{ id: "base", title: "pending" }] })
const services = Layer.merge(hostServices, platform)

const oldEvent = (db: Database) => db.query(
  "INSERT INTO event (at,run,subject_kind,subject_id,type,actor,actor_role,to_state,data) VALUES ('2026-11-01T09:00:00.000Z','one','commitment','legacy','promised','other','worker','open',?)",
)
const unsigned = '{"_tag":"promised","title":"old","sourceKind":"follow-up","sourceRef":"other:old"}'
const oldNonPromise = (db: Database) => db.query(
  "INSERT INTO event (at,run,subject_kind,subject_id,type,actor,actor_role,data) VALUES ('2026-11-01T09:00:00.000Z','one','word','old-word','word_given','root','root','{\"_tag\":\"word_given\"}')",
)
const newPromise = (db: Database) => db.query(
  "INSERT INTO event (at,run,subject_kind,subject_id,type,actor,actor_role,to_state,data,writer_version) VALUES ('2026-11-01T09:00:00.000Z','one','commitment','bad','promised','worker','worker','open',?,?)",
)
const versionedWord = (db: Database, version: number) =>
  db.query("INSERT INTO event (at,run,subject_kind,subject_id,type,actor,actor_role,data,writer_version) VALUES ('2026-11-01T09:00:00.000Z','one','word','new-word','word_given','root','root','{\"_tag\":\"word_given\"}',?)").run(version)
const format = (db: Database) => db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
const setFormat = (db: Database, version: number) => db.run(`PRAGMA user_version = ${version}`)

Seed.effect("old INSERTs cannot enter the migrated event log, regardless of when their connection opened", Effect.gen(function* () {
  using dir = scratch("record-release-fence-")
  for (const order of ["old/migrate/new", "migrate/old/new", "migrate/new/old"]) {
    const path = `${dir.path}/${order.replaceAll("/", "-")}.db`
    {
      using db = new Database(path)
      db.transaction(() => {
        for (const ddl of MIGRATIONS[0]) db.run(ddl)
        setFormat(db, 1)
        oldEvent(db).run(unsigned)
      }).immediate()
    }
    const openOld = () => new Database(path)
    const before = Option.liftPredicate(order, (each) => each.startsWith("old"))
    using held = Option.getOrUndefined(Option.map(before, openOld))
    const upgraded = yield* connected(path, { readonly: false, now: NOW })
    using middle = Option.getOrUndefined(Option.map(Option.liftPredicate(order, (each) => each === "migrate/old/new"), openOld))
    const fill = (id: string) => upgraded.store.run(followUp(id), { actor: WORKER, now: NOW })
    yield* upgraded.store.run(fixture, { actor: ROOT, now: NOW })
    if (order === "migrate/new/old") yield* fill("new-first")
    using fresh = Option.getOrUndefined(Option.map(Option.liftPredicate(order, (each) => each === "migrate/new/old"), openOld))
    const stale = Option.getOrThrow(Option.orElse(Option.fromUndefinedOr(held), () => Option.orElse(Option.fromUndefinedOr(middle), () => Option.fromUndefinedOr(fresh))))
    expect(format(stale)).toBe(VERSION)
    const snapshot = yield* upgraded.store.read
    const history = yield* upgraded.store.events
    expect(history.filter((event) => event.subjectId === "legacy")).toHaveLength(1)
    expect(() => oldEvent(stale).run(unsigned)).toThrow("event writer format")
    expect(() => oldNonPromise(stale).run()).toThrow("event writer format")
    expect(() => newPromise(stale).run(unsigned, VERSION)).toThrow("promise needs its filing identity")
    expect(yield* upgraded.store.read).toEqual(snapshot)
    expect(yield* upgraded.store.events).toEqual(history)
    expect((yield* fill("new-last")).events).toHaveLength(1)
    upgraded.close()
  }
}).pipe(Effect.provide(services)))

Seed.effect("every writing command reads the file version inside its transaction, across both open orders", Effect.gen(function* () {
  using dir = scratch("record-future-fence-")
  expect<ReadonlyArray<string>>([...new Set(RECORD_SCRIPT.map(([command]) => command._tag))].sort()).toEqual(Object.keys(Command.cases).sort())
  for (const order of ["older first", "newer first"]) {
    const path = `${dir.path}/${order}.db`
    const current = yield* connected(path, { readonly: false, now: NOW })
    for (const [command, actor, now] of RECORD_SCRIPT) {
      const result = yield* current.store.run(command, { actor, now })
      expect(result.events.length).toBeGreaterThan(0)
    }
    current.close()
    const held = reattached(path)
    using successor = new Database(path)
    // A future additive migration. It changes only the version, in a locked transaction, so a test detects
    // an application that relies on the version read at connection open instead of its own locked read.
    successor.transaction(() => {
      expect(format(successor)).toBe(VERSION)
      setFormat(successor, VERSION + 1)
    }).immediate()
    if (order === "newer first") versionedWord(successor, VERSION + 1)
    const fresh = reattached(path)
    const stale = Option.getOrElse(Option.liftPredicate(held, () => order === "older first"), () => fresh)
    const history = yield* stale.store.events
    const snapshot = yield* stale.store.read
    for (const [command, actor, now] of RECORD_SCRIPT) {
      const outcome = yield* Effect.result(stale.store.run(command, { actor, now }))
      expect(Result.isFailure(outcome) && outcome.failure._tag === "RecordFailed").toBe(true)
      if (Result.isFailure(outcome)) expect(outcome.failure.message).toContain(`version ${VERSION + 1}; this code writes version ${VERSION}`)
      expect(yield* stale.store.events).toEqual(history)
      expect(yield* stale.store.read).toEqual(snapshot)
    }
    versionedWord(successor, VERSION + 1)
    expect((yield* stale.store.events).length).toBe(history.length + 1)
    fresh.close()
    held.close()
  }
}).pipe(Effect.provide(services)))
