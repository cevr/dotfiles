// What every implementation of a contract in service.ts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
// Forks and ForkReadings laws run over a Bench: the implementation under test,
// and a probe on the host's side of the story that the law reads and drives.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer } from "effect"
import { ForkReadings, Forks, HostFailed, SideQuestions } from "./service.ts"
import { INITIAL, type OpenFork } from "./side-question.ts"

/** The host as a law sees it: what each session holds, and a turn that ends. */
export interface HostProbe {
  /** The session's messages as the host stores them; empty for a session it does not hold. */
  readonly messages: (sessionID: string) => ReadonlyArray<Record<string, unknown>>
  readonly title: (sessionID: string) => string | undefined
  /** Whether the session has a turn running. */
  readonly running: (sessionID: string) => boolean
  /** The session's running turn ends with `text` as its answer. */
  readonly answer: (sessionID: string, text: string) => void
}

/**
 * Forks and ForkReadings under test over one host, and its probe. The host
 * holds a session `main` with a settled history of `turns` exchanges, each a
 * user message and an assistant reply stamped `time.created` in order.
 */
export interface Bench {
  readonly forks: Layer.Layer<Forks>
  readonly readings: Layer.Layer<ForkReadings>
  readonly host: HostProbe
}

const run = <A, E>(body: Effect.Effect<A, E>) => Effect.runPromise(body)

const openFork = (sessionID: string, createdAt: number): OpenFork => ({ sessionID, name: "btw: why", createdAt, broughtBack: [] })

// ── Forks ──

export const forksLaws = (name: string, make: (turns: number) => Bench) =>
  describe(`${name} keeps the Forks laws`, () => {
    test("a fork is a new session holding the session's history, made after it; the session is untouched", () =>
      run(
        Effect.gen(function* () {
          const bench = make(2)
          const host = bench.host
          const before = structuredClone(host.messages("main"))
          const made = yield* Forks.use((forks) => forks.fork("main")).pipe(Effect.provide(bench.forks))
          expect(made.sessionID).not.toBe("main")
          expect(host.messages(made.sessionID)).toEqual(before)
          for (const message of before) expect((message.time as { created: number }).created).toBeLessThan(made.createdAt)
          expect(host.messages("main")).toEqual(before)
        }),
      ))

    test("each fork is its own session", () =>
      run(
        Effect.gen(function* () {
          const bench = make(1)
          const [first, second] = yield* Forks.use((forks) => Effect.all([forks.fork("main"), forks.fork("main")])).pipe(Effect.provide(bench.forks))
          expect(first.sessionID).not.toBe(second.sessionID)
        }),
      ))

    test("naming titles the session", () =>
      run(
        Effect.gen(function* () {
          const bench = make(1)
          const host = bench.host
          yield* Forks.use((forks) => forks.name("main", "btw: why")).pipe(Effect.provide(bench.forks))
          expect(host.title("main")).toBe("btw: why")
        }),
      ))

    test("asking admits the note as a hidden message, then the question as the reader's prompt, and starts a turn", () =>
      run(
        Effect.gen(function* () {
          const bench = make(1)
          const host = bench.host
          const before = host.messages("main").length
          yield* Forks.use((forks) => forks.ask("main", "the note", "why?")).pipe(Effect.provide(bench.forks))
          const added = host.messages("main").slice(before)
          expect(added.map((message) => [message.type, message.text, message.description])).toEqual([
            ["synthetic", "the note", undefined],
            ["user", "why?", undefined],
          ])
          expect(host.running("main")).toBe(true)
        }),
      ))

    test("asking with no note admits the question alone", () =>
      run(
        Effect.gen(function* () {
          const bench = make(1)
          const host = bench.host
          const before = host.messages("main").length
          yield* Forks.use((forks) => forks.ask("main", undefined, "and?")).pipe(Effect.provide(bench.forks))
          expect(host.messages("main").slice(before).map((message) => [message.type, message.text])).toEqual([["user", "and?"]])
          expect(host.running("main")).toBe(true)
        }),
      ))

    test("bringing back admits the notice once per id, shown by its description, and wakes the session", () =>
      run(
        Effect.gen(function* () {
          const bench = make(1)
          const host = bench.host
          const before = host.messages("main").length
          const notice = { id: "msg_btw_1", text: "the answer", description: "btw · why" }
          yield* Forks.use((forks) => Effect.all([forks.bringBack("main", notice), forks.bringBack("main", notice)])).pipe(Effect.provide(bench.forks))
          const added = host.messages("main").slice(before)
          expect(added.map((message) => [message.type, message.id, message.text, message.description])).toEqual([
            ["synthetic", "msg_btw_1", "the answer", "btw · why"],
          ])
          expect(host.running("main")).toBe(true)
        }),
      ))

    test("every operation on a session the host does not hold fails HostFailed naming the operation", () =>
      run(
        Effect.gen(function* () {
          const bench = make(1)
          const failures = yield* Forks.use((forks) =>
            Effect.all([
              Effect.flip(forks.fork("gone")),
              Effect.flip(forks.name("gone", "x")),
              Effect.flip(forks.ask("gone", "note", "q")),
              Effect.flip(forks.bringBack("gone", { id: "msg_btw_1", text: "t", description: "d" })),
            ]),
          ).pipe(Effect.provide(bench.forks))
          for (const failure of failures) expect(failure).toBeInstanceOf(HostFailed)
          expect(failures.map((failure) => failure.operation)).toEqual(["fork", "name", "ask", "bringBack"])
          for (const failure of failures) expect(failure.message.length).toBeGreaterThan(0)
        }),
      ))
  })

