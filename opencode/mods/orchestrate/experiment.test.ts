import { describe, expect, test } from "bun:test"
import { armFor, armOf, unitNamed } from "./experiment.ts"

const experiment = { role: "planner", model: "anthropic/claude-fable", share: 0.5 }
const start = (description: string, fields: Partial<Parameters<typeof armFor>[1]> = {}) =>
  armFor(experiment, { agent: "planner", followUp: false, namedModel: false, description, ...fields })

describe("the experiment's arms", () => {
  test("a unit's arm is the same on every start: its replans and later rounds stay in it", () => {
    expect(start("planner billing r1")).toEqual({ arm: "trial", unit: "billing" })
    expect(start("planner billing r2")).toEqual({ arm: "trial", unit: "billing" })
    expect(start("billing r3 planner (replan)")).toEqual({ arm: "trial", unit: "billing" })
    expect(start("planner auth r1")).toEqual({ arm: "control", unit: "auth" })
    expect(start("planner auth r2")).toEqual({ arm: "control", unit: "auth" })
  })

  test("about `share` of units are in the trial; none at 0, all at 1", () => {
    const units = Array.from({ length: 2000 }, (_, index) => `unit-${index}`)
    const trial = units.filter((unit) => armOf(experiment, unit) === "trial").length / units.length
    expect(trial).toBeGreaterThan(0.45)
    expect(trial).toBeLessThan(0.55)
    expect(units.some((unit) => armOf({ ...experiment, share: 0 }, unit) === "trial")).toBe(false)
    expect(units.every((unit) => armOf({ ...experiment, share: 1 }, unit) === "trial")).toBe(true)
  })

  test("a free-form description is its own unit, so the start is still in an arm", () => {
    const arm = start("Revise #197 ownership plan")
    expect(arm?.unit).toBe("revise #197 ownership plan")
    expect(start("  Revise #197   ownership plan ")).toEqual(arm)
    expect(start("")).toBeUndefined()
  })

  test("a follow-up, another role, a named model or no description is in no arm", () => {
    expect(start("planner billing r2", { followUp: true })).toBeUndefined()
    expect(start("planner billing r1", { agent: "implementor" })).toBeUndefined()
    expect(start("planner billing r1", { namedModel: true })).toBeUndefined()
    expect(armFor(undefined, { agent: "planner", followUp: false, namedModel: false, description: "planner billing r1" })).toBeUndefined()
  })

  test("the unit is the step's first word after its role", () => {
    expect(unitNamed("planner pool-limits r1")).toBe("pool-limits")
    expect(unitNamed("pool-limits r2 implementor")).toBe("pool-limits")
    expect(unitNamed("planner r1")).toBeUndefined()
    expect(unitNamed(undefined)).toBeUndefined()
  })
})
