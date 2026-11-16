// Whether a spool write keeps the feed pane running, over seeded sequences
// of the writes each call makes: a tally (`count`), the caller's own
// session remembered (`remember`) and the same feed shown again keep it;
// anything else shown (a picture, a page, a url, a simulator, a live tab)
// or another feed ends it.
import { describe, expect, test } from "bun:test"
import { Browse, count, Feed, keepsFeed, Page, Picture, remember, type Shown, show, type Spooled, Sim, Url } from "./spool.ts"

const BASE = "http://localhost:8228"
const followed = Feed.make({ base: BASE, session: "s1", name: "s1", every: 3 })

/** A seeded draw in [0, 1), so a failing case names its seed. */
const drawsOf = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    const mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    const more = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((more ^ (more >>> 14)) >>> 0) / 4294967296
  }
}

/** The writes that keep what is shown: each call's tally, the caller's own session remembered, the feed shown again. */
const keeping: ReadonlyArray<(spooled: Spooled, at: number) => Spooled> = [
  (spooled, at) => count(spooled, { msg: `${at} of 9`, state: "working", progress: at }),
  (spooled, at) => remember(spooled, Feed.make({ base: BASE, session: `own${at}`, name: "own", every: 3 })),
  (spooled) => show(spooled, followed),
]

/** The writes that show something else. */
const replacing: ReadonlyArray<Shown> = [
  Picture.make({ file: "/tmp/a.png", name: "a.png" }),
  Page.make({ file: "/tmp/a.md", name: "a.md" }),
  Url.make({ url: "http://localhost:3000/", name: "localhost:3000", every: 5, width: 1280 }),
  Sim.make({ device: "", host: "", name: "simulator", every: 2 }),
  Browse.make({ url: "http://localhost:3000/", name: "localhost:3000", width: 0, fps: 6 }),
  Feed.make({ base: BASE, session: "s2", name: "s2", every: 3 }),
  Feed.make({ base: BASE, session: "s1", name: "s1", every: 9 }),
]

describe("a spool write while the feed runs", () => {
  test("keeps the feed for any run of tallies, rememberings and the feed shown again, shown or remembered", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const draw = drawsOf(seed)
      // The feed shown on purpose, or remembered and shown because nothing else is.
      const start = [show({ seq: 0 }, followed), remember({ seq: 0 }, followed)][Math.floor(draw() * 2)]
      const writes = Array.from({ length: 1 + Math.floor(draw() * 12) }, () => keeping[Math.floor(draw() * keeping.length)])
      const end = writes.reduce((spooled, write, at) => write(spooled, at), start)
      expect({ seed, kept: keepsFeed(end, followed) }).toEqual({ seed, kept: true })
    }
  })

  test("ends it once anything else is shown, whatever came before", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const draw = drawsOf(seed)
      const before = Array.from({ length: Math.floor(draw() * 5) }, () => keeping[Math.floor(draw() * keeping.length)]).reduce((spooled, write, at) => write(spooled, at), show({ seq: 0 }, followed))
      for (const shown of replacing) {
        expect({ seed, shown: shown._tag, kept: keepsFeed(show(before, shown), followed) }).toEqual({ seed, shown: shown._tag, kept: false })
      }
    }
  })
})
