// The staleness sweep (`../fresh.ts`) at its seam: a pass over the memory
// store and a stand-in host, on the test clock. It checks which sessions hear
// a note and when, what the note says, and that the queue never changes.
import { describe, expect } from "bun:test"
import { Array as Arr, Clock, Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { Freshness, layer as freshness, PER_PASS } from "../fresh.ts"
import type { ItemInput } from "../item.ts"
import { layer as queues, QueueModel } from "../model.ts"
import { type Lost, NoteRefused, QueueHost, type Root } from "../service.ts"
import type { Linked } from "../stale.ts"
import * as MemoryDigest from "@dotfiles/opencode-digest/memory/log"
import * as MemoryStore from "./store.ts"

const T0 = Date.parse("2026-11-18T08:00:00Z")
const HOUR = 60 * 60_000
const TIMEOUT_MS = 5_000

interface Noted {
  readonly sessionID: string
  readonly text: string
  readonly description: string
  readonly wake: boolean
}

/** The stand-in host: what it answers, and the notes it took. */
interface World {
  roots: ReadonlyArray<Root>
  readonly linked: Map<string, Linked>
  wakes: Option.Option<ReadonlyMap<string, ReadonlyArray<string>>>
  questions: Option.Option<ReadonlyMap<string, number>>
  refuse: boolean
  readonly notes: Array<Noted>
  /** What orchestrate answers of lost work for a session and the commits its queue names; none without orchestrate. */
  lost: (sessionID: string, hashes: ReadonlyArray<string>) => Option.Option<Lost>
  /** Each ask of orchestrate, in order. */
  readonly asked: Array<readonly [string, ReadonlyArray<string>]>
}

const worldOf = (): World => ({ roots: [], linked: new Map(), wakes: Option.some(new Map()), questions: Option.some(new Map()), refuse: false, notes: [], lost: () => Option.none(), asked: [] })

const hostOf = (world: World) =>
  Layer.succeed(
    QueueHost,
    QueueHost.of({
      roots: Effect.sync(() => world.roots),
      linked: (sessionID) => Effect.sync(() => Option.fromNullishOr(world.linked.get(sessionID))),
      wakes: () => Effect.sync(() => world.wakes),
      questions: () => Effect.sync(() => world.questions),
      lost: (sessionID, hashes) =>
        Effect.sync(() => {
          world.asked.push([sessionID, hashes])
          return world.lost(sessionID, hashes)
        }),
      note: (sessionID, text, description, wake) =>
        Effect.suspend(() => {
          if (world.refuse) return Effect.fail(new NoteRefused({ sessionID, message: "the host said no" }))
          world.notes.push({ sessionID, text, description, wake })
          return Effect.void
        }),
    }),
  )

/** A test on a fresh store and the stand-in host, its clock at T0. */
const sweepTest = <A, E>(name: string, body: (world: World) => Effect.Effect<A, E, Freshness | QueueModel>) => {
  const world = worldOf()
  effectTest(
    name,
    TestClock.setTime(T0).pipe(
      Effect.andThen(body(world)),
      Effect.provide(Layer.merge(freshness, queues).pipe(Layer.provide(Layer.mergeAll(MemoryStore.layer(MemoryStore.empty()), hostOf(world), MemoryDigest.writer())))),
      Effect.provide(TestClock.layer()),
    ),
    TIMEOUT_MS,
  )
}

const sweep = Freshness.use((fresh) => fresh.sweep)
const write = (sessionID: string, upsert: ReadonlyArray<ItemInput>, remove: ReadonlyArray<string> = []) =>
  QueueModel.use((queue) => queue.change(sessionID, { upsert, remove }))
const get = (sessionID: string) => QueueModel.use((queue) => queue.get(sessionID))
const later = (ms: number) => TestClock.adjust(ms)
/** Every root as active now, idle unless named busy. */
const active = (world: World, ids: ReadonlyArray<string>, busy: ReadonlyArray<string> = []) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => {
      world.roots = ids.map((id) => ({ id, busy: busy.includes(id), updated: now }))
    }),
  )
const texts = (world: World) => world.notes.map((note) => note.text).join("\n")

const plan: ReadonlyArray<ItemInput> = [
  { id: "impl", text: "Implement the unit", state: "running", session: "ses_impl" },
  { id: "review", text: "Andrew's review", state: "waiting", owner: "other", who: "Andrew" },
]

