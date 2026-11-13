// The rule order of `verdict` (owed.ts), over every pair of how long a step waited and when the load was
// last read at or past the cores: a land that finds the settle window quiet runs the step as a plain run,
// even when it has waited past MAX_WAIT; only a land with a loaded reading in the window and the max wait
// behind it forces one; the minute check never forces.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Duration, Option } from "effect"
import { LOADED_EVERY, MAX_WAIT, pays, phase, SETTLE, verdict, type OwedPostLand, type Phase, type Readings, type Trigger, type Verdict } from "./owed.ts"

const MINUTE = Duration.toMillis(Duration.minutes(1))
const NOW = 1_000 * 24 * 60 * MINUTE
const maxWait = Duration.toMinutes(MAX_WAIT)
const settle = Duration.toMinutes(SETTLE)

/** A step first owed `waited` minutes before NOW. */
const owedFor = (waited: number): OwedPostLand => ({
  source: "/code/app",
  main: "main",
  command: "bun scripts/post-land.ts",
  sessionID: "ses_1",
  lands: [{ base: "base0", head: "h1", units: [{ path: "/code/.rifts/app/l1", branch: "l/l1" }], at: NOW - waited * MINUTE }],
})

/** How long the step waited, in minutes: either side of the max wait. */
const waits = [0, 1, settle, 60, maxWait - 1, maxWait, maxWait + 1, maxWait * 2]
/** How long ago the newest reading at or past the cores was, in minutes; none for never. */
const loadedAgo: ReadonlyArray<Option.Option<number>> = [Option.none(), ...[0, 1, settle - 1, settle, settle + 1, 60, maxWait + 10].map(Option.some)]
/** How long the readings have stayed under the cores, in minutes; none after a loaded reading or a restart. */
const calmFor: ReadonlyArray<Option.Option<number>> = [Option.none(), ...[0, settle - 1, settle, 60].map(Option.some)]

const readingsOf = (loaded: Option.Option<number>, calm: Option.Option<number>): Readings => ({
  loadedAt: Option.map(loaded, (ago) => NOW - ago * MINUTE),
  calmSince: Option.map(calm, (ago) => NOW - ago * MINUTE),
})

/** A land's verdict, spelled out apart from owed.ts: quiet first, then the max wait. */
const landExpected = (waited: number, loaded: Option.Option<number>): Verdict => {
  if (!Option.exists(loaded, (ago) => ago < settle)) return "run"
  if (waited >= maxWait) return "forced"
  return "defer"
}

/** The minute check's verdict: its own readings calm for the whole settle window and none at or past the cores in it from any reader (another plugin instance's, kept with the owed steps), else still owed. */
const checkExpected = (calm: Option.Option<number>, loaded: Option.Option<number>): Verdict => {
  if (Option.exists(calm, (ago) => ago >= settle) && !Option.exists(loaded, (ago) => ago < settle)) return "run"
  return "defer"
}

const pairs = waits.flatMap((waited) => loadedAgo.flatMap((loaded) => calmFor.map((calm) => ({ waited, loaded, calm }))))

describe("verdict", () => {
  test("a land runs the step whenever no reading in the settle window was at or past the cores, however long it waited; it forces one only past the max wait with such a reading", () => {
    const wrong = pairs.flatMap(({ waited, loaded, calm }) => {
      const expected = landExpected(waited, loaded)
      const got = verdict(owedFor(waited), readingsOf(loaded, calm), NOW, "land")
      if (got === expected) return []
      return [{ waited, loaded: Option.getOrNull(loaded), calm: Option.getOrNull(calm), expected, got }]
    })
    expect(wrong).toEqual([])
  })

  test("a calm land after the max wait is a plain run, not a forced one", () => {
    expect(verdict(owedFor(maxWait + 10), readingsOf(Option.some(settle + 1), Option.some(1)), NOW, "land")).toBe("run")
    expect(verdict(owedFor(maxWait + 10), readingsOf(Option.none(), Option.none()), NOW, "land")).toBe("run")
  })

  test("the minute check runs the step once the readings stayed calm for the settle window, and never forces it", () => {
    const wrong = pairs.flatMap(({ waited, loaded, calm }) => {
      const expected = checkExpected(calm, loaded)
      const got = verdict(owedFor(waited), readingsOf(loaded, calm), NOW, "settled")
      if (got === expected) return []
      return [{ waited, loaded: Option.getOrNull(loaded), calm: Option.getOrNull(calm), expected, got }]
    })
    expect(wrong).toEqual([])
  })
})

