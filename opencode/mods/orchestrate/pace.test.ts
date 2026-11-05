// The pace: the Codex admission script's answers, and the model a pace is asked about.
import { describe, expect, test } from "bun:test"
import { parseAdmission, parseModel } from "./pace.ts"

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
