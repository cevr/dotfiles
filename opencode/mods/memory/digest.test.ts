import { describe, expect, test } from "bun:test"
import { digestOf, HALF_LIFE_DAYS, HEADING, lineOf, rank } from "./digest.ts"
import type { Note } from "./note.ts"

const DAY = 86_400_000
const NOW = 400 * DAY

const note = (id: number, text: string, fields: Partial<Note> = {}): Note => ({
  id,
  scope: "project",
  project: "p1",
  text,
  tags: [],
  created: NOW,
  updated: NOW,
  uses: 0,
  shown: 0,
  used: 0,
  session: "s",
  place: "/work",
  ...fields,
})

describe("the rank", () => {
  test("a note asked for more ranks higher; one updated longer ago ranks lower, half at the half-life", () => {
    expect(rank(note(1, "a", { uses: 3 }), NOW)).toBeGreaterThan(rank(note(2, "b"), NOW))
    expect(rank(note(1, "a", { updated: NOW - HALF_LIFE_DAYS * DAY }), NOW)).toBeCloseTo(rank(note(2, "b"), NOW) / 2)
  })
  test("being shown never raises it, so the digest cannot keep its own notes in place", () => {
    expect(rank(note(1, "a", { shown: 50, used: NOW }), NOW)).toBe(rank(note(2, "b"), NOW))
  })
})

describe("the digest", () => {
  test("no notes, no block", () => {
    expect(digestOf([], NOW)).toEqual({ text: "", ids: [] })
  })

  test("global notes first, then the project's, each oldest id first, under the heading", () => {
    const notes = [note(3, "project fact", { tags: ["bun"] }), note(1, "user fact", { scope: "global", project: "" }), note(2, "older project fact")]
    const digest = digestOf(notes, NOW)
    expect(digest.ids).toEqual([1, 2, 3])
    expect(digest.text).toBe(
      [HEADING, "## About the user, in every project\n- #1 user fact", "## This project\n- #2 older project fact\n- #3 project fact [bun]"].join("\n\n"),
    )
  })

  test("it holds at most the count and the characters asked, keeping the highest-ranked", () => {
    const notes = Array.from({ length: 50 }, (_, i) => note(i + 1, `fact number ${i + 1} ${"x".repeat(80)}`, { uses: i }))
    const counted = digestOf(notes, NOW, { notes: 5, chars: 100_000 })
    expect(counted.ids).toEqual([46, 47, 48, 49, 50])
    const sized = digestOf(notes, NOW, { notes: 100, chars: 1_000 })
    const lines = sized.ids.map((id) => lineOf(notes[id - 1]!).length + 1).reduce((a, b) => a + b, 0)
    expect(lines).toBeLessThanOrEqual(1_000)
    expect(sized.text.length).toBeLessThanOrEqual(HEADING.length + 1_000 + 64)
    expect(sized.ids).toContain(50)
    expect(sized.ids).not.toContain(1)
  })

  test("a line that does not fit is skipped for a shorter one below it", () => {
    const notes = [note(1, "y".repeat(300), { uses: 9 }), note(2, "short", { uses: 1 })]
    expect(digestOf(notes, NOW, { notes: 10, chars: 100 }).ids).toEqual([2])
  })

  test("the same notes give the same text whatever order they come in", () => {
    const notes = [note(1, "a", { uses: 2 }), note(2, "b", { scope: "global", project: "" }), note(3, "c", { uses: 2 })]
    expect(digestOf([...notes].reverse(), NOW).text).toBe(digestOf(notes, NOW).text)
  })
})
