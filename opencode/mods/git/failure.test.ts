import { describe, expect, test } from "bun:test"
import { EXCERPT_LINES, failingTest, jobFailure, plain } from "./failure.ts"

const at = (line: string) => `2026-11-06T16:28:22.3556859Z ${line}`

describe("a failing job's log", () => {
  test("a line loses its timestamp and its colours", () => {
    expect(plain(at("\u001b[31m(fail)\u001b[39m a > b"))).toBe("(fail) a > b")
    expect(plain("\uFEFF2026-11-06T16:37:34.1005750Z x")).toBe("x")
  })

  test("names the failing test in each runner's words, without its timing", () => {
    expect(failingTest("(fail) gate DB classification > needs Mongo [5000.52ms]")).toBe("gate DB classification > needs Mongo")
    expect(failingTest(" × renders the row (12 ms)")).toBe("renders the row")
    expect(failingTest("✕ adds")).toBe("adds")
    expect(failingTest("FAIL src/sum.test.ts")).toBe("src/sum.test.ts")
    expect(failingTest("not ok 3 - parses dates")).toBe("parses dates")
    expect(failingTest("--- FAIL: TestRoute (0.01s)")).toBe("TestRoute")
    expect(failingTest("(pass) fine [1ms]")).toBeUndefined()
    expect(failingTest("error: script exited with code 1")).toBeUndefined()
  })

  test("a parallel bun run: each failing test once, its detail and the errors, not the lines interleaved with them", () => {
    const log = [
      at("##[group]tests/a.test.ts:"),
      at("(pass) a > one [1.00ms]"),
      at("(fail) a > two [5000.52ms]"),
      at("  ^ this test timed out after 5000ms."),
      at("explorer: 3306 schedules"),
      at("  end fail: 235"),
      at("##[endgroup]"),
      at("1 tests failed:"),
      at("(fail) a > two [5000.52ms]"),
      at("  ^ this test timed out after 5000ms."),
      at(" 1 pass"),
      at("##[error]Process completed with exit code 1."),
    ].join("\n")
    expect(jobFailure("unit-tests", log)).toEqual({
      check: "unit-tests",
      tests: ["a > two"],
      excerpt: [
        "(fail) a > two [5000.52ms]",
        "  ^ this test timed out after 5000ms.",
        "(fail) a > two [5000.52ms]",
        "  ^ this test timed out after 5000ms.",
        "error: Process completed with exit code 1.",
      ],
    })
  })

  test("no test named: the error lines", () => {
    const log = ["setup", "one", "##[error]boom", "after"].map(at).join("\n")
    expect(jobFailure("lint", log)).toEqual({ check: "lint", tests: [], excerpt: ["error: boom"] })
  })

  test("neither: the last lines, at most EXCERPT_LINES", () => {
    const log = Array.from({ length: 30 }, (_, index) => at(`line ${index}`)).join("\n")
    const failure = jobFailure("build", log)
    expect(failure.excerpt).toHaveLength(EXCERPT_LINES)
    expect(failure.excerpt.at(-1)).toBe("line 29")
  })
})
