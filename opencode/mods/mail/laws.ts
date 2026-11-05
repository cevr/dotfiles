// What every implementation of the Sessions contract owes, as a shared test
// suite. Each implementation's test beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, Option, type Scope } from "effect"
import { compose } from "./letter.ts"
import { Sessions } from "./service.ts"

export interface WorldSession {
  readonly title?: string
  readonly parentID?: string
  readonly agent?: string
  readonly running?: boolean
  readonly archived?: boolean
  /** Last activity, epoch ms. */
  readonly updated: number
}

/** The host's state an implementation is set up with. Every session's directory is `/work`. */
export interface World {
  readonly sessions: Readonly<Record<string, WorldSession>>
}

/** A letter the host took in: for which session, its text and line, and whether it woke the session. */
export interface Delivered {
  readonly sessionID: string
  readonly text: string
  readonly description: string
  readonly metadata: Record<string, unknown>
  readonly wake: boolean
}

/** An implementation over a world, and the letters it delivered. */
export interface Bench {
  readonly layer: Layer.Layer<Sessions>
  readonly delivered: () => ReadonlyArray<Delivered>
}

const WORLD: World = {
  sessions: {
    ses_root: { title: "Root", agent: "build", running: true, updated: 3_000 },
    ses_idle: { title: "Idle", agent: "plan", updated: 2_000 },
    ses_old: { title: "Old", updated: 1_000 },
    ses_gone: { title: "Archived", updated: 4_000, archived: true },
    ses_child: { title: "Worker", parentID: "ses_root", agent: "worker", running: true, updated: 5_000 },
  },
}

const check = <A, E>(bench: (world: World) => Effect.Effect<Bench, never, Scope.Scope>, body: (made: Bench) => Effect.Effect<A, E, Sessions>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const made = yield* bench(WORLD)
        return yield* body(made).pipe(Effect.provide(made.layer))
      }),
    ),
  )

const LETTER = compose({ id: "ses_root", title: "Root" }, { id: "ses_root", title: "Root" }, "hello")

export const sessionsLaws = (name: string, bench: (world: World) => Effect.Effect<Bench, never, Scope.Scope>) =>
  describe(`${name} owes the Sessions laws`, () => {
    test("get reads a session as a card: title, agent, directory, parent, whether it runs, its last activity", () =>
      check(bench, () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions
          expect(Option.getOrUndefined(yield* sessions.get("ses_child"))).toEqual({
            id: "ses_child",
            title: "Worker",
            directory: "/work",
            agent: "worker",
            running: true,
            parentID: "ses_root",
            updated: 5_000,
          })
          expect(Option.getOrUndefined(yield* sessions.get("ses_idle"))).toMatchObject({ id: "ses_idle", running: false, parentID: undefined })
        }),
      ))

    test("get finds no session the server does not have", () =>
      check(bench, () =>
        Effect.gen(function* () {
          expect(Option.isNone(yield* (yield* Sessions).get("ses_nowhere"))).toBe(true)
        }),
      ))

    test("list gives the main sessions newest first, leaving archived ones out; children adds the subagents'", () =>
      check(bench, () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions
          expect((yield* sessions.list({ children: false })).map((card) => card.id)).toEqual(["ses_root", "ses_idle", "ses_old"])
          expect((yield* sessions.list({ children: true })).map((card) => card.id)).toEqual(["ses_child", "ses_root", "ses_idle", "ses_old"])
        }),
      ))

    test("deliver hands the session the letter, waking it or not", () =>
      check(bench, (made) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions
          yield* sessions.deliver("ses_idle", LETTER, true)
          yield* sessions.deliver("ses_old", LETTER, false)
          expect(made.delivered()).toEqual([
            { sessionID: "ses_idle", text: LETTER.text, description: LETTER.description, metadata: LETTER.metadata, wake: true },
            { sessionID: "ses_old", text: LETTER.text, description: LETTER.description, metadata: LETTER.metadata, wake: false },
          ])
        }),
      ))

    test("deliver to a session the server does not have is refused, and nothing is delivered", () =>
      check(bench, (made) =>
        Effect.gen(function* () {
          const refused = yield* Effect.flip((yield* Sessions).deliver("ses_nowhere", LETTER, true))
          expect(refused._tag).toBe("DeliveryRefused")
          expect(refused.sessionID).toBe("ses_nowhere")
          expect(made.delivered()).toEqual([])
        }),
      ))
  })
