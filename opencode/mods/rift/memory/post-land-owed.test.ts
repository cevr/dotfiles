// The model-based test of owed post-land steps (../owed.ts, run by ../model.ts): generated sequences of
// lands, load readings, clock steps and server restarts, on a TestClock, against the handler over memory.
// A post-land step runs for some minutes of its own; the test checks, at each run's start and end, that
// two never run at once, that each run is the newest land's (so a superseded step never runs), that no
// land's step runs twice or after a newer one ran, and that none runs unless every load reading the tool
// took in the settle window before it (a land's, the minute check's, a server's before a restart) was under
// the cores, or the oldest unpaid land has waited the max wait; that a run's report says the land ran it
// whatever the load exactly when such a reading was in that window; and, once the load is calm long enough, that
// the newest land's step ran exactly once and nothing is owed. A restart keeps the owed steps: the same
// memory World serves the next tool, as the file does a restarted server. A server runs INSTANCES tools at
// once over the one World, as OpenCode loads the rift plugin once per directory it serves, each with its own
// minute check: every Git step in the post-land Rift runs under the host's post-land claim, and each run
// wakes the root once.
import { describe, expect, test } from "bun:test"
import { Clock, Context, Data, Deferred, Duration, Effect, Exit, Layer, Option, Scope } from "effect"
import { TestClock } from "effect/testing"
import * as MemoryDebts from "./debts.ts"
import * as MemoryLanding from "./landing.ts"
import * as MemoryNotices from "./notices.ts"
import * as MemoryRifts from "./rifts.ts"
import * as MemorySessionDirectories from "./session-directories.ts"
import * as MemoryWorkbox from "./workbox.ts"
import * as Model from "../model.ts"
import { Landing } from "../service.ts"
import { CHECK_EVERY, MAX_WAIT, SETTLE } from "../owed.ts"

const SOURCE = "/code/app"
const POST_LAND = "/code/.rifts/app/post-land"
const CORES = 12
/** The rift plugin instances one server runs at once. */
const INSTANCES = 3
const MINUTE = Duration.toMillis(Duration.minutes(1))

/** What the generated sequence does next. */
type Op = Data.TaggedEnum<{
  Land: {}
  Load: { readonly load: number }
  Wait: { readonly minutes: number }
  Restart: {}
}>
const Op = Data.taggedEnum<Op>()

