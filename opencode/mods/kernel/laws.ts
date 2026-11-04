// What every implementation of a contract in service.ts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, type Scope } from "effect"
import type { Json, SnapshotBinding } from "./frame.ts"
import { Sessions, Snapshots, Toolbox, Workers, type Cell } from "./service.ts"
import { KernelSessionId } from "./session.ts"
import { CallFailed, notATool, type Rule } from "./tools.ts"

const first = KernelSessionId.make("ses_law_first")
const second = KernelSessionId.make("ses_law_second")

const check = <A, E, R>(layer: Layer.Layer<R>, body: Effect.Effect<A, E, R | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(body).pipe(Effect.provide(layer)))

// ── Snapshots ──

const binding = (name: string, value: Json): SnapshotBinding => ({ name, value })

/** `layer` makes a fresh, empty store each time it is called. */
export const snapshotsLaws = (name: string, layer: () => Layer.Layer<Snapshots>) =>
  describe(`${name} keeps the Snapshots laws`, () => {
    test("a session never saved holds no bindings", () =>
      check(
        layer(),
        Effect.gen(function* () {
          expect(yield* (yield* Snapshots).load(first)).toEqual([])
        }),
      ))

    test("loads what was saved last, value for value", () =>
      check(
        layer(),
        Effect.gen(function* () {
          const snapshots = yield* Snapshots
          yield* snapshots.save(first, [binding("a", 1), binding("b", { nested: ["x", null, true] })])
          expect(yield* snapshots.load(first)).toEqual([binding("a", 1), binding("b", { nested: ["x", null, true] })])
          yield* snapshots.save(first, [binding("c", "only")])
          expect(yield* snapshots.load(first)).toEqual([binding("c", "only")])
        }),
      ))

    test("drops a session's bindings and leaves another's", () =>
      check(
        layer(),
        Effect.gen(function* () {
          const snapshots = yield* Snapshots
          yield* snapshots.save(first, [binding("a", 1)])
          yield* snapshots.save(second, [binding("b", 2)])
          yield* snapshots.drop(first)
          yield* snapshots.drop(KernelSessionId.make("ses_law_never"))
          expect(yield* snapshots.load(first)).toEqual([])
          expect(yield* snapshots.load(second)).toEqual([binding("b", 2)])
        }),
      ))
  })

// ── Sessions ──

/** The host's sessions and agents a Sessions implementation reads, for the laws. */
export interface SessionsWorld {
  readonly sessions: Readonly<Record<string, { readonly directory: string; readonly permissions?: ReadonlyArray<Rule> }>>
  readonly agents: Readonly<Record<string, ReadonlyArray<Rule>>>
}

const rule = (action: string, effect: string): Rule => ({ action, resource: "*", effect })

export const sessionsLaws = (name: string, layer: (world: SessionsWorld) => Layer.Layer<Sessions>) =>
  describe(`${name} keeps the Sessions laws`, () => {
    const world: SessionsWorld = {
      sessions: { [first]: { directory: "/work/first", permissions: [rule("bash", "deny")] }, [second]: { directory: "/work/second" } },
      agents: { build: [rule("edit", "allow"), rule("bash", "allow")] },
    }

    test("a session's scope is its directory, and its agent's rules then its own", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const sessions = yield* Sessions
          expect(yield* sessions.scope(first, "build")).toEqual({
            directory: "/work/first",
            rules: [rule("edit", "allow"), rule("bash", "allow"), rule("bash", "deny")],
          })
          expect(yield* sessions.scope(second, "build")).toEqual({ directory: "/work/second", rules: [rule("edit", "allow"), rule("bash", "allow")] })
        }),
      ))

    test("an agent that cannot be read has no rules", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          expect(yield* (yield* Sessions).scope(first, "nobody")).toEqual({ directory: "/work/first", rules: [rule("bash", "deny")] })
        }),
      ))

    test("a session that cannot be read fails SessionUnreadable, naming it", () =>
      check(
        layer(world),
        Effect.gen(function* () {
          const unreadable = yield* Effect.flip((yield* Sessions).scope(KernelSessionId.make("ses_law_missing"), "build"))
          expect(unreadable._tag).toBe("SessionUnreadable")
          expect(unreadable.session).toBe("ses_law_missing")
          expect(unreadable.message.length).toBeGreaterThan(0)
        }),
      ))
  })

// ── Toolbox ──

/** One tool a Toolbox implementation offers, for the laws: its answer to an input, or the words it fails with. */
export interface LawTool {
  readonly id: string
  readonly description: string
  readonly answer: (input: Json) => Effect.Effect<Json, string>
}

