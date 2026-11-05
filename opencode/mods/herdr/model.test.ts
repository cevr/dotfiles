import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Ref, Scope } from "effect"
import type { Activity } from "./activity.ts"
import type { Bench, Peer, Received } from "./laws.ts"
import { reporter, type Reporter } from "./model.ts"
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

/** Waits until herdr has received `count` requests, then a little longer to catch any extra. */
const settle = (peer: Peer, count: number) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 200 && (yield* peer.received).length < count; tries++) yield* Effect.sleep(5)
    yield* Effect.sleep(20)
    return yield* peer.received
  })

/** A reporter over a recording herdr, in a scope the test closes when it wants the release. */
const bench = (refreshMillis?: number) =>
  Effect.gen(function* () {
    const { layer, peer } = yield* recording
    const scope = yield* Scope.make()
    const reporting: Reporter = yield* reporter({ paneId: "w1:p1", ...(refreshMillis === undefined ? {} : { refreshMillis }) }).pipe(
      Effect.provide(Layer.merge(layer, Layer.succeed(Scope.Scope, scope))),
    )
    return { peer, reporting, close: Scope.close(scope, Exit.void) }
  })

const working: Activity = { state: "working", sessionId: "ses_1", title: "Fix login", working: "shell: bun test" }
const idle: Activity = { state: "idle", sessionId: "ses_1", title: "Fix login" }

describe("the reporter", () => {
  test("a turn: the state, then its labels, each once; the release on close", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { peer, reporting, close } = yield* bench()
        reporting.show(working)
        yield* settle(peer, 2)
        reporting.show(working)
        reporting.show(idle)
        const turn = yield* settle(peer, 4)
        yield* close
        const all = yield* peer.received
        expect(methods(turn)).toEqual(["pane.report_agent", "pane.report_metadata", "pane.report_agent", "pane.report_metadata"])
        expect(turn.map((request) => param(request, "state"))).toEqual(["working", undefined, "idle", undefined])
        expect(param(turn[1], "state_labels")).toEqual({ working: "shell: bun test" })
        expect(param(turn[3], "clear_state_labels")).toBe(true)
        expect(methods(all).at(-1)).toBe("pane.release_agent")
        const seqs = all.map((request) => param(request, "seq"))
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
        expect(new Set(seqs).size).toBe(seqs.length)
      }),
    ))

  test("only the newest of a burst waits; a change of label alone sends metadata only", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { peer, reporting, close } = yield* bench()
        reporting.show(working)
        yield* settle(peer, 2)
        for (const command of ["a", "b", "c", "d"]) reporting.show({ ...working, working: `shell: ${command}` })
        const received = yield* settle(peer, 3)
        yield* close
        const after = received.slice(2)
        expect(methods(after).every((method) => method === "pane.report_metadata")).toBe(true)
        expect(after.length).toBeLessThan(4)
        expect(param(after.at(-1), "state_labels")).toEqual({ working: "shell: d" })
      }),
    ))

  test("an unchanged label is refreshed before its ttl runs out", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { peer, reporting, close } = yield* bench(30)
        reporting.show(idle)
        const received = yield* settle(peer, 4)
        yield* close
        expect(methods(received).slice(0, 4)).toEqual(["pane.report_agent", "pane.report_metadata", "pane.report_metadata", "pane.report_metadata"])
      }),
    ))

  test("a refused state is tried twice, holds back its labels, and is tried again at the next refresh", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { peer, reporting, close } = yield* bench(30)
        yield* peer.refuse("resume_not_accepted", "no")
        reporting.show(working)
        const refused = yield* settle(peer, 3)
        yield* close
        expect(methods(refused).slice(0, 3)).toEqual(["pane.report_agent", "pane.report_agent", "pane.report_agent"])
        expect(methods(refused)).not.toContain("pane.report_metadata")
      }),
    ))

  test("nothing is reported after close", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { peer, reporting, close } = yield* bench()
        yield* close
        reporting.show(working)
        yield* Effect.sleep(30)
        expect(methods(yield* peer.received)).toEqual(["pane.release_agent"])
      }),
    ))
})
