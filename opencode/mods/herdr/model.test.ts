import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Ref, Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Activity } from "./activity.ts"
import type { Bench, Received } from "./laws.ts"
import { reporter, type Reporter } from "./model.ts"
import { METADATA_REFRESH_MS } from "./report.ts"
import { Herdr, HerdrRefused } from "./service.ts"

/** A herdr that records each request and accepts it, or refuses every request once told to. */
const recording: Effect.Effect<Bench> = Effect.gen(function* () {
  const received = yield* Ref.make<ReadonlyArray<Received>>([])
  const refusal = yield* Ref.make<{ readonly code: string; readonly message: string } | undefined>(undefined)
  const send = (method: string, params: unknown) =>
    Effect.gen(function* () {
      yield* Ref.update(received, (all) => [...all, { method, params }])
      const refused = yield* Ref.get(refusal)
      if (refused !== undefined) return yield* new HerdrRefused({ method, ...refused })
    })
  return {
    layer: Layer.succeed(
      Herdr,
      Herdr.of({
        report: (params) => send("pane.report_agent", params),
        reportMetadata: (params) => send("pane.report_metadata", params),
        release: (params) => send("pane.release_agent", params),
      }),
    ),
    peer: { received: Ref.get(received), refuse: (code, message) => Ref.set(refusal, { code, message }) },
  }
})

const methods = (received: ReadonlyArray<Received>) => received.map((request) => request.method)
const param = (request: Received | undefined, key: string) =>
  request !== undefined && typeof request.params === "object" && request.params !== null ? Object.getOwnPropertyDescriptor(request.params, key)?.value : undefined

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(body.pipe(Effect.provide(TestClock.layer()), Effect.scoped))
// Run every send due before the next regular refresh, then close and inspect the trace.
const REPORT_WINDOW_MS = METADATA_REFRESH_MS - 1
const REFRESH_MS = 30
const AGENT = "pane.report_agent"
const LABELS = "pane.report_metadata"
const RELEASE = "pane.release_agent"

/** A reporter over a recording herdr, in a scope the test closes when it wants the release. */
const bench = (refreshMillis?: number) =>
  Effect.gen(function* () {
    const { layer, peer } = yield* recording
    const scope = yield* Scope.fork(yield* Scope.Scope)
    const reporting: Reporter = yield* reporter({ paneId: "w1:p1", ...(refreshMillis === undefined ? {} : { refreshMillis }) }).pipe(
      Effect.provide(Layer.merge(layer, Layer.succeed(Scope.Scope, scope))),
    )
    return { peer, reporting, close: Scope.close(scope, Exit.void) }
  })

const working: Activity = { state: "working", sessionId: "ses_1", title: "Fix login", working: "shell: bun test" }
const idle: Activity = { state: "idle", sessionId: "ses_1", title: "Fix login" }

describe("the reporter", () => {
  test("a turn: the state, then its labels, each once; the release on close", () =>
    run(
      Effect.gen(function* () {
        const { peer, reporting, close } = yield* bench()
        reporting.show(working)
        yield* TestClock.adjust(REPORT_WINDOW_MS)
        reporting.show(working)
        reporting.show(idle)
        // Drive the entire report window before closing, including any wrongly delayed send.
        yield* TestClock.adjust(REPORT_WINDOW_MS)
        yield* close
        const all = yield* peer.received
        expect(methods(all)).toEqual([AGENT, LABELS, AGENT, LABELS, RELEASE])
        expect([param(all[0], "state"), param(all[2], "state")]).toEqual(["working", "idle"])
        for (const index of [1, 3, 4]) expect(param(all[index], "state")).toBeUndefined()
        expect(param(all[1], "state_labels")).toEqual({ working: "shell: bun test" })
        expect(param(all[3], "clear_state_labels")).toBe(true)
        const seqs = all.map((request) => param(request, "seq"))
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
        expect(new Set(seqs).size).toBe(seqs.length)
      }),
    ))

  test("only the newest of a burst waits; a change of label alone sends metadata only", () =>
    run(
      Effect.gen(function* () {
        const { peer, reporting, close } = yield* bench()
        reporting.show(working)
        yield* TestClock.adjust(REPORT_WINDOW_MS)
        for (const command of ["a", "b", "c", "d"]) reporting.show({ ...working, working: `shell: ${command}` })
        yield* TestClock.adjust(REPORT_WINDOW_MS)
        yield* close
        const all = yield* peer.received
        expect(methods(all)).toEqual([AGENT, LABELS, LABELS, RELEASE])
        expect(param(all[2], "state_labels")).toEqual({ working: "shell: d" })
      }),
    ))

  test("an unchanged label is refreshed before its ttl runs out", () =>
    run(
      Effect.gen(function* () {
        const { peer, reporting, close } = yield* bench(REFRESH_MS)
        reporting.show(idle)
        yield* TestClock.adjust(2 * REFRESH_MS)
        yield* close
        expect(methods(yield* peer.received)).toEqual([AGENT, LABELS, LABELS, LABELS, RELEASE])
      }),
    ))

  test("a refused state is tried twice, holds back its labels, and is tried again at the next refresh", () =>
    run(
      Effect.gen(function* () {
        const { peer, reporting, close } = yield* bench(REFRESH_MS)
        yield* peer.refuse("resume_not_accepted", "no")
        reporting.show(working)
        yield* TestClock.adjust(REFRESH_MS)
        yield* close
        expect(methods(yield* peer.received)).toEqual([AGENT, AGENT, AGENT, AGENT, RELEASE, RELEASE])
      }),
    ))

  test("nothing is reported after close, or after a release run as a stop signal arrives, which releases at once; the close after it releases no second time", () =>
    run(
      Effect.gen(function* () {
        const { peer, reporting, close } = yield* bench()
        yield* close
        reporting.show(working)
        // Told to stop mid-turn: the signal's run and the teardown's run at once release the pane once, before the scope closes.
        const stopped = yield* bench()
        stopped.reporting.show(working)
        yield* TestClock.adjust(REPORT_WINDOW_MS)
        yield* Effect.all([stopped.reporting.release, stopped.reporting.release], { concurrency: "unbounded" })
        const released = yield* stopped.peer.received
        stopped.reporting.show(idle)
        yield* TestClock.adjust(REPORT_WINDOW_MS)
        yield* stopped.close
        expect(methods(yield* peer.received)).toEqual(["pane.release_agent"])
        expect(methods(released)).toEqual(["pane.report_agent", "pane.report_metadata", "pane.release_agent"])
        expect(methods(yield* stopped.peer.received)).toEqual(methods(released))
      }),
    ))
})
