import { describe, expect, test } from "bun:test"
import {
  bucketOf,
  duplicateOf,
  EmptyNote,
  matchQuery,
  MAX_TAGS,
  MAX_TEXT,
  mergeTags,
  type Note,
  NoteTooLong,
  similarity,
  tagsOf,
  textOf,
  visible,
} from "./note.ts"

const note = (id: number, text: string, fields: Partial<Note> = {}): Note => ({
  id,
  scope: "project",
  project: "p1",
  text,
  tags: [],
  created: 0,
  updated: 0,
  uses: 0,
  shown: 0,
  used: 0,
  session: "s",
  place: "/work",
  ...fields,
})

describe("a note's text", () => {
  test("is one line: whitespace runs and newlines become one space", () => {
    expect(textOf("  Use bun,\n  not   npm \n")).toBe("Use bun, not npm")
  })
  test("an empty one is refused", () => {
    expect(textOf(" \n\t")).toBeInstanceOf(EmptyNote)
  })
  test(`one past ${MAX_TEXT} characters is refused with its length`, () => {
    expect(textOf("a".repeat(MAX_TEXT))).toBe("a".repeat(MAX_TEXT))
    const refused = textOf("a".repeat(MAX_TEXT + 1))
    expect(refused).toBeInstanceOf(NoteTooLong)
    expect(refused).toMatchObject({ length: MAX_TEXT + 1, limit: MAX_TEXT })
  })
})

test("tags are lower case words without repeats, at most MAX_TAGS", () => {
  expect(tagsOf(["Bun", "bun", "c++", " ", "the-gate"])).toEqual(["bun", "c", "the-gate"])
  expect(tagsOf(Array.from({ length: 12 }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS)
  expect(mergeTags(["new"], ["old", "new"])).toEqual(["new", "old"])
})

test("a global note has no project; a session sees the global bucket and its project's", () => {
  expect(bucketOf("global", "p1")).toEqual({ scope: "global", project: "" })
  expect(bucketOf("project", "p1")).toEqual({ scope: "project", project: "p1" })
  expect(visible("p1")).toEqual([
    { scope: "global", project: "" },
    { scope: "project", project: "p1" },
  ])
})

describe("a repeat", () => {
  test("similarity is the share of words two texts have in common, case and punctuation aside", () => {
    expect(similarity("The user prefers bun over npm.", "the user PREFERS bun over npm")).toBe(1)
    expect(similarity("Project uses bun test for tests", "Project uses oxlint for lint")).toBeCloseTo(3 / 8)
    expect(similarity("", "anything")).toBe(0)
  })

  test("a new note that says nearly what a kept one says is that note", () => {
    const kept = [note(1, "The user prefers bun over npm"), note(2, "Run the gate before a push")]
    expect(duplicateOf(kept, { scope: "project", project: "p1" }, "The user prefers bun over npm for scripts")?.id).toBe(1)
  })

  test("the most alike wins; one of another bucket, or a different fact on the same subject, is not a repeat", () => {
    const kept = [note(1, "Run the gate before every push"), note(2, "Run the gate before a push"), note(3, "Run the gate before a push", { project: "p2" })]
    expect(duplicateOf(kept, { scope: "project", project: "p1" }, "Run the gate before a push")?.id).toBe(2)
    expect(duplicateOf(kept, { scope: "project", project: "p1" }, "The gate runs lint and typecheck")).toBeUndefined()
    expect(duplicateOf(kept, { scope: "global", project: "" }, "Run the gate before a push")).toBeUndefined()
  })
})

test("the search query quotes each distinct word and matches any, so punctuation never reads as an operator", () => {
  expect(matchQuery('bun "test" OR -x (gate)')).toBe('"bun" OR "test" OR "or" OR "x" OR "gate"')
  expect(matchQuery("Bun bun")).toBe('"bun"')
  expect(matchQuery("?!")).toBe("")
})
