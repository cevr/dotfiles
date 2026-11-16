// The feed's order: the board (the post titled Board updated last), the
// timeline (every other post newest published first, ties the later listed
// first), a post's versions oldest first and the steps through them, as
// properties over seeded random sessions; and ages and signs by example.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { Post, PostDetail } from "./service.ts"
import { ageOf, boardOf, iconsOf, millisOf, publishedAt, rowsOf, stepVersion, timelineOf, versionsOf } from "./timeline.ts"

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
const between = (draw: () => number, low: number, high: number) => low + Math.floor(draw() * (high - low + 1))

/** A time on 2026-11-15 at minute `minute`, so a few draws collide. */
const at = (minute: number) => `2026-11-15T10:${String(minute).padStart(2, "0")}:00.000Z`

const post = (id: string, title: string, created: number, updated: number, version = 1): Post => ({ id, title, version, createdAt: at(created), updatedAt: at(updated), surfaces: [] })

/** A session of up to 12 posts, some titled Board (in any case), published in a few minutes so ties come up. */
const sessionOf = (draw: () => number): ReadonlyArray<Post> =>
  Array.from({ length: between(draw, 0, 12) }, (_, at) => {
    const created = between(draw, 0, 5)
    const title = ["Board", "board ", "notes", "plan", "shot"][between(draw, 0, 4)]
    return post(`p${at}`, title, created, created + between(draw, 0, 5), between(draw, 1, 4))
  })

describe("the board and the timeline", () => {
  test("the board is the post titled Board updated last (the later listed of a tie), and none without one", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const posts = sessionOf(drawsOf(seed))
      const boards = posts.filter((each) => each.title.trim().toLowerCase() === "board")
      const board = boardOf(posts)
      expect({ seed, has: Option.isSome(board) }).toEqual({ seed, has: boards.length > 0 })
      Option.map(board, (chosen) => {
        expect({ seed, newest: boards.every((each) => each.updatedAt <= chosen.updatedAt) }).toEqual({ seed, newest: true })
        const tied = boards.filter((each) => each.updatedAt === chosen.updatedAt)
        expect({ seed, id: chosen.id }).toEqual({ seed, id: tied[tied.length - 1]?.id ?? "" })
      })
    }
  })

  test("the timeline holds every post but the board once, newest published first, the later listed first of a tie", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const posts = sessionOf(drawsOf(seed))
      const board = Option.map(boardOf(posts), (chosen) => chosen.id)
      const timeline = timelineOf(posts)
      const expected = posts.filter((each) => !Option.contains(board, each.id)).map((each) => each.id)
      expect({ seed, ids: timeline.map((each) => each.id).sort() }).toEqual({ seed, ids: [...expected].sort() })
      timeline.slice(1).forEach((next, index) => {
        const before = timeline[index]
        const ordered = publishedAt(before) > publishedAt(next) || (publishedAt(before) === publishedAt(next) && posts.indexOf(before) > posts.indexOf(next))
        expect({ seed, index, ordered }).toEqual({ seed, index, ordered: true })
      })
    }
  })

  test("a revised post keeps its place: the timeline goes by when a post was published, not when it changed", () => {
    const old = post("a", "old", 1, 9, 5)
    const recent = post("b", "recent", 3, 3)
    expect(timelineOf([old, recent]).map((each) => each.id)).toEqual(["b", "a"])
  })
})

describe("a post's versions", () => {
  const detail = (version: number, kept: ReadonlyArray<number>): PostDetail => ({
    ...post("p", "notes", 0, 9, version),
    history: kept.map((number) => ({ version: number, title: `v${number}`, at: at(number), surfaces: [] })),
  })

  test("are oldest first, each once, the current last, for any history Sideshow kept", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const draw = drawsOf(seed)
      const version = between(draw, 1, 25)
      const kept = Array.from({ length: between(draw, 0, 20) }, () => between(draw, 1, version))
      const versions = versionsOf(detail(version, kept)).map((each) => each.version)
      expect({ seed, versions }).toEqual({ seed, versions: [...new Set([...kept.filter((n) => n !== version), version])].sort((a, b) => a - b) })
    }
  })

  test("are stepped held at both ends, from the newest when none is picked", () => {
    const versions = versionsOf(detail(4, [1, 2, 3]))
    expect(stepVersion(versions, Option.none(), -1)).toEqual(Option.some(3))
    expect(stepVersion(versions, Option.some(2), -5)).toEqual(Option.some(1))
    expect(stepVersion(versions, Option.some(3), 7)).toEqual(Option.some(4))
    for (let seed = 1; seed <= 200; seed++) {
      const draw = drawsOf(seed)
      const steps = between(draw, 0, 3)
      const back = stepVersion(versions, Option.none(), -steps)
      expect({ seed, back: stepVersion(versions, back, steps) }).toEqual({ seed, back: Option.some(4) })
    }
  })
})

describe("a timeline row", () => {
  test("says its age shortest, its surfaces as signs, its versions, and whether it is new", () => {
    const now = millisOf(at(30), 0)
    expect([ageOf(now - 2_000, now), ageOf(now - 42_000, now), ageOf(now - 3 * 60_000, now), ageOf(now - 5 * 3_600_000, now), ageOf(now - 3 * 86_400_000, now)]).toEqual(["now", "42s", "3m", "5h", "3d"])
    expect(iconsOf([{ kind: "markdown", index: 0 }, { kind: "mermaid", index: 1 }, { kind: "diff", index: 2 }, { kind: "image", index: 3 }, { kind: "what", index: 4 }])).toBe("¶◇±▣·")
    const rows = rowsOf([post("a", "notes", 20, 25, 3)], now, new Set(["a"]))
    expect(rows).toEqual([{ id: "a", title: "notes", icons: "", age: "10m", versions: 3, fresh: true }])
  })
})
