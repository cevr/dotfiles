import { expect, test } from "bun:test"
import { Option } from "effect"
import { DAY, estimate, HOUR, type Sample } from "./launch-cost.ts"

const now = 2 * DAY
const model = Option.some("claude-opus-5-5")
const sample = (cost: number, ago = 1, on = "claude-opus-5-5"): Sample => ({ model: on, at: now - ago, cost })

test("the next launch learns the past hour's completed work, independently of model versions", () => {
  expect(estimate([sample(0.01), sample(0.02), sample(0.03, 2, "claude-opus-5-4"), sample(0.9, 1, "claude-fable-5-2")], model, now, 0.005))
    .toEqual({ cost: 0.02, samples: 3, source: "hour" })
})

test("sparse recent work uses the day's cohort, and sparse history shrinks toward the floor", () => {
  expect(estimate([sample(0.03), sample(0.015, 2 * HOUR), sample(0.015, 3 * HOUR)], model, now, 0.005))
    .toEqual({ cost: 0.02, samples: 3, source: "day" })
  expect(estimate([sample(0.02)], model, now, 0.005)).toEqual({ cost: 0.01, samples: 1, source: "day" })
})

test("cheap work, expired work, future work and invalid samples cannot remove the floor", () => {
  expect(estimate([sample(0.001), sample(0.001), sample(0.001)], model, now, 0.005).cost).toBe(0.005)
  expect(estimate([sample(0.9, DAY + 1), sample(0.9, -1), sample(Number.NaN), sample(-1)], model, now, 0.005))
    .toEqual({ cost: 0.005, samples: 0, source: "floor" })
  expect(estimate([sample(0.02)], Option.none(), now, 0.005)).toEqual({ cost: 0.005, samples: 0, source: "floor" })
})
