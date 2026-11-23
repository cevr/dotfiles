import { expect, test } from "bun:test"
import { Diagnostic, Fact, Terminal, evolve, initial, observe, type Snapshot } from "./child-lifecycle.ts"

// Replay host facts at the projection seam. Order comes from the witness
// sequence, not arrival; none of these traces authenticates transport.
const child = "ses_fixture"
const parent = "ses_parent"
const point = (seq: number) => ({ id: `evt_${seq}`, at: 100, seq })
const start = (seq: number): Fact => Fact.cases.Execution.make({ child, parent, segment: { point: point(seq) }, unfinished: false })
const end = (seq: number, outcome: "succeeded" | "failed" | "interrupted", unfinished = false): Fact => Fact.cases.Execution.make({
  child, parent, unfinished,
  segment: { point: point(seq), terminal: Terminal.cases.Ended.make({ outcome, cause: causeOf(outcome) }) },
})
const causeOf = (outcome: string) => {
  if (outcome === "failed") return "PolicyDenied"
  return "Unknown"
}
const step = (seq: number): Fact => Fact.cases.Diagnostic.make({
  child, parent, note: { point: point(seq), diagnostic: Diagnostic.cases.StepError.make({ cause: "PolicyDenied" }) },
})
const snap = (fields: Partial<Snapshot> = {}): Snapshot => ({ running: false, ...fields })

test("a step error and a busy-period failure with a continuing shell do not settle the attempt", () => {
  const states = [
    { event: start(1), snapshot: snap(), phase: "Running" },
    { event: step(2), snapshot: snap({ running: true, background: "Shell" }), phase: "Running" },
    { event: end(3, "failed", true), snapshot: snap({ background: "Shell" }), phase: "Continuing" },
    { event: end(3, "failed", true), snapshot: snap(), phase: "Continuing" },
    { event: start(4), snapshot: snap(), phase: "Running" },
    { event: end(5, "succeeded"), snapshot: snap(), phase: "Settled" },
  ]
  let projection = initial(child, parent)
  for (const { event, snapshot, phase } of states) {
    projection = evolve(projection, event)
    expect(observe(projection, snapshot, true)).toMatchObject({ child, phase: { _tag: phase } })
  }
  const final = observe(projection, snap(), true)
  expect(final.started).toEqual(point(4))
  expect(final.phase).toMatchObject({ outcome: "succeeded", terminal: point(5) })
  expect(observe(projection, snap(), true)).not.toHaveProperty("diagnostic")
})

const orders = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
]
for (const order of orders) {
  test(`old, foreign and repeated events do not change the latest busy period (${order.join(",")})`, () => {
    const timeline = [end(2, "failed"), start(3), end(4, "succeeded")]
    const chart = ["Settled", "Running", "Settled"] as const
    const outcomes = ["failed", "", "succeeded"] as const
    let projection = evolve(initial(child, parent), start(1))
    let newest = 0
    for (const index of order) {
      const fact = timeline[index] ?? start(1)
      projection = evolve(projection, fact)
      newest = Math.max(index, newest)
      const phase = observe(projection, snap(), true).phase
      expect(phase._tag).toBe(chart[newest])
      if (phase._tag === "Settled") expect(String(phase.outcome)).toBe(outcomes[newest])
      expect(evolve(projection, fact)).toBe(projection)
      expect(evolve(projection, { ...end(99, "failed"), parent: "ses_unowned" })).toBe(projection)
    }
  })
}

test("persisted points cannot authenticate a terminal across an unobserved interval", () => {
  const seed = evolve(evolve(initial(child, parent), start(1)), end(2, "failed"))
  const afterRestart = observe(seed, snap({ outcome: "failed" }), false)
  expect(afterRestart.phase._tag).toBe("Settled")
  expect(afterRestart.phase).toMatchObject({ outcome: "failed", cause: "Unknown" })
  expect(afterRestart.phase).not.toHaveProperty("terminal")
  expect(afterRestart.started).toBeUndefined()
  expect(observe(seed, snap({ running: true }), false).phase._tag).toBe("Running")
  expect(observe(seed, snap(), false).phase._tag).toBe("Unknown")
})

test("a monotone unread marker does not outrank a durable point; a different snapshot start invalidates it", () => {
  const seed = evolve(evolve(initial(child, parent), start(1)), end(2, "failed"))
  const agreed = observe(seed, snap({ busyAt: 100, idleAt: 105, outcome: "failed" }), true)
  expect(agreed.phase).toMatchObject({ terminal: point(2) })
  const newer = observe(seed, snap({ busyAt: 101, idleAt: 105, outcome: "failed", running: true }), true)
  expect(newer.phase._tag).toBe("Running")
  expect(newer).not.toHaveProperty("started")
  const disputed = observe(seed, snap({ busyAt: 100, idleAt: 105, outcome: "succeeded" }), true)
  expect(disputed.phase._tag).toBe("Unknown")
})
