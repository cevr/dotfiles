import { expect, test } from "bun:test"
import { Diagnostic, Fact, Phase, Projection, Terminal, Undetermined, decide, evolve, initial, observe, present, rowFactOf, type Snapshot } from "./child-lifecycle.ts"
import { Option, Schema } from "effect"
import { RowFact } from "./child-row.ts"

// Replay host facts at the projection seam. Order comes from the witness
// sequence, not arrival; none of these traces authenticates transport.
const child = "ses_fixture"
const parent = "ses_parent"
const point = (seq: number) => ({ id: `evt_${seq}`, at: 100, seq })
const start = (seq: number): Fact => Fact.cases.Execution.make({ child, parent, segment: { point: point(seq) } })
const end = (seq: number, outcome: "succeeded" | "failed" | "interrupted"): Fact => Fact.cases.Execution.make({
  child, parent,
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
const exit = (at = 101) => Fact.cases.Exit.make({
  child, parent, reason: Undetermined.make({ shellID: "sh_fixture", exit: { at, id: "evt_exit" } }),
})
const admission = (seq = 4) => Fact.cases.Inbox.make({ child, parent, id: "input", seq, shellID: "sh_fixture" })
const closed = (seq = 5) => Fact.cases.Inbox.make({ child, parent, id: "input", seq, disposition: "delivered" })
const store = Schema.fromJsonString(Projection)
const readStore = Schema.decodeUnknownSync(store)
const writeStore = Schema.encodeSync(store)
const reloaded = (state: Projection) => readStore(writeStore(state))

test("the same persisted points retain only the same row evidence at every restart cut", () => {
  const traces = [
    [start(1), step(2), end(3, "failed"), exit(), admission(), start(5), closed(6), end(7, "succeeded")],
    [start(1), step(2), exit(99), end(3, "failed")],
    [start(1), end(3, "failed"), exit()],
    [start(1), end(3, "failed"), exit(), end(7, "interrupted")],
  ]
  for (const trace of traces) {
    const continuous = trace.reduce(evolve, initial(child, parent))
    for (let i = 0; i <= trace.length; i++) {
      const before = trace.slice(0, i).reduce(evolve, initial(child, parent))
      const after = reloaded(before)
      expect(rowFactOf(after, snap())).toEqual(rowFactOf(before, snap()))
      expect(observe(after, snap(), false).phase).toEqual(observe(before, snap(), false).phase)
      expect(trace.slice(i).reduce(evolve, after)).toEqual(continuous)
    }
  }
})

test("delivery first closes only its inbox ID; late orderable admission correlates the shell without reviving pending work", () => {
  const before = [start(1), end(3, "failed"), exit()].reduce(evolve, initial(child, parent))
  const closedFirst = evolve(before, closed())
  expect(rowFactOf(closedFirst, snap())._tag).toBe("ShellResultUndetermined")
  const matched = evolve(reloaded(closedFirst), admission())
  expect(rowFactOf(matched, snap())).toEqual(RowFact.cases.Failed.make({ at: 100 }))
  expect(matched.inbox?.input).toEqual({ seq: 5, generation: 4, pending: false, shellID: "sh_fixture", terminalSeq: 3, disposition: "delivered" })
  expect(evolve(matched, admission())).toBe(matched)
  expect(evolve(matched, closed(2)).inbox).toEqual(matched.inbox)
})

test("a stale delivery cannot close a newer admission; an older exit cannot revive a later failure", () => {
  const before = [start(1), end(3, "failed"), exit(), admission()].reduce(evolve, initial(child, parent))
  expect(evolve(reloaded(before), closed(2)).inbox).toEqual(before.inbox)
  const finished = evolve(before, end(6, "succeeded"))
  expect(evolve(finished, exit(99))).toBe(finished)
  expect(evolve(finished, end(3, "failed"))).toBe(finished)
  const laterFailure = evolve(finished, end(7, "failed"))
  expect(evolve(laterFailure, exit(99))).toBe(laterFailure)
})

test("a step error and a busy-period failure with a continuing shell do not settle the attempt", () => {
  const states = [
    { event: start(1), snapshot: snap(), phase: "Running" },
    { event: step(2), snapshot: snap({ running: true, background: "Shell" }), phase: "Running" },
    { event: end(3, "failed"), snapshot: snap({ background: "Shell" }), phase: "Continuing" },
    { event: end(3, "failed"), snapshot: snap({ background: "Wake" }), phase: "Continuing" },
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

const cancel = (id: string, seq: number) => Fact.cases.Inbox.make({ child, parent, id, seq, disposition: "cancelled" })
const inLifetime = (state: Projection, activation: number, ...facts: ReadonlyArray<Fact>) =>
  facts.reduce((projection, fact) => evolve(projection, { ...fact, seenIn: activation }), state)

test("the phase returns its own input and execution witnesses, not the child's newest observed event", () => {
  const first = inLifetime(initial(child, parent), 1, start(1), end(3, "failed"), exit(), admission())
  const old = reloaded(first)
  const unrelated = inLifetime(old, 2, cancel("another-input", 5))
  expect(decide(unrelated, snap(), 2).facts.map(({ subject, id }) => [subject, id])).toEqual([["execution", "evt_3"], ["input", "input"]])
  expect(present(unrelated, snap(), 2)).toMatchObject({ phase: Phase.cases.Continuing.make({ on: "Wake" }), basis: "as-of-last-observation" })
  expect(unrelated.inbox?.["another-input"]).toMatchObject({ seenIn: 2, disposition: "cancelled" })
  expect(unrelated.segment?.seenIn).toBe(1)
  const matched = inLifetime(unrelated, 2, cancel("input", 6))
  const original = Phase.cases.Settled.make({ outcome: "failed", cause: "PolicyDenied", terminal: point(3) })
  expect(present(matched, snap(), 2)).toMatchObject({ phase: original, basis: "current" })
  expect(matched.segment?.confirmation).toEqual({ input: "input", generation: 4, seq: 6, seenIn: 2 })
  expect(present(matched, snap(), 3)).toMatchObject({ phase: original, basis: "as-of-last-observation" })
  const later = inLifetime(matched, 2, start(7), end(9, "succeeded"))
  const late = inLifetime(reloaded(later), 3, end(3, "failed"), cancel("input", 10))
  expect(present(late, snap(), 3)).toMatchObject({
    phase: Phase.cases.Settled.make({ outcome: "succeeded", cause: "Unknown", terminal: point(9) }), basis: "as-of-last-observation",
  })
  expect(late.segment?.confirmation).toBeUndefined()
})

test("a legacy aggregate stamp is discarded without discarding its facts or revision", () => {
  const failed = inLifetime(initial(child, parent), 1, start(1), end(3, "failed"))
  const legacy = { ...failed, segment: { point: point(3), terminal: failed.segment?.terminal }, observedIn: 2 }
  const decoded = Schema.decodeUnknownSync(Projection)(legacy)
  expect(decoded).not.toHaveProperty("observedIn")
  expect(present(decoded, snap(), 2)).toMatchObject({
    revision: failed.rev, phase: Phase.cases.Settled.make({ outcome: "failed", cause: "PolicyDenied", terminal: point(3) }),
    basis: "as-of-last-observation",
  })
})

test("previous records keep historical wakes but cannot use their legacy inbox links to refresh a terminal", () => {
  const first = inLifetime(initial(child, parent), 1, start(1), end(3, "failed"), exit(), admission())
  const legacy = reloaded({ ...first, inbox: { input: { seq: 4, shellID: "sh_fixture", pending: true, terminalSeq: 3, seenIn: 1 } } })
  const cancelled = inLifetime(legacy, 2, cancel("input", 5))
  expect(present(legacy, snap(), 2).basis).toBe("as-of-last-observation")
  expect(present(cancelled, snap(), 2)).toMatchObject({ phase: Phase.cases.Unknown.make({}), basis: "as-of-last-observation" })
  expect(cancelled.segment?.confirmation).toBeUndefined()
})

test("a late result or an ambiguous same-clock result cannot close another job instance", () => {
  const job = (at: number, running: boolean, startEvent?: string) => Fact.cases.Work.make({
    child, parent, id: "job_reused", work: {
      kind: "Child", at, running, native: false, backgrounded: true,
      ...Option.match(Option.fromUndefinedOr(startEvent), { onNone: () => ({}), onSome: (startEvent) => ({ startEvent }) }),
    },
  })
  const phase = Phase.cases.Continuing.make({ on: "Child" })
  const older = inLifetime(initial(child, parent), 1, job(100, true, "first"), job(101, true, "second"), job(100, false))
  expect(present(older, snap(), 1)).toMatchObject({ phase, basis: "current" })
  const tied = inLifetime(older, 1, job(101, true, "third"), job(101, false))
  expect(present(tied, snap(), 1)).toMatchObject({ phase, basis: "as-of-last-observation" })
  expect(inLifetime(tied, 1, job(102, true, "fourth"), job(102, false)).work?.job_reused?.running).toBe(false)
})
