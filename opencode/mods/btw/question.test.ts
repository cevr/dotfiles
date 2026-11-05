import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { cut, FORK_NAME_CHARS, forkName, forkNote, MAXIMUM_QUESTION_CHARS, oneLine, QuestionTooLong, questionOf } from "./question.ts"

describe("questionOf", () => {
  test("trims; an empty question stays empty", () => {
    expect(Effect.runSync(questionOf("  why?\n"))).toBe("why?")
    expect(Effect.runSync(questionOf("  \n "))).toBe("")
  })

  test("counts characters by code point, refusing past the limit", () => {
    expect(Effect.runSync(questionOf("😀".repeat(MAXIMUM_QUESTION_CHARS)))).toHaveLength(MAXIMUM_QUESTION_CHARS * 2)
    expect(Effect.runSyncExit(questionOf("😀".repeat(MAXIMUM_QUESTION_CHARS + 1)))).toEqual(
      Exit.fail(new QuestionTooLong({ chars: MAXIMUM_QUESTION_CHARS + 1, limit: MAXIMUM_QUESTION_CHARS })),
    )
  })
})

describe("forkName", () => {
  test("puts the question on one line after btw:, cut with an ellipsis", () => {
    expect(forkName("why\n  is it\tslow?")).toBe("btw: why is it slow?")
    const long = "a".repeat(FORK_NAME_CHARS + 10)
    expect(forkName(long)).toBe(`btw: ${"a".repeat(FORK_NAME_CHARS)}…`)
    expect(forkName("   ")).toBe("btw")
  })
})

test("oneLine and cut", () => {
  expect(oneLine(" a \n\n b ")).toBe("a b")
  expect(cut("héllo", 5)).toBe("héllo")
  expect(cut("😀😀😀", 2)).toBe("😀😀…")
})

test("the fork's note names the session it was forked from and tells the model not to continue its work", () => {
  const note = forkNote("ses_main")
  expect(note).toContain("fork of session ses_main")
  expect(note).toContain("Do not continue it.")
  expect(note).toContain("Answer the question that follows.")
})
