import { expect, test } from "bun:test"
import { auditOf, nearPairs } from "./audit.ts"
import type { Note } from "./note.ts"

const DAY = 86_400_000
const NOW = 100 * DAY

const note = (id: number, text: string, fields: Partial<Note> = {}): Note => ({
  id,
  scope: "project",
  project: "p1",
  text,
  tags: [],
  created: NOW - 40 * DAY,
  updated: NOW - 40 * DAY,
  uses: 0,
  shown: 0,
  used: 0,
  session: "s",
  place: "/work",
  ...fields,
})

const NOTES = [
  note(1, "The user prefers bun over npm", { scope: "global", project: "", uses: 4, used: NOW - DAY }),
  note(2, "Run the gate before every push to main"),
  note(3, "Run the gate before a push to main", { used: NOW - 35 * DAY, shown: 2 }),
  note(4, "Run the gate before a push to main", { project: "p2", created: NOW - DAY }),
]

test("each note's readings and age, the stale ones longest idle first, and the counts by scope and project", () => {
  const audit = auditOf(NOTES, NOW)
  expect(audit.total).toBe(4)
  expect(audit.global).toBe(1)
  expect(audit.projects).toEqual({ p1: 2, p2: 1 })
  expect(audit.notes[0]).toMatchObject({ id: 1, uses: 4, idleDays: 1, used: new Date(NOW - DAY).toISOString() })
  expect(audit.notes[1]).toMatchObject({ id: 2, used: null, idleDays: 40 })
  expect(audit.stale).toEqual([2, 3])
  expect(auditOf(NOTES, NOW, { staleDays: 36 }).stale).toEqual([2])
})

test("near pairs are within one bucket, the most alike first", () => {
  expect(nearPairs(NOTES)).toEqual([{ a: 2, b: 3, similarity: 0.78 }])
  expect(nearPairs(NOTES, 0.95)).toEqual([])
})

test("each project's digest fill: what its sessions see, what the digest holds and its size", () => {
  const audit = auditOf(NOTES, NOW, { limits: { notes: 2, chars: 4_000 } })
  expect(audit.digests.map((fill) => [fill.project, fill.visible, fill.holds])).toEqual([
    ["p1", 3, 2],
    ["p2", 2, 2],
  ])
  expect(audit.digests[0]!.chars).toBeGreaterThan(0)
  expect(auditOf([NOTES[0]!], NOW).digests.map((fill) => fill.project)).toEqual([""])
  expect(auditOf([], NOW).digests).toEqual([])
})
