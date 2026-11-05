// What every implementation of a contract in service.ts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, type Scope } from "effect"
import { AgentCalled, AgentReturned, type Event } from "./agent-calls.ts"
import type { RunTable } from "./run-table.ts"
import { CallLog, RunTables } from "./service.ts"

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

// ── CallLog ──

/** A call log under test: its Layer, a way to record events as its writer does, and a way to make it unreadable. */
export interface CallLogProbe {
  readonly layer: Layer.Layer<CallLog>
  readonly record: (events: ReadonlyArray<Event>) => Effect.Effect<void>
  readonly spoil: Effect.Effect<void>
}

const recorded: ReadonlyArray<Event> = [
  AgentCalled.make({ sessionID: "ses_law", callID: "call-1", agent: "worker", description: "law", child: "ses_child" }),
  AgentReturned.make({ sessionID: "ses_law", callID: "call-1", child: "ses_child", status: "running" }),
  AgentCalled.make({ sessionID: "ses_law", callID: "call-2", agent: "planner" }),
  AgentReturned.make({ sessionID: "ses_law", callID: "call-2" }),
]

/** `make` gives a call log with nothing recorded yet (no log at all), within the test's scope. */
export const callLogLaws = (name: string, make: Effect.Effect<CallLogProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the CallLog laws`, () => {
    test("no log yet holds no events", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          expect(yield* CallLog.use((log) => log.events).pipe(Effect.provide(probe.layer))).toEqual([])
        }),
      ))

    test("holds every recorded event, in order, read afresh on every call", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const events = CallLog.use((log) => log.events).pipe(Effect.provide(probe.layer))
          yield* probe.record(recorded.slice(0, 2))
          expect(yield* events).toEqual(recorded.slice(0, 2))
          yield* probe.record(recorded.slice(2))
          expect(yield* events).toEqual([...recorded])
        }),
      ))

    test("a log that cannot be read fails with CallLogUnreadable and says why", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          yield* probe.spoil
          const failure = yield* CallLog.use((log) => log.events).pipe(Effect.provide(probe.layer), Effect.flip)
          expect(failure._tag).toBe("CallLogUnreadable")
          expect(failure.message).not.toBe("")
        }),
      ))
  })

// ── RunTables ──

/**
 * The runs under test: their Layer, a repository directory holding the runs
 * `make` was given, a directory in no repository, and a way to make the
 * repository's runs unreadable.
 */
export interface RunTablesProbe {
  readonly layer: Layer.Layer<RunTables>
  readonly repository: string
  readonly outside: string
  readonly spoil: Effect.Effect<void>
}

const tables: ReadonlyArray<RunTable> = [
  { name: "fresh", table: "| Unit | State | Round | Since |\n| --- | --- | --- | --- |\n| plan | plan | 1 | 2026-11-04T15:00Z |\n" },
  { name: "port", table: "| Unit | State | Round | Since |\n| --- | --- | --- | --- |\n| wake | implement | 1 | 2026-11-04T15:00Z |\n" },
]

const byName = (runs: ReadonlyArray<RunTable>) => [...runs].sort((left, right) => left.name.localeCompare(right.name))

/** `make(runs)` gives a repository holding `runs`, each printing its table, within the test's scope. */
export const runTablesLaws = (name: string, make: (runs: ReadonlyArray<RunTable>) => Effect.Effect<RunTablesProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the RunTables laws`, () => {
    test("lists each run of the repository with its table", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make(tables)
          const runs = yield* RunTables.use((runs) => runs.list(probe.repository)).pipe(Effect.provide(probe.layer))
          expect(byName(runs)).toEqual([...tables])
        }),
      ))

    test("a repository with no runs, and a directory in no repository, have none", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make([])
          const list = (directory: string) => RunTables.use((runs) => runs.list(directory)).pipe(Effect.provide(probe.layer))
          expect(yield* list(probe.repository)).toEqual([])
          expect(yield* list(probe.outside)).toEqual([])
        }),
      ))

    test("runs that cannot be read fail with RunsUnreadable and say why", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make(tables)
          yield* probe.spoil
          const failure = yield* RunTables.use((runs) => runs.list(probe.repository)).pipe(Effect.provide(probe.layer), Effect.flip)
          expect(failure._tag).toBe("RunsUnreadable")
          expect(failure.message).not.toBe("")
        }),
      ))
  })
