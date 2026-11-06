// The pace: the Codex admission script's answers, and the model a pace is asked about.
import { describe, expect, test } from "bun:test"
import { parseAdmission, parseModel } from "./pace.ts"

describe("the pace", () => {
  test("the Codex script admits with exit 0 and holds with exit 1, with the time it opens", () => {
    expect(parseAdmission(0, "checking\nadmit: room for 3")).toEqual({ _tag: "Answered", pace: { ok: true, measured: true, reason: "room for 3" } })
    expect(parseAdmission(1, "hold: weekly pace; opens about 2026-11-04 18:30Z\n")).toEqual({
      _tag: "Answered",
      pace: { ok: false, measured: true, reason: "weekly pace", retryAt: Date.parse("2026-11-04T18:30:00Z") },
    })
    expect(parseAdmission(1, "hold: no room")).toEqual({ _tag: "Answered", pace: { ok: false, measured: true, reason: "no room" } })
  })

  test("any other answer fails open, saying the exit code", () => {
    expect(parseAdmission(0, "hold: no room")).toEqual({ _tag: "FailedOpen", why: "no admission line (exit 0)" })
    expect(parseAdmission(1, "admit: room")).toEqual({ _tag: "FailedOpen", why: "no admission line (exit 1)" })
    expect(parseAdmission(2, "")).toEqual({ _tag: "FailedOpen", why: "no admission line (exit 2)" })
    expect(parseAdmission(null, "admit: room")).toEqual({ _tag: "FailedOpen", why: "no admission line (exit by signal)" })
  })

  test("a model names its provider and id, without its variant", () => {
    expect(parseModel("openai/gpt-5#high")).toEqual({ providerID: "openai", id: "gpt-5" })
    expect(parseModel("openai/org/model")).toEqual({ providerID: "openai", id: "org/model" })
    expect(parseModel("gpt-5")).toBeUndefined()
    expect(parseModel(5)).toBeUndefined()
  })
})