// ── ForkReadings ──

/** Forks `main` and returns the fork as the side question holds it. */
const forkIn = (bench: Bench) =>
  Forks.use((forks) => forks.fork("main")).pipe(
    Effect.map((made) => openFork(made.sessionID, made.createdAt)),
    Effect.provide(bench.forks),
  )

export const forkReadingsLaws = (name: string, make: (turns: number) => Bench) =>
  describe(`${name} keeps the ForkReadings laws`, () => {
    test("a fork asked nothing reads no turns, though it holds the session's history", () =>
      run(
        Effect.gen(function* () {
          const bench = make(2)
          const fork = yield* forkIn(bench)
          expect(yield* ForkReadings.use((readings) => readings.read(fork)).pipe(Effect.provide(bench.readings))).toEqual({ turns: [], replying: false })
        }),
      ))

    test("while the fork answers, its question reads with no answer yet and the fork is replying", () =>
      run(
        Effect.gen(function* () {
          const bench = make(1)
          const fork = yield* forkIn(bench)
          yield* Forks.use((each) => each.ask(fork.sessionID, "note", "why?")).pipe(Effect.provide(bench.forks))
          expect(yield* ForkReadings.use((readings) => readings.read(fork)).pipe(Effect.provide(bench.readings))).toEqual({
            turns: [{ question: "why?", answer: "" }],
            replying: true,
          })
        }),
      ))

    test("reads afresh on every call: an answer that lands shows on the next read", () =>
      run(
        Effect.gen(function* () {
          const bench = make(1)
          const host = bench.host
          const fork = yield* forkIn(bench)
          const read = ForkReadings.use((readings) => readings.read(fork)).pipe(Effect.provide(bench.readings))
          yield* Forks.use((each) => each.ask(fork.sessionID, "note", "why?")).pipe(Effect.provide(bench.forks))
          expect((yield* read).replying).toBe(true)
          host.answer(fork.sessionID, "because")
          const reading = yield* read
          expect(reading.replying).toBe(false)
          expect(reading.turns.map((turn) => [turn.question, turn.answer])).toEqual([["why?", "because"]])
          expect(reading.turns[0]?.replyID).toStartWith("msg_")
        }),
      ))

    test("a fork the host does not hold reads no turns and is not replying", () =>
      run(
        Effect.gen(function* () {
          const bench = make(1)
          expect(yield* ForkReadings.use((readings) => readings.read(openFork("gone", 0))).pipe(Effect.provide(bench.readings))).toEqual({
            turns: [],
            replying: false,
          })
        }),
      ))
  })

// ── SideQuestions ──

export const sideQuestionsLaws = (name: string, make: Effect.Effect<Layer.Layer<SideQuestions>>) =>
  describe(`${name} keeps the SideQuestions laws`, () => {
    const fork = openFork("fork-1", 5)

    test("a session that has none reads the initial state", () =>
      run(
        Effect.gen(function* () {
          const layer = yield* make
          expect(yield* SideQuestions.use((store) => store.get("main")).pipe(Effect.provide(layer))).toEqual(INITIAL)
        }),
      ))

    test("a state set reads back for its session only, and a later set replaces it", () =>
      run(
        Effect.gen(function* () {
          const layer = yield* make
          const store = yield* SideQuestions.pipe(Effect.provide(layer))
          yield* store.set("main", { fork })
          expect(yield* store.get("main")).toEqual({ fork })
          expect(yield* store.get("other")).toEqual(INITIAL)
          const later = { fork: { ...fork, broughtBack: ["msg_a"] } }
          yield* store.set("main", later)
          expect(yield* store.get("main")).toEqual(later)
        }),
      ))
  })
