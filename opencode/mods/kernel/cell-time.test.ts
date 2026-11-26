// Time in cells (law W6). The first group is the run's acceptance file
// (kernel-wake acceptance/time.test.ts), copied with its assertions as they
// are: the module imported directly and its seeded generator inlined. Each
// event is built by its schema's constructor, the share's flag compared as a
// boolean and the view's size read through its JSON codec: the same checks in
// the repo's style. The store and the notices are tested beside their
// adapter (opencode/cell-times.test.ts).
import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { CellTime, CellTimed, CellTimeNoticed, CellTimeState, HOUR, line, noticeDue, noticeText, reading, share, unwell, UNWELL_SHARE, answerOf, type Event } from "./cell-time.ts"

const stateJson = Schema.encodeSync(Schema.fromJsonString(CellTimeState))

/** A seeded generator (mulberry32): the same seed, the same run. */
const random = (seed: number) => {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (below: number) => Math.floor(next() * below), pick: <A>(items: ReadonlyArray<A>): A => items[Math.floor(next() * items.length)]! }
}

const fold = (events: ReadonlyArray<Event>) => events.reduce((state, event) => CellTime.evolve(state, event), CellTime.initial)
const timed = (session: string, startedAt: number, ms: number, waitedMs = ms) =>
  CellTimed.make({ session, startedAt, endedAt: startedAt + ms, waitedMs, computeMs: ms - waitedMs, cut: false })

describe("W6: time in cells is visible", () => {
  test("the stated share is 15% of an hour", () => expect(UNWELL_SHARE).toBe(0.15))

  test("the orchestrator's measured hour (56% in cells) is unwell; a root within the bound is not", () => {
    const now = 10 * HOUR
    const heavy = fold(Array.from({ length: 20 }, (_, index) => timed("ses_root", now - HOUR + index * 3 * 60_000, 101_000)))
    expect(share(heavy, "ses_root", now)).toBeCloseTo(0.561, 2)
    expect(unwell(heavy, "ses_root", now)._tag).toBe("Some")
    const light = fold(Array.from({ length: 30 }, (_, index) => timed("ses_root", now - HOUR + index * 2 * 60_000, 15_000)))
    expect(share(light, "ses_root", now)).toBeCloseTo(0.125, 3)
    expect(unwell(light, "ses_root", now)._tag).toBe("None")
  })

  test("only the part of a cell inside the hour counts, each session apart, and the share never leaves [0, 1]", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = random(seed)
      const now = 100 * HOUR
      const events: Array<ReturnType<typeof timed>> = []
      let at = now - 3 * HOUR
      // A session's cells never overlap: its calls run one at a time.
      while (at < now) {
        const ms = 1 + rng.int(20 * 60_000)
        events.push(timed(rng.pick(["ses_a", "ses_b"]), at, ms))
        at += ms + rng.int(10 * 60_000)
      }
      const state = fold(events)
      for (const session of ["ses_a", "ses_b"]) {
        const inside = events
          .filter((event) => event.session === session)
          .reduce((sum, event) => sum + Math.max(0, Math.min(event.endedAt, now) - Math.max(event.startedAt, now - HOUR)), 0)
        const got = share(state, session, now)
        expect(got, `seed ${seed}`).toBeCloseTo(inside / HOUR, 6)
        expect(got).toBeGreaterThanOrEqual(0)
        expect(got).toBeLessThanOrEqual(1)
        expect(Option.isSome(unwell(state, session, now)), `seed ${seed}`).toBe(got > 0.15)
      }
    }
  })

  test("the view forgets what is older than the hour: its size is bounded by the hour's cells, not the session's life", () => {
    const now = 1_000 * HOUR
    const state = fold(Array.from({ length: 5_000 }, (_, index) => timed("ses_root", index * 10 * 60_000, 1_000)))
    expect(stateJson(state).length).toBeLessThan(4_000)
    expect(share(state, "ses_root", now)).toBe(0)
  })
})

describe("the hour's reading", () => {
  test("a call queued behind the session's last one overlaps it, and the overlap counts once", () => {
    const now = 10 * HOUR
    const state = fold([timed("ses_root", now - 30 * 60_000, 10 * 60_000), timed("ses_root", now - 25 * 60_000, 10 * 60_000)])
    expect(share(state, "ses_root", now)).toBeCloseTo(15 / 60, 6)
    expect(reading(state, "ses_root", now).cells).toBe(2)
  })

  test("the line counts the hour's cells and cuts, and names the share in whole percent", () => {
    const now = 10 * HOUR
    const state = fold([
      { ...timed("ses_root", now - 50 * 60_000, 60_000), cut: true },
      ...Array.from({ length: 30 }, (_, index) => timed("ses_root", now - 40 * 60_000 + index * 60_000, 1_200)),
      timed("ses_root", now - 2 * HOUR, 10_000),
    ])
    expect(line(reading(state, "ses_root", now))).toBe("cells 3% of the last hour · 31 cells · 1 cut")
    expect(line({ share: 0, cells: 1, cut: 0 })).toBe("cells 0% of the last hour · 1 cell · 0 cut")
  })

  test("the notice names the three longest cells by their description", () => {
    const now = 10 * HOUR
    const named = (description: string, at: number, ms: number) => ({ ...timed("ses_root", at, ms), description })
    const state = fold([
      named("Run the gate", now - 50 * 60_000, 5 * 60_000),
      named("Wait for the land", now - 40 * 60_000, 8 * 60_000),
      timed("ses_root", now - 30 * 60_000, 6 * 60_000),
      named("Read a file", now - 20 * 60_000, 1_000),
    ])
    const read = Option.getOrThrow(unwell(state, "ses_root", now))
    expect(read.longest.map((cell) => cell.description)).toEqual(["Wait for the land", "(no description)", "Run the gate"])
    const text = noticeText(read)
    expect(text).toContain('"Wait for the land" 480 s')
    expect(text).toContain("over the 15% bound")
  })

  test("a session is told at most once an hour, however many cells it runs over the bound", () => {
    let state = CellTime.initial
    let told = 0
    const start = 10 * HOUR
    // Three hours of minute-long cells, back to back: unwell from the tenth minute on.
    for (let minute = 0; minute < 180; minute++) {
      const event = timed("ses_root", start + minute * 60_000, 60_000)
      state = CellTime.evolve(state, event)
      if (Option.isSome(noticeDue(state, "ses_root", event.endedAt))) {
        told++
        state = CellTime.evolve(state, CellTimeNoticed.make({ session: "ses_root", at: event.endedAt }))
      }
    }
    expect(told).toBe(3)
  })

  test("the RPC's answer gives each asked session its reading, line and flag; one never timed reads empty", () => {
    const now = 10 * HOUR
    const state = fold(Array.from({ length: 20 }, (_, index) => timed("ses_root", now - HOUR + index * 3 * 60_000, 101_000)))
    const answer = answerOf(state, ["ses_root", "ses_other"], now)
    expect(answer.times.map((time) => [time.sessionID, time.unwell, time.cells])).toEqual([
      ["ses_root", true, 20],
      ["ses_other", false, 0],
    ])
    expect(answer.times[0]!.line).toBe("cells 56% of the last hour · 20 cells · 0 cut")
  })
})