/** How long ago the step's last run ended, in minutes; none for never. */
const ranAgo: ReadonlyArray<Option.Option<number>> = [Option.none(), ...[0, 1, 29, 30, 31, 120, maxWait].map(Option.some)]
const loadedEvery = Duration.toMinutes(LOADED_EVERY)

/** A step owed `waited` minutes whose last run ended `ran` minutes before NOW. */
const owedRan = (waited: number, ran: Option.Option<number>): OwedPostLand =>
  Option.match(ran, { onNone: () => owedFor(waited), onSome: (ago) => ({ ...owedFor(waited), ranAt: NOW - ago * MINUTE }) })

/** What a phase breaks, spelled out apart from owed.ts. */
const phaseProblems = (trigger: Trigger, got: Phase, was: Verdict, ran: Option.Option<number>): ReadonlyArray<string> => {
  const recent = Option.exists(ran, (ago) => ago < loadedEvery)
  return [
    [trigger === "land" && got === "wait", "a land left the step unrun"],
    [was !== "defer" && got !== was, `today's ${was} became ${got}`],
    [was === "defer" && pays(got), `a deferred step ran ${got}, which pays it`],
    [trigger === "settled" && got === "loaded" && recent, "the minute check ran it loaded within LOADED_EVERY of its last run"],
    [trigger === "settled" && was === "defer" && got === "wait" && !recent, "the minute check left it past LOADED_EVERY"],
    [got === "loaded" && pays(got), "a loaded run pays the step"],
  ].flatMap(([broken, what]) => Arr.filter([String(what)], () => broken === true))
}

describe("phase", () => {
  test("over the whole domain (trigger, the readings, how long owed, how long since its last run): a land always runs the step, a deferred one only loaded, which never pays; the minute check runs it loaded only past LOADED_EVERY since its last run; today's run and forced unchanged", () => {
    const wrong = pairs.flatMap(({ waited, loaded, calm }) =>
      ranAgo.flatMap((ran) =>
        (["land", "settled"] as const).flatMap((trigger) => {
          const owed = owedRan(waited, ran)
          const readings = readingsOf(loaded, calm)
          const got = phase(owed, readings, NOW, trigger)
          const problems = phaseProblems(trigger, got, verdict(owed, readings, NOW, trigger), ran)
          return problems.map((problem) => ({ trigger, waited, loaded: Option.getOrNull(loaded), calm: Option.getOrNull(calm), ran: Option.getOrNull(ran), got, problem }))
        }),
      ),
    )
    expect(wrong).toEqual([])
    expect([pays("run"), pays("forced"), pays("loaded"), pays("wait")]).toEqual([true, true, false, false])
  })

  test("generated: on a host loaded for hours, the minute check starts a loaded run no more than once per LOADED_EVERY, counted from each run's end", () => {
    const wrong = Array.from({ length: 200 }, (_, seed) => seed).flatMap((seed) => {
      const draw = drawer(seed)
      const readings: Readings = { loadedAt: Option.some(0), calmSince: Option.none() }
      const starts: Array<number> = []
      const first = owedFor(0)
      let owed: OwedPostLand = { ...first, lands: [{ ...first.lands[0], at: 0 }] }
      let busyUntil = Option.none<number>()
      for (let minute = 1; minute <= maxWait; minute++) {
        const now = minute * MINUTE
        // Never while a run holds the claim (`holdIfFree`): the run in hand ends first.
        if (Option.exists(busyUntil, (end) => end > now)) continue
        const loadedNow: Readings = { ...readings, loadedAt: Option.some(now) }
        if (phase(owed, loadedNow, now, "settled") !== "loaded") continue
        starts.push(minute)
        const end = now + Math.floor(draw() * 10) * MINUTE
        busyUntil = Option.some(end)
        owed = { ...owed, ranAt: end }
      }
      const gaps = Arr.zip(starts, starts.slice(1)).map(([before, after]) => ({ seed, start: after, gap: after - before }))
      // The first start is at minute 1 (it never ran), and the runs go on all day.
      const course = Arr.filter([{ seed, start: starts[0], runs: starts.length }], () => starts[0] !== 1 || starts.length < maxWait / (loadedEvery + 10))
      return [...course, ...gaps.filter((each) => each.gap < loadedEvery)]
    })
    expect(wrong).toEqual([])
  })
})

/** A seeded generator of numbers in [0, 1) (mulberry32). */
const drawer = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}
