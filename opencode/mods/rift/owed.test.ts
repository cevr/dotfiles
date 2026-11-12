// The rule order of `verdict` (owed.ts), over every pair of how long a step waited and when the load was
// last read at or past the cores: a land that finds the settle window quiet runs the step as a plain run,
// even when it has waited past MAX_WAIT; only a land with a loaded reading in the window and the max wait
// behind it forces one; the minute check never forces.
import { describe, expect, test } from "bun:test"
import { Duration, Option } from "effect"
import { MAX_WAIT, SETTLE, verdict, type OwedPostLand, type Readings, type Verdict } from "./owed.ts"

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

/** The minute check's verdict: calm for the whole settle window, else still owed. */
const checkExpected = (calm: Option.Option<number>): Verdict => {
  if (Option.exists(calm, (ago) => ago >= settle)) return "run"
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
      const expected = checkExpected(calm)
      const got = verdict(owedFor(waited), readingsOf(loaded, calm), NOW, "settled")
      if (got === expected) return []
      return [{ waited, loaded: Option.getOrNull(loaded), calm: Option.getOrNull(calm), expected, got }]
    })
    expect(wrong).toEqual([])
  })
})
