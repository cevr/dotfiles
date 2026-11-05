// What every implementation of the Herdr contract owes, as a shared test
// suite. Each implementation's test beside it runs the suite over its Layer and
// the far side it talks to.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Layer, type Scope } from "effect"
import { agentParams, metadataParams, releaseParams } from "./report.ts"
import { Herdr, HerdrRefused } from "./service.ts"

/** One request as herdr received it. */
export interface Received {
  readonly method: string
  readonly params: unknown
}

/** The far side a law drives: what herdr received, and an answer of refusal for every request after `refuse`. */
export interface Peer {
  readonly received: Effect.Effect<ReadonlyArray<Received>>
  readonly refuse: (code: string, message: string) => Effect.Effect<void>
}

export interface Bench {
  readonly layer: Layer.Layer<Herdr>
  readonly peer: Peer
}

const check = <A, E>(bench: Effect.Effect<Bench, never, Scope.Scope>, body: (peer: Peer) => Effect.Effect<A, E, Herdr | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { layer, peer } = yield* bench
        return yield* body(peer).pipe(Effect.provide(layer))
      }),
    ),
  )

const working = agentParams("w1:p1", { state: "working", sessionId: "ses_law", working: "shell: ls" }, 1)
const labels = metadataParams("w1:p1", { state: "working", sessionId: "ses_law", title: "Law", working: "shell: ls" }, 2)
const release = releaseParams("w1:p1", 3)

/** `bench` makes a fresh implementation and the herdr it talks to, which accepts every request until told to refuse. */
export const herdrLaws = (name: string, bench: () => Effect.Effect<Bench, never, Scope.Scope>) =>
  describe(`${name} keeps the Herdr laws`, () => {
    test("each call delivers its method and params as given, in order", () =>
      check(bench(), (peer) =>
        Effect.gen(function* () {
          const herdr = yield* Herdr
          yield* herdr.report(working)
          yield* herdr.reportMetadata(labels)
          yield* herdr.release(release)
          expect(yield* peer.received).toEqual([
            { method: "pane.report_agent", params: working },
            { method: "pane.report_metadata", params: labels },
            { method: "pane.release_agent", params: release },
          ])
        }),
      ))

    test("a refusal fails HerdrRefused with the method and herdr's code", () =>
      check(bench(), (peer) =>
        Effect.gen(function* () {
          const herdr = yield* Herdr
          yield* peer.refuse("resume_not_accepted", "hold the pane first")
          const exit = yield* Effect.exit(herdr.report(working))
          expect(exit).toEqual(Exit.fail(new HerdrRefused({ method: "pane.report_agent", code: "resume_not_accepted", message: "hold the pane first" })))
        }),
      ))
  })
