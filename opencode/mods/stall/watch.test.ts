import { describe, expect, test } from "bun:test"
import { DEFAULTS, expired, initial, type Settings, type Step, stem, step, type Tick, type Watch } from "./watch.ts"

const settings: Settings = { ...DEFAULTS, thresholdMs: 2_000, windowMs: 30_000, captureMs: 10_000, cooldownMs: 600_000, keep: 2 }
const WALL = Date.UTC(2026, 10, 12, 16, 50, 12, 345)

const tick = (now: number, lagMs = 0, rss = 100, rssBefore = 100): Tick => ({ now, wall: WALL + now, lagMs, rss, rssBefore })

/** The steps of running `ticks` in order from a fresh watch at 0, by tag. */
const run = (ticks: ReadonlyArray<Tick>, from: Watch = initial(0)) => {
  let watch = from
  const steps: Array<Step> = []
  for (const each of ticks) {
    const [next, decided] = step(watch, each, settings)
    watch = next
    steps.push(decided)
  }
  return { watch, steps, tags: steps.map((decided) => decided._tag) }
}

describe("the stall rule", () => {
  test("a lag under the threshold is no stall: the window only rotates when it is old", () => {
    const { tags } = run([tick(250, 1_999), tick(29_999, 1_500), tick(30_000, 0), tick(30_250, 0)])
    expect(tags).toEqual(["Wait", "Wait", "Rotate", "Wait"])
  })

  test("a lag at the threshold begins a capture with the RSS around it, and finishes it captureMs later", () => {
    const { steps, tags } = run([tick(5_000, 2_000, 900, 300), tick(10_000, 0), tick(14_999, 0), tick(15_000, 0)])
    expect(tags).toEqual(["Begin", "Wait", "Wait", "Finish"])
    const stall = { at: WALL + 5_000, lagMs: 2_000, rssBefore: 300, rssAfter: 900 }
    expect(steps[0]).toMatchObject({ stall })
    expect(steps[3]).toMatchObject({ stall })
  })

  test("a capture's window is never rotated, and a stall inside it is no second capture", () => {
    const { tags } = run([tick(29_000, 3_000), tick(31_000, 0), tick(35_000, 5_000), tick(39_000, 0)])
    expect(tags).toEqual(["Begin", "Wait", "Wait", "Finish"])
  })

  test("a stall inside the cooldown is skipped, saying when the next capture may be taken", () => {
    const { steps, tags } = run([tick(1_000, 3_000), tick(11_000, 0), tick(100_000, 4_000)])
    expect(tags).toEqual(["Begin", "Finish", "Skip"])
    expect(steps[2]).toMatchObject({ lagMs: 4_000, nextMs: 501_000 })
  })

  test("once the cooldown is over, a stall is captured again", () => {
    const { tags } = run([tick(1_000, 3_000), tick(11_000, 0), tick(601_000, 2_500)])
    expect(tags).toEqual(["Begin", "Finish", "Begin"])
  })

  test("after a capture the next window starts when it is written", () => {
    const { tags } = run([tick(1_000, 3_000), tick(11_000, 0), tick(40_999, 0), tick(41_000, 0)])
    expect(tags).toEqual(["Begin", "Finish", "Wait", "Rotate"])
  })
})

describe("capture names", () => {
  test("a stem names the time (UTC, sortable), the lag and the process", () => {
    expect(stem({ at: WALL, lagMs: 5_321.4, rssBefore: 0, rssAfter: 0 }, 372_440)).toBe("stall-20261112T165012345Z-5321ms-372440")
  })

  test("only the newest captures stay, each with all its files; other files are never touched", () => {
    const names = [
      "stall-20261112T100000000Z-3000ms-1.cpuprofile",
      "stall-20261112T100000000Z-3000ms-1.json",
      "stall-20261112T120000000Z-2500ms-1.cpuprofile",
      "stall-20261112T120000000Z-2500ms-1.json",
      "stall-20261112T110000000Z-9000ms-2.cpuprofile",
      "opencode.log",
      "cpu-1-2026.cpuprofile",
      "stall-notes",
    ]
    expect(expired(names, 2)).toEqual(["stall-20261112T100000000Z-3000ms-1.cpuprofile", "stall-20261112T100000000Z-3000ms-1.json"])
    expect(expired(names, 5)).toEqual([])
  })
})