describe("the sweep", () => {
  sweepTest("a queue with nothing stale hears nothing", (world) =>
    Effect.gen(function* () {
      yield* write("ses_root", plan)
      world.linked.set("ses_impl", { state: "busy" })
      yield* active(world, ["ses_root"])
      expect(yield* sweep).toEqual([])
      expect(world.notes).toEqual([])
    }),
  )

  sweepTest(
    "stale items bring one note naming each with why: an idle session is woken, a busy one reads it at its next turn; the queue is left as it was",
    (world) =>
      Effect.gen(function* () {
        yield* write("ses_idle", plan)
        yield* write("ses_busy", [{ id: "login", text: "Log into the bank", state: "needs-you" }])
        world.linked.set("ses_impl", { state: "idle", since: T0 + HOUR, outcome: Option.some("succeeded") })
        world.questions = Option.some(new Map([["ses_busy", 0]]))
        yield* later(7 * HOUR)
        yield* active(world, ["ses_idle", "ses_busy"], ["ses_busy"])
        const before = [yield* get("ses_idle"), yield* get("ses_busy")]
        expect(yield* sweep).toEqual([
          { sessionID: "ses_idle", stale: ["impl", "review"], open: 2, woke: true },
          { sessionID: "ses_busy", stale: ["login"], open: 1, woke: false },
        ])
        expect(world.notes.map((note) => [note.sessionID, note.wake, note.description])).toEqual([
          ["ses_idle", true, "Queue check: 2 stale of 2 open"],
          ["ses_busy", false, "Queue check: 1 stale of 1 open"],
        ])
        expect(texts(world)).toContain("- impl [running]: Implement the unit (its session ses_impl ended (succeeded) at 2026-11-18 09:00 UTC)")
        expect(texts(world)).toContain("- review [waiting]: Andrew's review (untouched for 7 h)")
        expect(texts(world)).toContain("- login [needs-you]: Log into the bank (no ask_user_async question of yours is open")
        expect([yield* get("ses_idle"), yield* get("ses_busy")]).toEqual(before)
      }),
  )

  sweepTest("a session hears at most one note an hour, the same ask again only after six, and a restated item drops out", (world) =>
    Effect.gen(function* () {
      yield* write("ses_root", [...plan, { id: "docs", text: "Write the docs", state: "next" }])
      yield* later(7 * HOUR)
      yield* active(world, ["ses_root"])
      expect((yield* sweep).map((noted) => noted.stale)).toEqual([["impl", "review", "docs"]])
      // Within the hour: nothing, whatever changed.
      yield* write("ses_root", [], ["docs"])
      yield* later(HOUR - 1)
      expect(yield* sweep).toEqual([])
      // Restating an item marks it checked without a new revision; the ask changed, so an hour on it is sent.
      const revision = (yield* get("ses_root")).revision
      yield* write("ses_root", [{ id: "review", state: "waiting" }])
      expect((yield* get("ses_root")).revision).toBe(revision)
      yield* later(1)
      yield* active(world, ["ses_root"])
      expect((yield* sweep).map((noted) => noted.stale)).toEqual([["impl"]])
      // The same ask: not after one hour, again after six.
      yield* later(HOUR)
      yield* active(world, ["ses_root"])
      expect(yield* sweep).toEqual([])
      yield* later(5 * HOUR)
      yield* active(world, ["ses_root"])
      expect((yield* sweep).map((noted) => noted.stale)).toEqual([["impl", "review"]])
      expect(world.notes).toHaveLength(3)
    }),
  )

  sweepTest("a monitor seen pending and pending no more makes the item naming it stale", (world) =>
    Effect.gen(function* () {
      yield* write("ses_root", [{ id: "ci", text: "Wait for CI", state: "waiting", detail: "monitor w0ab12c" }])
      world.wakes = Option.some(new Map([["ses_root", ["w0ab12c"]]]))
      yield* active(world, ["ses_root"])
      expect(yield* sweep).toEqual([])
      world.wakes = Option.some(new Map([["ses_root", []]]))
      expect((yield* sweep).map((noted) => noted.stale)).toEqual([["ci"]])
      expect(texts(world)).toContain("(the wake or monitor w0ab12c it names is no longer pending)")
    }),
  )

  sweepTest("past the cap the note asks to collapse the queue", (world) =>
    Effect.gen(function* () {
      yield* write(
        "ses_root",
        Arr.makeBy(26, (index) => ({ id: `i${index}`, text: `Item ${index}`, state: "next" })),
      )
      yield* active(world, ["ses_root"])
      expect(yield* sweep).toEqual([{ sessionID: "ses_root", stale: [], open: 26, woke: true }])
      expect(texts(world)).toContain("Your queue holds 26 open items, more than 25: collapse them")
    }),
  )

  sweepTest(
    `one pass sends at most ${PER_PASS} notes, newest sessions first; a session quiet for a day is left alone, and a refused note is sent again`,
    (world) =>
      Effect.gen(function* () {
        const ids = ["ses_1", "ses_2", "ses_3", "ses_4", "ses_old"]
        yield* Effect.forEach(ids, (id) => write(id, [{ id: "x", text: "X", state: "next" }]))
        yield* later(25 * HOUR)
        yield* active(world, ids)
        world.roots = [...world.roots.filter((root) => root.id !== "ses_old"), { id: "ses_old", busy: false, updated: T0 }]
        world.refuse = true
        expect(yield* sweep).toEqual([])
        world.refuse = false
        expect((yield* sweep).map((noted) => noted.sessionID)).toEqual(["ses_1", "ses_2", "ses_3"])
        expect((yield* sweep).map((noted) => noted.sessionID)).toEqual(["ses_4"])
        expect(yield* sweep).toEqual([])
      }),
  )
})