/** A seeded generator of numbers in [0, 1) (mulberry32), so a failing sequence is named by its seed. */
const generator = (seed: number) => {
  const state = { value: seed >>> 0 }
  return () => {
    state.value = (state.value + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/** A whole number in [low, high]. */
const between = (next: () => number, low: number, high: number): number => low + Math.floor(next() * (high - low + 1))

/** A load reading: calm (under the cores) or loaded (at or past them), loaded about half the time. */
const loadReading = (next: () => number): number => {
  if (next() < 0.5) return between(next, 0, CORES - 1) + 0.5
  return between(next, CORES, CORES * 4)
}

/** How long a wait lasts: mostly minutes, sometimes an hour, now and then past the max wait. */
const waitMinutes = (next: () => number): number => {
  const roll = next()
  if (roll < 0.7) return between(next, 1, 8)
  if (roll < 0.96) return between(next, 9, 60)
  return between(next, 300, 420)
}

const generate = (seed: number, length: number): ReadonlyArray<Op> => {
  const next = generator(seed)
  return Array.from({ length }, (): Op => {
    const roll = next()
    if (roll < 0.3) return Op.Land()
    if (roll < 0.42) return Op.Load({ load: loadReading(next) })
    if (roll < 0.92) return Op.Wait({ minutes: waitMinutes(next) })
    return Op.Restart()
  })
}

/** What the test saw, against which each run is judged. */
interface Seen {
  /** Each land's pushed head and when, in order. */
  readonly landed: Array<{ readonly head: string; readonly at: number }>
  /** Each run's head as it started. */
  readonly started: Array<string>
  /** The minute each run started at. */
  readonly startedAt: Array<number>
  /** Each run's head as it ended, uninterrupted. */
  readonly completed: Array<string>
  /** The runs going now. */
  running: number
  /** The runs started while the load was at or past the cores. */
  forced: number
  /** For each run that ended, in order: whether a reading in the settle window before its start was at or past the cores. */
  readonly completedForced: Array<boolean>
  readonly violations: Array<string>
}

/** The newest land whose step has run to its end, by index; -1 for none. */
const paidThrough = (seen: Seen): number => Math.max(-1, ...seen.completed.map((head) => seen.landed.findIndex((land) => land.head === head)))

/** The world one sequence acts on, kept across restarts. */
const worldOf = (next: () => number) => {
  const rifts = MemoryRifts.world([SOURCE])
  const landing = MemoryLanding.world({ [SOURCE]: MemoryLanding.config("main", "bun run gate", "bun run accept", { postLand: "bun scripts/post-land.ts" }) })
  landing.load = { load: 1, cores: CORES }
  landing.headOf = (push) => `h${push}`
  const debts = MemoryDebts.world()
  const woken: Array<MemoryNotices.Woken> = []
  const seen: Seen = { landed: [], started: [], startedAt: [], completed: [], running: 0, forced: 0, completedForced: [], violations: [] }
  /** Each running step's end, which the clock steps release. */
  const holds: Array<{ readonly end: number; readonly done: Deferred.Deferred<void> }> = []
  landing.postLandHold = Effect.gen(function* () {
    const head = String(landing.steps.at(-1)).split(" ")[3]
    const now = yield* Clock.currentTimeMillis
    const violation = (what: string) => seen.violations.push(`${what} (run of ${head} at minute ${now / MINUTE})`)
    if (seen.running > 0) violation("two post-land steps at once")
    const newest = Option.fromNullishOr(seen.landed.at(-1))
    if (Option.exists(newest, (land) => land.head !== head)) violation("not the newest land's step")
    if (seen.completed.includes(head)) violation("a step that already ran")
    if (seen.landed.findIndex((land) => land.head === head) <= paidThrough(seen)) violation("a step a newer run had paid")
    // The settle window: every load reading the tool took in the SETTLE before this run (from a land, the
    // minute check, or a server before a restart) was under the cores, else this is the max wait's run.
    const loadedLately = landing.readings.some((reading) => reading.load.load >= reading.load.cores && now - reading.at < Duration.toMillis(SETTLE))
    if (loadedLately) {
      seen.forced += 1
      const oldest = Option.fromNullishOr(seen.landed[paidThrough(seen) + 1])
      if (!Option.exists(oldest, (land) => now - land.at >= Duration.toMillis(MAX_WAIT))) violation("a reading at or past the cores in the settle window before it, before the max wait")
    }
    seen.started.push(head)
    seen.startedAt.push(now / MINUTE)
    seen.running += 1
    const done = yield* Deferred.make<void>()
    holds.push({ end: now + between(next, 0, 4) * MINUTE, done })
    yield* Deferred.await(done).pipe(Effect.ensuring(Effect.sync(() => (seen.running -= 1))))
    seen.completed.push(head)
    seen.completedForced.push(loadedLately)
  })
  return { rifts, landing, debts, woken, seen, holds }
}
type World = ReturnType<typeof worldOf>

/** The memory Landing, where each Git step in the post-land Rift is a violation unless its caller holds the post-land claim. */
const claimedLanding = (world: World) =>
  Layer.effect(
    Landing,
    Effect.map(Effect.gen(function* () {
      return yield* Landing
    }), (landing) => {
      const inClaim = (step: string, path: string) =>
        Effect.sync(() => {
          if (path === POST_LAND && world.debts.held !== 1) world.seen.violations.push(`${step} in the post-land Rift outside the claim`)
        })
      return Landing.of({
        ...landing,
        start: (path, main) => Effect.andThen(inClaim("start", path), landing.start(path, main)),
        install: (path, previous) => Effect.andThen(inClaim("install", path), landing.install(path, previous)),
        postLand: (path, command, env) => Effect.andThen(inClaim("post-land", path), landing.postLand(path, command, env)),
      })
    }),
  ).pipe(Layer.provide(MemoryLanding.layer(world.landing)))

const toolLayer = (world: World) =>
  Model.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        MemoryRifts.layer(world.rifts),
        MemorySessionDirectories.layer({ ses_1: `${SOURCE}/src` }),
        claimedLanding(world),
        MemoryNotices.layer(world.woken),
        MemoryWorkbox.layer(false, []),
        MemoryDebts.layer(world.debts),
      ),
    ),
  )

