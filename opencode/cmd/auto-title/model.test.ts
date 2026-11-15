// The trigger rule through the handlers, on the test clock: the model hears
// the host's facts about each session, keeps its track in memory, and asks a
// stand-in host for a new title. It checks time and turns, a compaction, an
// owner's pin and its release, an agent's rename, a subagent, a busy session,
// another location's copy, a failed request, and one request at a time for
// copies that share the host's lock.
import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Layer, Option, Scope, Semaphore } from "effect"
import { TestClock } from "effect/testing"
import { tracksLaws } from "@dotfiles/opencode-auto-title/laws"
import { AutoTitle, layer } from "@dotfiles/opencode-auto-title/model"
import type { Policy, Track } from "@dotfiles/opencode-auto-title/retitle"
import { type Seat, Sessions, TitleFailed, Tracks } from "@dotfiles/opencode-auto-title/service"
import { effectTest } from "../../sim-tui/effect-test.ts"

/** The tracks in a map the test reads. */
const memoryTracks = (entries: Map<string, Track> = new Map()) =>
  Layer.succeed(
    Tracks,
    Tracks.of({
      get: (sessionID) => Effect.sync(() => Option.fromUndefinedOr(entries.get(sessionID))),
      put: (sessionID, track) => Effect.sync(() => void entries.set(sessionID, track)),
      remove: (sessionID) => Effect.sync(() => void entries.delete(sessionID)),
    }),
  )

tracksLaws("the test's tracks", () => memoryTracks(), effectTest)

const MINUTE = 60_000
/** Each case's time limit, ms. */
const LIMIT = 5_000
const POLICY: Policy = { afterMs: 30 * MINUTE, afterTurns: 6 }

/** A root session of this copy's location, idle: the seat of every session the test does not set. */
const IDLE_ROOT: Seat = { serves: true, child: false, running: false }

/** The host: each session's seat, and the title requests it was asked for. */
const host = () => {
  const seats = new Map<string, Seat>()
  const asked: Array<string> = []
  /** Sessions whose request fails. */
  const failing = new Set<string>()
  /** A request waits for this, while it is held, before it answers. */
  const gate = { held: Option.none<Deferred.Deferred<void>>() }
  const sessions = Sessions.of({
    seat: (sessionID) => Effect.sync(() => Option.getOrElse(Option.fromUndefinedOr(seats.get(sessionID)), () => IDLE_ROOT)),
    retitle: (sessionID) =>
      Effect.gen(function* () {
        asked.push(sessionID)
        if (Option.isSome(gate.held)) yield* Deferred.await(gate.held.value)
        if (failing.has(sessionID)) return yield* new TitleFailed({ sessionID, message: "the model refused" })
      }),
  })
  return { seats, asked, failing, gate, layer: Layer.succeed(Sessions, sessions) }
}

/** Whether the session's kept track is pinned; none when nothing is kept. */
const pinned = (tracks: Map<string, Track>, sessionID: string) => Option.map(Option.fromUndefinedOr(tracks.get(sessionID)), (track) => track.pinned)

type Host = ReturnType<typeof host>

/** A copy of the plugin on `world`, sharing `lock` and the stored tracks. */
const copy = (world: Host, lock: Semaphore.Semaphore, tracks: Map<string, Track>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const services = yield* Layer.build(layer(POLICY, lock, scope).pipe(Layer.provide(Layer.merge(world.layer, memoryTracks(tracks)))))
    return Context.get(services, AutoTitle)
  })

/** Lets the forked title requests run. */
const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true })

const scenario = <A>(name: string, body: (input: { readonly world: Host; readonly title: AutoTitle["Service"]; readonly tracks: Map<string, Track> }) => Effect.Effect<A, unknown, Scope.Scope>) =>
  effectTest(
    name,
    Effect.scoped(
      Effect.gen(function* () {
        const world = host()
        const tracks = new Map<string, Track>()
        const title = yield* copy(world, Semaphore.makeUnsafe(1), tracks)
        return yield* body({ world, title, tracks })
      }),
    ).pipe(Effect.provide(TestClock.layer()), Effect.orDie),
    LIMIT,
  )

