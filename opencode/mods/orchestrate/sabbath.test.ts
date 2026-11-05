// The Sabbath hours at the owner's place, and the half hour after them.
import { describe, expect, test } from "bun:test"
import { KNOWLTON, resumesAt, why } from "./sabbath.ts"

/** Friday 30 October 2026, 19:00 in Knowlton (EDT): after sunset, in the Sabbath. */
const FRIDAY_EVENING = "2026-10-30T23:00:00Z"
/** Wednesday 4 November 2026, 10:00 in Knowlton. */
const WEDNESDAY = "2026-11-04T15:00:00Z"
const SABBATH = /^It is the Sabbath; agent work resumes at Sat 18:\d\d \(30 min after sunset, Knowlton, QC\)\.$/

describe("the Sabbath", () => {
  test("Friday evening is in it, and the message says when work resumes; Wednesday is not", () => {
    expect(why(Date.parse(FRIDAY_EVENING), KNOWLTON)).toMatch(SABBATH)
    expect(why(Date.parse(WEDNESDAY), KNOWLTON)).toBeUndefined()
    // Friday afternoon, before sunset, is not yet; Saturday evening's half hour after sunset still is.
    expect(why(Date.parse("2026-10-30T20:00:00Z"), KNOWLTON)).toBeUndefined()
    expect(why(Date.parse("2026-10-31T22:00:00Z"), KNOWLTON)).toMatch(SABBATH)
  })

  test("work resumes half an hour after Saturday's sunset", () => {
    const end = resumesAt(Date.parse(FRIDAY_EVENING), KNOWLTON)!
    expect(resumesAt(end - 1, KNOWLTON)).toBe(end)
    expect(resumesAt(end, KNOWLTON)).toBeUndefined()
  })
})