/** Lets the tool's fibers run as far as they can without the clock. */
const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true })

/** A server's life: its scope, closed by a restart, and its INSTANCES tools, each with its own minute check. */
const boot = (world: World) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const tools = yield* Effect.forEach(Array.from({ length: INSTANCES }), () =>
      Effect.map(Layer.buildWithScope(toolLayer(world), scope), (services) => Context.get(services, Model.RiftTool)),
    )
    return { scope, tools }
  })

/** One minute at a time: the clock, then every run whose time is up ends. */
const pass = (world: World, minutes: number) =>
  Effect.forEach(
    Array.from({ length: minutes }),
    () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(CHECK_EVERY)
        const now = yield* Clock.currentTimeMillis
        yield* Effect.forEach(
          world.holds.filter((hold) => hold.end <= now),
          (hold) => Deferred.done(hold.done, Exit.void),
          { discard: true },
        )
        yield* settle
      }),
    { discard: true },
  )

/** Runs `ops` on a fresh world, then a calm stretch long enough for any owed step; answers the world. */
const play = (seed: number, ops: ReadonlyArray<Op>) =>
  Effect.gen(function* () {
    const world = worldOf(generator(seed ^ 0x5eed))
    const life = { current: yield* boot(world) }
    for (const op of ops) {
      switch (op._tag) {
        case "Land": {
          const name = `l${world.seen.landed.length + 1}`
          world.rifts.rifts.set(MemoryRifts.pathOf(SOURCE, name), MemoryRifts.clean(MemoryRifts.pathOf(SOURCE, name), `l/${name}`))
          // Each land through the next instance in turn.
          const tool = life.current.tools[world.seen.landed.length % INSTANCES]!
          const answer = yield* tool.run("ses_1", { action: "land", rifts: [name] }).pipe(Effect.map((done) => done.text))
          expect(answer).toStartWith("Landed 1 Rift(s) as one push")
          world.seen.landed.push({ head: `h${world.landing.pushes}`, at: yield* Clock.currentTimeMillis })
          yield* settle
          break
        }
        case "Load":
          world.landing.load = { load: op.load, cores: CORES }
          break
        case "Wait":
          yield* pass(world, op.minutes)
          break
        case "Restart":
          yield* Scope.close(life.current.scope, Exit.void)
          life.current = yield* boot(world)
          yield* settle
          break
      }
    }
    world.landing.load = { load: 1, cores: CORES }
    yield* pass(world, Duration.toMinutes(SETTLE) + 2 * Duration.toMinutes(CHECK_EVERY) + 6)
    yield* Scope.close(life.current.scope, Exit.void)
    return world
  }).pipe(Effect.provide(TestClock.layer()))

/** Every rule a played sequence keeps; the seed names the sequence that broke one. */
const judge = (seed: number, world: World) => {
  const newest = Option.fromNullishOr(world.seen.landed.at(-1))
  const ranNewest = Option.match(newest, { onNone: () => 1, onSome: (land) => world.seen.completed.filter((head) => head === land.head).length })
  expect({
    seed,
    violations: world.seen.violations,
    newestRuns: ranNewest,
    owed: world.debts.debts.owed.length,
    running: world.seen.running,
    saidForced: saidForced(world),
    notRun: described(world, "rift land · post-land did not run"),
    deferredPastLands: described(world, "rift land · post-land owed (load)") > world.seen.landed.length,
  }).toEqual({
    seed,
    violations: [],
    newestRuns: 1,
    owed: 0,
    running: 0,
    // One report per run that ended, from the one instance that ran it.
    saidForced: world.seen.completedForced,
    notRun: 0,
    deferredPastLands: false,
  })
}

/** How many wakes said `description`. */
const described = (world: World, description: string): number => world.woken.filter((woken) => woken.notice.description === description).length

/** The forced report's first words: a land ran the step past the max wait, whatever the load. */
const FORCED = "rift land: the post-land step was owed for "

