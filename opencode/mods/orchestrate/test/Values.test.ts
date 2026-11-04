// The model's plain values: the guard's routing, the compaction windows, the
// Sabbath hours, and the Codex admission script's answers.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { DEFAULTS, parseWindows, windowsOf } from "../src/domain/Compaction.ts"
import { parseAdmission, parseModel } from "../src/domain/Pace.ts"
import { route } from "../src/domain/Role.ts"
import { KNOWLTON, resumesAt, why } from "../src/domain/Sabbath.ts"

/** Friday 30 October 2026, 19:00 in Knowlton (EDT): after sunset, in the Sabbath. */
const FRIDAY_EVENING = "2026-10-30T23:00:00Z"
/** Wednesday 4 November 2026, 10:00 in Knowlton. */
const WEDNESDAY = "2026-11-04T15:00:00Z"
const SABBATH = /^It is the Sabbath; agent work resumes at Sat 18:\d\d \(30 min after sunset, Knowlton, QC\)\.$/

describe("the guard's routing", () => {
  test("an untyped or general call runs as the worker; a former role name as the role", () => {
    expect(route(undefined)).toEqual({ agent: "worker", reason: "untyped" })
    expect(route("")).toEqual({ agent: "worker", reason: "untyped" })
    for (const name of ["general", "general-purpose", "claude", "status:general"])
      expect(route(name)).toEqual({ agent: "worker", reason: "general" })
    expect(route("orchestrate-reviewer")).toEqual({ agent: "verifier", reason: "renamed" })
    for (const role of ["planner", "implementor", "verifier", "worker"])
      expect(route(`orchestrate-${role}`)).toEqual({ agent: role, reason: "renamed" })
    expect(route("explore")).toEqual({ agent: "explore", reason: "kept" })
    expect(route("planner")).toEqual({ agent: "planner", reason: "kept" })
  })

  test("with the full-agent escape, a general call runs as asked", () => {
    expect(route(undefined, true)).toEqual({ agent: "general", reason: "kept" })
    expect(route("general", true)).toEqual({ agent: "general", reason: "kept" })
    expect(route("orchestrate-reviewer", true)).toEqual({ agent: "verifier", reason: "renamed" })
  })
})

describe("the compaction windows", () => {
  test("compact.json's windows, capped at each role's; a former name counts unless the current one is set", () => {
    expect(
      parseWindows(JSON.stringify({ windows: { planner: 50_000, "orchestrate-reviewer": 120_000, worker: -1, root: 2e6 } })),
    ).toEqual(Option.some({ planner: 50_000, verifier: 120_000 }))
    expect(parseWindows(JSON.stringify({ windows: { verifier: 90_000, "orchestrate-reviewer": 120_000 } }))).toEqual(
      Option.some({ verifier: 90_000 }),
    )
    expect(windowsOf(JSON.stringify({ windows: { planner: 900_000, worker: 150_000, root: 600_000 } }))).toEqual({
      ...DEFAULTS,
      planner: 400_000,
      worker: 150_000,
      root: 600_000,
    })
  })

  test("no file, or a broken one, gives the defaults", () => {
    expect(windowsOf(undefined)).toEqual(DEFAULTS)
    expect(parseWindows("{")).toEqual(Option.none())
    expect(windowsOf("{")).toEqual(DEFAULTS)
    expect(windowsOf("null")).toEqual(DEFAULTS)
    expect(windowsOf(JSON.stringify({ windows: "big" }))).toEqual(DEFAULTS)
    expect(DEFAULTS).toEqual({ planner: 400_000, implementor: 400_000, verifier: 400_000, worker: 200_000, root: 400_000 })
  })
})

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

describe("the pace", () => {
  test("the Codex script admits with exit 0 and holds with exit 1, with the time it opens", () => {
    expect(parseAdmission(0, "checking\nadmit: room for 3")).toEqual({ ok: true, measured: true, reason: "room for 3" })
    expect(parseAdmission(1, "hold: weekly pace; opens about 2026-11-04 18:30Z\n")).toEqual({
      ok: false,
      measured: true,
      reason: "weekly pace",
      retryAt: Date.parse("2026-11-04T18:30:00Z"),
    })
    expect(parseAdmission(1, "hold: no room")).toEqual({ ok: false, measured: true, reason: "no room" })
  })

  test("any other answer is none, and fails open", () => {
    expect(parseAdmission(0, "hold: no room")).toBeUndefined()
    expect(parseAdmission(1, "admit: room")).toBeUndefined()
    expect(parseAdmission(2, "")).toBeUndefined()
    expect(parseAdmission(null, "admit: room")).toBeUndefined()
  })

  test("a model names its provider and id, without its variant", () => {
    expect(parseModel("openai/gpt-5#high")).toEqual({ providerID: "openai", id: "gpt-5" })
    expect(parseModel("openai/org/model")).toEqual({ providerID: "openai", id: "org/model" })
    expect(parseModel("gpt-5")).toBeUndefined()
    expect(parseModel(5)).toBeUndefined()
  })
})