export const toolboxLaws = (name: string, layer: (tools: ReadonlyArray<LawTool>) => Layer.Layer<Toolbox>) =>
  describe(`${name} keeps the Toolbox laws`, () => {
    const tools: ReadonlyArray<LawTool> = [
      { id: "echo", description: "says it back", answer: (input) => Effect.succeed({ said: input }) },
      { id: "broken", description: "always fails", answer: () => Effect.fail("the tool broke") },
    ]

    test("lists the tools a cell reaches", () =>
      check(
        layer(tools),
        Effect.gen(function* () {
          const reached = yield* (yield* Toolbox).reach([])
          expect(reached.listing).toEqual([
            { id: "echo", description: "says it back" },
            { id: "broken", description: "always fails" },
          ])
        }),
      ))

    test("a call answers with the tool's value", () =>
      check(
        layer(tools),
        Effect.gen(function* () {
          const reached = yield* (yield* Toolbox).reach([])
          expect(yield* reached.call("echo", { text: "hi" })).toEqual({ said: { text: "hi" } })
        }),
      ))

    test("a call fails CallFailed with the tool's words, or the words for a tool it does not have", () =>
      check(
        layer(tools),
        Effect.gen(function* () {
          const reached = yield* (yield* Toolbox).reach([])
          expect(yield* Effect.flip(reached.call("broken", {}))).toEqual(new CallFailed({ message: "the tool broke" }))
          expect(yield* Effect.flip(reached.call("nope", {}))).toEqual(new CallFailed({ message: notATool("nope", ["echo", "broken"]) }))
        }),
      ))
  })

// ── Workers ──

const none: Cell["call"] = () => Effect.fail(new CallFailed({ message: "no tools in the laws" }))
const cell = (source: string, call: Cell["call"] = none): Cell => ({ source, tools: [{ id: "echo", description: "says it back" }], call })

/** `layer` is the workers under test; each starts in `directory`. */
export const workersLaws = (name: string, layer: () => Layer.Layer<Workers>, directory: string) =>
  describe(`${name} keeps the Workers laws`, () => {
    test("a started worker is alive and keeps its bindings from one cell to the next", () =>
      check(
        layer(),
        Effect.gen(function* () {
          const workers = yield* Workers
          expect(yield* workers.alive(first)).toBe(false)
          yield* workers.start(first, directory)
          expect(yield* workers.alive(first)).toBe(true)
          expect((yield* workers.evaluate(first, cell("let x = 1"))).ok).toBe(true)
          expect((yield* workers.evaluate(first, cell("x + 1"))).display).toBe("2")
        }),
      ))

    test("a session without a worker fails WorkerLost; stopping one twice is fine", () =>
      check(
        layer(),
        Effect.gen(function* () {
          const workers = yield* Workers
          expect((yield* Effect.flip(workers.evaluate(first, cell("1"))))._tag).toBe("WorkerLost")
          expect((yield* Effect.flip(workers.snapshot(first)))._tag).toBe("WorkerLost")
          expect((yield* Effect.flip(workers.restore(first, [])))._tag).toBe("WorkerLost")
          yield* workers.start(first, directory)
          yield* workers.stop(first)
          yield* workers.stop(first)
          expect(yield* workers.alive(first)).toBe(false)
          expect((yield* Effect.flip(workers.evaluate(first, cell("1"))))._tag).toBe("WorkerLost")
        }),
      ))

    test("one session's worker is not another's, and stopping it leaves the other running", () =>
      check(
        layer(),
        Effect.gen(function* () {
          const workers = yield* Workers
          yield* workers.start(first, directory)
          yield* workers.start(second, directory)
          yield* workers.evaluate(first, cell("let mine = 1"))
          expect((yield* workers.evaluate(second, cell("typeof mine"))).display).toBe("undefined")
          yield* workers.stop(first)
          expect(yield* workers.alive(first)).toBe(false)
          expect(yield* workers.alive(second)).toBe(true)
          expect((yield* Effect.flip(workers.evaluate(first, cell("1"))))._tag).toBe("WorkerLost")
        }),
      ))

    test("a snapshot restored into a fresh worker gives back its bindings", () =>
      check(
        layer(),
        Effect.gen(function* () {
          const workers = yield* Workers
          yield* workers.start(first, directory)
          yield* workers.evaluate(first, cell('let n = 5; const word = "kept"'))
          const snapshot = yield* workers.snapshot(first)
          expect(snapshot.omitted).toEqual([])
          yield* workers.start(first, directory)
          expect([...(yield* workers.restore(first, snapshot.bindings))].sort()).toEqual(["n", "word"])
          expect((yield* workers.evaluate(first, cell("[n, word]"))).display).toBe('[ 5, "kept" ]')
        }),
      ))

    test("a cell's tool call goes through the cell's call, and its value comes back", () =>
      check(
        layer(),
        Effect.gen(function* () {
          const workers = yield* Workers
          yield* workers.start(first, directory)
          const echo: Cell["call"] = (id, input) => Effect.succeed({ id, input })
          expect((yield* workers.evaluate(first, cell('(await tools.echo({ a: 1 })).input.a', echo))).display).toBe("1")
        }),
      ))

    test("a cell that is interrupted kills its worker", () =>
      check(
        layer(),
        Effect.gen(function* () {
          const workers = yield* Workers
          yield* workers.start(first, directory)
          const hung = yield* Effect.timeoutOrElse(workers.evaluate(first, cell("await new Promise(() => {})")), {
            duration: "200 millis",
            orElse: () => Effect.succeed("interrupted"),
          })
          expect(hung).toBe("interrupted")
          expect(yield* workers.alive(first)).toBe(false)
        }),
      ))
  })