/** For each report of a run that ended, in order: whether it says the land ran it whatever the load. */
const saidForced = (world: World): ReadonlyArray<boolean> =>
  world.woken
    .filter((woken) => woken.notice.description === "rift land · post-land ran" || woken.notice.description === "rift land · post-land failed")
    .map((woken) => woken.notice.text.startsWith(FORCED))

describe("an owed post-land step", () => {
  test("over generated lands, loads, clock steps and restarts: never two at once, only the newest land's, never under load before the max wait, and the newest runs exactly once once calm", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const totals = { forced: 0, restarts: 0, lands: 0 }
        for (const seed of Array.from({ length: 200 }, (_, index) => 1000 + index)) {
          const ops = generate(seed, 50)
          const world = yield* play(seed, ops)
          judge(seed, world)
          totals.forced += world.seen.forced
          totals.restarts += ops.filter((op) => op._tag === "Restart").length
          totals.lands += world.seen.landed.length
        }
        // The sequences reach every branch: lands, restarts, and steps run past the load at the max wait.
        expect(totals.forced).toBeGreaterThan(0)
        expect(totals.restarts).toBeGreaterThan(0)
        expect(totals.lands).toBeGreaterThan(100)
      }),
    ),
    // 200 sequences, each over INSTANCES tools: a few seconds, past bun's 5-second default under a busy host.
    60_000,
  )

  test("a step owed under load runs once the load has stayed calm for the settle window, read every minute, and survives a restart", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const ops: ReadonlyArray<Op> = [
          Op.Load({ load: 30 }),
          Op.Land(),
          Op.Wait({ minutes: 30 }),
          Op.Restart(),
          Op.Load({ load: 2 }),
          Op.Wait({ minutes: 3 }),
          Op.Load({ load: 20 }),
          Op.Wait({ minutes: 2 }),
          Op.Load({ load: 2 }),
          Op.Wait({ minutes: 5 }),
        ]
        const world = yield* play(1, ops)
        // Calm for 3 minutes, loaded, then calm again: the step waited for a whole settle window after the second calm.
        expect(world.seen.started).toEqual(["h1"])
        expect(world.seen.startedAt).toEqual([41])
        expect(world.woken.map((woken) => woken.notice.description).filter((description) => description.includes("post-land"))).toEqual([
          "rift land · post-land owed (load)",
          "rift land · post-land ran",
        ])
        expect(world.landing.steps.filter((step) => step.startsWith(`post-land ${POST_LAND}`))).toEqual([`post-land ${POST_LAND} base0 h1`])
        judge(1, world)
      }),
    ))

  test("a land that reads the load at or past the cores restarts the settle window for the minute check (round 1's M1)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const ops: ReadonlyArray<Op> = [
          Op.Load({ load: 30 }),
          Op.Land(), // minute 0: owed (h1)
          Op.Load({ load: 2 }),
          Op.Wait({ minutes: 4 }), // the checks at 1..4 read calm
          Op.Load({ load: 30 }),
          Op.Land(), // minute 4: the land reads 30 and defers (h2)
          Op.Load({ load: 2 }),
          Op.Wait({ minutes: 8 }),
        ]
        const world = yield* play(11, ops)
        // The last reading at or past the cores was the land's at minute 4: the step waits a whole window, to minute 9 or later.
        expect(world.seen.started).toEqual(["h2"])
        expect(world.seen.startedAt[0]).toBeGreaterThanOrEqual(9)
        judge(11, world)
      }),
    ))

  test("after a run, a land that reads the load at or past the cores waits a fresh settle window", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const ops: ReadonlyArray<Op> = [
          Op.Load({ load: 30 }),
          Op.Land(), // minute 0: owed (h1)
          Op.Load({ load: 2 }),
          Op.Wait({ minutes: 10 }), // calm from minute 1, runs at 6, ends by 10
          Op.Load({ load: 30 }),
          Op.Land(), // minute 10: the land reads 30 and defers (h2)
          Op.Load({ load: 2 }),
          Op.Wait({ minutes: 8 }),
        ]
        const world = yield* play(12, ops)
        expect(world.seen.started).toEqual(["h1", "h2"])
        expect(world.seen.startedAt[1]).toBeGreaterThanOrEqual(15)
        judge(12, world)
      }),
    ))

  test("a land past the max wait runs the step whatever the load, for every land owed, and says so", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const ops: ReadonlyArray<Op> = [Op.Load({ load: 40 }), Op.Land(), Op.Wait({ minutes: 200 }), Op.Land(), Op.Wait({ minutes: 170 }), Op.Land()]
        const world = yield* play(2, ops)
        expect(world.seen.started).toEqual(["h3"])
        expect(world.seen.forced).toBe(1)
        expect(world.woken.map((woken) => woken.notice.text.split("\n").slice(0, 2)).at(-1)).toEqual([
          "rift land: the post-land step was owed for 370 minutes, past the 6-hour wait, so this land ran it whatever the load (the 1-minute load is 40.0, at or past the host's 12 cores), nice'd like every check.",
          "rift land: the post-land step after l/l1, l/l2, l/l3 ran in 4s. Log: /logs/post-land.log",
        ])
        judge(2, world)
      }),
    ))

  test("a land past the max wait that finds the settle window calm runs the step as a plain run, and does not say it ran whatever the load", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const ops: ReadonlyArray<Op> = [
          Op.Load({ load: 40 }),
          Op.Land(), // minute 0: owed (h1)
          Op.Wait({ minutes: 366 }), // loaded the whole time: the minute check never runs it
          Op.Load({ load: 2 }),
          Op.Wait({ minutes: 3 }), // the last reading at or past the cores was at minute 366
          Op.Restart(), // the new server's readings start calm from scratch: the minute check waits a whole window
          Op.Wait({ minutes: 3 }),
          Op.Land(), // minute 372: owed past the max wait, and no reading in the last 5 minutes at or past the cores
        ]
        const world = yield* play(3, ops)
        expect(world.seen.started).toEqual(["h2"])
        expect(world.seen.forced).toBe(0)
        expect(world.woken.map((woken) => woken.notice.text.split("\n")[0]).at(-1)).toEqual("rift land: the post-land step after l/l1, l/l2 ran in 4s. Log: /logs/post-land.log")
        judge(3, world)
      }),
    ))

  test("a land past the max wait whose own reading is calm, after a reading at or past the cores, names that earlier reading (postland-order M1)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const ops: ReadonlyArray<Op> = [
          Op.Load({ load: 40 }),
          Op.Land(), // minute 0: owed (h1)
          Op.Wait({ minutes: 366 }), // loaded the whole time; the minute checks read 40 up to minute 366
          Op.Load({ load: 2 }),
          Op.Wait({ minutes: 2 }), // the checks at 367 and 368 read 2.0
          Op.Land(), // minute 368: its own reading is 2.0, the last at or past the cores 2 minutes ago
        ]
        const world = yield* play(4, ops)
        expect(world.seen.started).toEqual(["h2"])
        expect(world.seen.forced).toBe(1)
        expect(world.woken.map((woken) => woken.notice.text.split("\n")[0]).at(-1)).toEqual(
          "rift land: the post-land step was owed for 368 minutes, past the 6-hour wait, so this land ran it whatever the load (the 1-minute load is 2.0, but it was at or past the host's 12 cores 2 min ago), nice'd like every check.",
        )
        judge(4, world)
      }),
    ))

  test(`one owed step and ${INSTANCES} plugin instances, each with its minute check: one run, every Git step in the post-land Rift under the claim, one report`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const ops: ReadonlyArray<Op> = [Op.Load({ load: 30 }), Op.Land(), Op.Load({ load: 2 }), Op.Wait({ minutes: 10 })]
        const world = yield* play(5, ops)
        expect(world.seen.started).toEqual(["h1"])
        expect(world.landing.steps.filter((step) => step.includes(POST_LAND))).toEqual([`start ${POST_LAND} main`, `post-land ${POST_LAND} base0 h1`, `ended post-land ${POST_LAND}`])
        expect(world.woken.map((woken) => woken.notice.description).filter((description) => description.includes("post-land"))).toEqual([
          "rift land · post-land owed (load)",
          "rift land · post-land ran",
        ])
        judge(5, world)
      }),
    ))
})