describe("work not on the default branch, from orchestrate", () => {
  const WHY = "not on main: 2 commits not there, committed 9 h ago; land it, or mark it superseded or dropped"
  const ORPHAN = "/code/.work/app/orphan"
  const LINES = ["orchestrate: committed work not on main, nobody on it (1, oldest first):", `- ${ORPHAN} · 2 d · 2 commits · orphan work · no session known`, "Land each (orchestrate land), or end it …"]
  const answering = (world: World) => {
    world.lost = (_sessionID, hashes) => Option.some({ lines: LINES, keys: [ORPHAN], hashes: new Map(hashes.filter((hash) => hash === "c0ffee1").map((hash) => [hash, WHY])) })
  }

  sweepTest(
    "the note lists the item naming an unlanded commit and status's lanes nobody is on; restated, the item drops out; the same lanes are not asked again within six hours",
    (world) =>
      Effect.gen(function* () {
        answering(world)
        yield* write("ses_root", [
          { id: "land", text: "land c0ffee1 after review", state: "next" },
          { id: "ok", text: "watch abc1234 deploy", state: "waiting", owner: "other" },
        ])
        yield* active(world, ["ses_root"])
        expect(yield* sweep).toEqual([{ sessionID: "ses_root", stale: ["land"], open: 2, woke: true }])
        expect(world.asked).toEqual([["ses_root", ["c0ffee1", "abc1234"]]])
        expect(world.notes.map((note) => note.description)).toEqual(["Queue check: 1 stale of 2 open, 1 not on main"])
        expect(texts(world).split("\n").slice(1, 6)).toEqual(["This item looks stale:", `- land [next]: land c0ffee1 after review (it names commit c0ffee1, ${WHY})`, ...LINES])
        // Within the hour nothing is asked, of the queue or of orchestrate.
        yield* later(HOUR - 1)
        expect(yield* sweep).toEqual([])
        expect(world.asked).toHaveLength(1)
        // The orchestrator restates the item: it is not named again; the lanes are, as their own ask, once.
        yield* write("ses_root", [{ id: "land", state: "next" }])
        yield* later(1)
        yield* active(world, ["ses_root"])
        expect(yield* sweep).toEqual([{ sessionID: "ses_root", stale: [], open: 2, woke: true }])
        expect(world.notes.at(-1)?.text).not.toContain("- land [next]")
        expect(world.notes.at(-1)?.text).toContain(LINES[1])
        yield* later(HOUR)
        yield* active(world, ["ses_root"])
        expect(yield* sweep).toEqual([])
        // Three hours on (before the items are six hours untouched): still no repeat of the same lanes.
        yield* later(3 * HOUR)
        yield* active(world, ["ses_root"])
        expect(yield* sweep).toEqual([])
        expect(world.notes).toHaveLength(2)
      }),
  )

  sweepTest("without orchestrate's answer the sweep is as before: an item naming a commit is not stale for it", (world) =>
    Effect.gen(function* () {
      yield* write("ses_root", [{ id: "land", text: "land c0ffee1", state: "next" }])
      yield* active(world, ["ses_root"])
      expect(yield* sweep).toEqual([])
      expect(world.asked).toEqual([["ses_root", ["c0ffee1"]]])
    }),
  )
})