/** `n` turns of the session, each ending idle. */
const turns = (title: AutoTitle["Service"], sessionID: string, n: number) =>
  Effect.forEach(Array.from({ length: n }), () => title.replied(sessionID).pipe(Effect.andThen(settle)), { discard: true })

/** The host generates the session's title: its title request, then the title. */
const generated = (title: AutoTitle["Service"], sessionID: string) =>
  title.generating(sessionID).pipe(Effect.andThen(title.renamed(sessionID, "Generated")), Effect.andThen(settle))

describe("auto-title, on the test clock", () => {
  scenario("an idle root session is retitled once 30 minutes and 6 turns have passed since its last title, and not before", ({ world, title }) =>
      Effect.gen(function* () {
        yield* generated(title, "ses_root")
        yield* turns(title, "ses_root", 6)
        expect(world.asked).toEqual([])
        yield* TestClock.adjust(29 * MINUTE)
        yield* turns(title, "ses_root", 1)
        expect(world.asked).toEqual([])
        yield* TestClock.adjust(MINUTE)
        yield* turns(title, "ses_root", 1)
        expect(world.asked).toEqual(["ses_root"])
        // The count starts again: the next turn is not due.
        yield* TestClock.adjust(60 * MINUTE)
        yield* turns(title, "ses_root", 5)
        expect(world.asked).toEqual(["ses_root"])
        yield* turns(title, "ses_root", 1)
        expect(world.asked).toEqual(["ses_root", "ses_root"])
      }),
  )

  scenario("hours with fewer than 6 turns keep the title", ({ world, title }) =>
      Effect.gen(function* () {
        yield* generated(title, "ses_root")
        yield* TestClock.adjust(5 * 60 * MINUTE)
        yield* turns(title, "ses_root", 5)
        expect(world.asked).toEqual([])
      }),
  )

  scenario("a compaction retitles at once when a turn ended since the last title, and not with none", ({ world, title }) =>
      Effect.gen(function* () {
        yield* generated(title, "ses_root")
        yield* title.compacted("ses_root").pipe(Effect.andThen(settle))
        expect(world.asked).toEqual([])
        yield* turns(title, "ses_root", 1)
        yield* title.compacted("ses_root").pipe(Effect.andThen(settle))
        expect(world.asked).toEqual(["ses_root"])
      }),
  )

  scenario("a compaction during a turn retitles when the session goes idle", ({ world, title }) =>
      Effect.gen(function* () {
        yield* generated(title, "ses_root")
        yield* turns(title, "ses_root", 1)
        world.seats.set("ses_root", { serves: true, child: false, running: true })
        yield* title.compacted("ses_root").pipe(Effect.andThen(settle))
        expect(world.asked).toEqual([])
        world.seats.set("ses_root", { serves: true, child: false, running: false })
        yield* turns(title, "ses_root", 1)
        expect(world.asked).toEqual(["ses_root"])
      }),
  )

  scenario("a title the owner set pins the session until the owner asks for a generated one", ({ world, title, tracks }) =>
      Effect.gen(function* () {
        yield* title.renamed("ses_root", "My own name")
        expect(pinned(tracks, "ses_root")).toEqual(Option.some(true))
        yield* TestClock.adjust(60 * MINUTE)
        yield* turns(title, "ses_root", 10)
        yield* title.compacted("ses_root").pipe(Effect.andThen(settle))
        expect(world.asked).toEqual([])
        // The owner's /rename with no argument: the host's title request, then its title.
        yield* title.generating("ses_root")
        yield* TestClock.adjust(2_000)
        yield* title.renamed("ses_root", "Generated by the host")
        expect(pinned(tracks, "ses_root")).toEqual(Option.some(false))
        yield* TestClock.adjust(30 * MINUTE)
        yield* turns(title, "ses_root", 6)
        expect(world.asked).toEqual(["ses_root"])
      }),
  )

  scenario("an agent's rename does not pin, and counts as the last title", ({ world, title, tracks }) =>
      Effect.gen(function* () {
        yield* generated(title, "ses_root")
        yield* TestClock.adjust(40 * MINUTE)
        yield* turns(title, "ses_root", 5)
        yield* title.agentRenaming("ses_root", "Orchestrating the batch")
        yield* title.renamed("ses_root", "Orchestrating the batch")
        expect(pinned(tracks, "ses_root")).toEqual(Option.some(false))
        yield* turns(title, "ses_root", 6)
        expect(world.asked).toEqual([])
        yield* TestClock.adjust(30 * MINUTE)
        yield* turns(title, "ses_root", 1)
        expect(world.asked).toEqual(["ses_root"])
      }),
  )

  scenario("an agent's mark does not cover another title, nor one long after", ({ title, tracks }) =>
      Effect.gen(function* () {
        yield* title.agentRenaming("ses_a", "The agent's")
        yield* title.renamed("ses_a", "The owner's")
        expect(pinned(tracks, "ses_a")).toEqual(Option.some(true))
        yield* title.agentRenaming("ses_b", "The agent's")
        yield* TestClock.adjust(10 * MINUTE)
        yield* title.renamed("ses_b", "The agent's")
        expect(pinned(tracks, "ses_b")).toEqual(Option.some(true))
      }),
  )

  scenario("a subagent's session is never retitled, nor kept", ({ world, title, tracks }) =>
      Effect.gen(function* () {
        world.seats.set("ses_child", { serves: true, child: true, running: false })
        yield* title.renamed("ses_child", "implementor auto-title r1")
        yield* TestClock.adjust(60 * MINUTE)
        yield* turns(title, "ses_child", 10)
        yield* title.compacted("ses_child").pipe(Effect.andThen(settle))
        expect(world.asked).toEqual([])
        expect(tracks.has("ses_child")).toBe(false)
      }),
  )

  scenario("a busy session is not retitled until it is idle again", ({ world, title }) =>
      Effect.gen(function* () {
        yield* generated(title, "ses_root")
        yield* TestClock.adjust(30 * MINUTE)
        world.seats.set("ses_root", { serves: true, child: false, running: true })
        yield* turns(title, "ses_root", 6)
        expect(world.asked).toEqual([])
        world.seats.set("ses_root", { serves: true, child: false, running: false })
        yield* title.stopped("ses_root").pipe(Effect.andThen(settle))
        expect(world.asked).toEqual(["ses_root"])
      }),
  )

  scenario("another location's copy leaves the session alone", ({ world, title, tracks }) =>
      Effect.gen(function* () {
        world.seats.set("ses_far", { serves: false, child: false, running: false })
        yield* title.renamed("ses_far", "Elsewhere")
        yield* TestClock.adjust(60 * MINUTE)
        yield* turns(title, "ses_far", 10)
        expect(world.asked).toEqual([])
        expect(tracks.has("ses_far")).toBe(false)
      }),
  )

  scenario("a failed request is silent, and is not asked again before the next window", ({ world, title }) =>
      Effect.gen(function* () {
        world.failing.add("ses_root")
        yield* generated(title, "ses_root")
        yield* TestClock.adjust(30 * MINUTE)
        yield* turns(title, "ses_root", 6)
        expect(world.asked).toEqual(["ses_root"])
        yield* turns(title, "ses_root", 3)
        expect(world.asked).toEqual(["ses_root"])
      }),
  )

  effectTest(
    "copies sharing the host's lock make one title request at a time",
      Effect.scoped(
        Effect.gen(function* () {
          const world = host()
          const tracks = new Map<string, Track>()
          const lock = Semaphore.makeUnsafe(1)
          const here = yield* copy(world, lock, tracks)
          const there = yield* copy(world, lock, tracks)
          const gate = yield* Deferred.make<void>()
          world.gate.held = Option.some(gate)
          yield* generated(here, "ses_a")
          yield* generated(there, "ses_b")
          yield* TestClock.adjust(30 * MINUTE)
          yield* turns(here, "ses_a", 6)
          yield* turns(there, "ses_b", 6)
          // A second idle of a session waiting for its title asks nothing more.
          yield* turns(here, "ses_a", 1)
          expect(world.asked).toEqual(["ses_a"])
          world.gate.held = Option.none()
          yield* Deferred.succeed(gate, void 0)
          yield* settle
          expect(world.asked).toEqual(["ses_a", "ses_b"])
          expect(pinned(tracks, "ses_b")).toEqual(Option.some(false))
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    LIMIT,
  )
})
