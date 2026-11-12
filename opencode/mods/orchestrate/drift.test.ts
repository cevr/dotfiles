// A root's drift from the machine (drift.ts), scored from ledger lines alone:
// small runs for each kind, and the stale ledger of 2026-11-12. The recorded
// ledger of that day is filestore/drift.test.ts.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CLEAN, departureLines, type Drift, driftLine, driftOf, scoreOf, WEIGHTS } from "./drift.ts"
import { lineOfEvent, lineOfRefusal, type Line } from "./ledger.ts"
import { type Command, DEFAULT_CADENCE, type Event, HandBack, Land, Landed, machine, type MachineState, Start } from "./machine.ts"

const T = 1_800_000_000_000
const MIN = 60_000
const M = machine(DEFAULT_CADENCE)
const impl = (name: string, round = 1) => Start.make({ role: "implementor", name, round, direct: false })
const ready = (name: string) => HandBack.make({ role: "implementor", name, verdict: "ready" })
const verifier = (name: string, departs?: string) => Start.make({ role: "verifier", name, round: 1, direct: false, ...(departs === undefined ? {} : { departs }) })

/** The lines a root's calls write, as the ledger decides them: a refused call is its `Refused` line and changes nothing. */
const linesOf = (calls: ReadonlyArray<readonly [Command, number]>): ReadonlyArray<Line> => {
  let state: MachineState = M.initial
  const lines: Array<Line> = []
  for (const [call, after] of calls) {
    const at = T + after
    const outcome = Effect.runSync(Effect.result(M.decide(state, call, at)))
    if (outcome._tag === "Failure") {
      lines.push(lineOfRefusal("root", at, outcome.failure, call))
      continue
    }
    for (const event of outcome.success as ReadonlyArray<Event>) {
      lines.push(lineOfEvent("root", event))
      state = M.evolve(state, event)
    }
  }
  return lines
}
const scored = (calls: ReadonlyArray<readonly [Command, number]>): Drift => driftOf(DEFAULT_CADENCE, linesOf(calls))

describe("each kind of drift", () => {
  test("a run that keeps the machine scores 0", () => {
    const drift = scored([
      [impl("a"), 0],
      [impl("b"), 0],
      [ready("a"), MIN],
      [ready("b"), MIN],
      [Land.make({ rifts: ["a", "b"] }), 2 * MIN],
      [Landed.make({ rifts: ["a", "b"] }), 2 * MIN],
      [verifier("batch-1"), 3 * MIN],
      [HandBack.make({ role: "verifier", name: "batch-1", verdict: "changes", findings: ["a/M1"] }), 4 * MIN],
      [impl("a", 2), 5 * MIN],
      [ready("a"), 6 * MIN],
      [Land.make({ rifts: ["a"] }), 7 * MIN],
      [Landed.make({ rifts: ["a"] }), 7 * MIN],
      [verifier("batch-2"), 8 * MIN],
    ])
    expect(drift).toEqual(CLEAN)
    expect(scoreOf(drift)).toBe(0)
    expect(driftLine(drift)).toBe("drift 0 (clean)")
  })

  test("a refusal costs 1; the same call departing costs its kind's weight, with its reason kept", () => {
    const calls: Array<readonly [Command, number]> = [[impl("a"), 0], [ready("a"), MIN], [verifier("a"), 2 * MIN], [verifier("a", "the owner asked for a alone"), 3 * MIN]]
    const drift = scored(calls)
    expect(drift.counts).toMatchObject({ refused: 1, verifierPerUnit: 1 })
    expect(scoreOf(drift)).toBe(WEIGHTS.refused + WEIGHTS.verifierPerUnit)
    expect(drift.departures).toEqual([{ at: T + 3 * MIN, rules: ["VerifierPerUnit"], why: "the owner asked for a alone", stale: [] }])
    expect(departureLines(drift)).toEqual(["2027-01-15T08:03Z VerifierPerUnit: the owner asked for a alone"])
  })

  test("a land off cadence counts once per call, however many cadence rules it breaks", () => {
    const drift = scored([[impl("a"), 0], [impl("b"), 0], [impl("c"), 0], [ready("a"), MIN], [ready("b"), MIN], [Land.make({ rifts: ["a"], departs: "a gates the install" }), 2 * MIN]])
    expect(drift.departures[0]?.rules).toEqual(["LandPartial", "BatchNotDue"])
    expect(drift.counts).toMatchObject({ offCadence: 1 })
    expect(scoreOf(drift)).toBe(WEIGHTS.offCadence)
  })

  test("a land that drops an unfolded finding is a departure and an unfolded land, naming the finding", () => {
    const drift = scored([
      [impl("a"), 0],
      [ready("a"), MIN],
      [Landed.make({ rifts: ["a"] }), 2 * MIN],
      [verifier("batch-1"), 3 * MIN],
      [HandBack.make({ role: "verifier", name: "batch-1", verdict: "changes", findings: ["a/M1"] }), 4 * MIN],
      [impl("b"), 5 * MIN],
      [ready("b"), 6 * MIN],
      [Land.make({ rifts: ["b"] }), 7 * MIN],
      [Land.make({ rifts: ["b"], departs: "a/M1 is a known limit" }), 8 * MIN],
      [Landed.make({ rifts: ["b"] }), 8 * MIN],
    ])
    expect(drift.counts).toMatchObject({ refused: 1, departed: 1, unfoldedLand: 1 })
    expect(drift.dropped).toEqual(["a/M1"])
    expect(driftLine(drift)).toBe("drift 11: 1 unfolded land ×6, 1 departed ×4, 1 refused ×1")
  })

  test("a land over a verdict whose findings are not known drops them too", () => {
    const drift = scored([
      [impl("a"), 0],
      [ready("a"), MIN],
      [Landed.make({ rifts: ["a"] }), 2 * MIN],
      [verifier("batch-1"), 3 * MIN],
      [HandBack.make({ role: "verifier", name: "batch-1", verdict: "changes", unread: { why: "it is missing" } }), 4 * MIN],
      [impl("b"), 5 * MIN],
      [ready("b"), 6 * MIN],
      [Land.make({ rifts: ["b"], departs: "the report is lost" }), 7 * MIN],
      [Landed.make({ rifts: ["b"] }), 7 * MIN],
    ])
    expect(drift.counts).toMatchObject({ departed: 1, unfoldedLand: 1 })
    expect(drift.dropped).toEqual(["batch-1 (findings not known)"])
  })
})

describe("stale ledger state", () => {
  // The bug of 2026-11-12, as the ledger then wrote it: the verifier of a unit landed by hand did not carry the
  // findings folded into it, so after the accepted verdict they held the next land. Decided again on the ledger
  // as the machine folds it now, the refusal and the departure broke nothing: both are stale.
  const at = (after: number) => new Date(T + after).toISOString()
  const line = (after: number, kind: string, fields: Record<string, unknown>): Line => ({ at: at(after), sessionID: "root", kind, ...fields })
  const written: ReadonlyArray<Line> = [
    line(0, "UnitStarted", { unit: "tui", round: 1, direct: false }),
    line(MIN, "UnitHandedBack", { unit: "tui", ready: true }),
    line(2 * MIN, "VerifierStarted", { batch: "batch-j", units: ["tui"] }),
    line(3 * MIN, "VerifierEnded", { batch: "batch-j", verdict: "changes", findings: ["tui/B1"] }),
    line(4 * MIN, "UnitStarted", { unit: "tui", round: 2, direct: false }),
    line(4 * MIN, "FindingFolded", { finding: "tui/B1", into: "tui" }),
    line(5 * MIN, "UnitHandedBack", { unit: "tui", ready: true }),
    // The old machine wrote no findings here, and left tui/B1 open.
    line(6 * MIN, "VerifierStarted", { batch: "batch-l", units: ["tui"] }),
    line(7 * MIN, "VerifierEnded", { batch: "batch-l", verdict: "accepted" }),
    line(8 * MIN, "UnitStarted", { unit: "push", round: 1, direct: false }),
    line(9 * MIN, "UnitHandedBack", { unit: "push", ready: true }),
    line(10 * MIN, "Refused", { rule: "FindingUnfolded", message: "(scrubbed)", call: { _tag: "Land", rifts: ["push"] } }),
    line(11 * MIN, "Departed", { rule: "FindingUnfolded", why: "stale ledger: tui/B1 was accepted in batch l" }),
    line(12 * MIN, "BatchLanded", { units: ["push"] }),
  ]

  test("a refusal and a departure around findings a verdict already accepted are stale, not drift of the run", () => {
    const drift = driftOf(DEFAULT_CADENCE, written)
    expect(drift.counts).toEqual({ ...CLEAN.counts, stale: 2 })
    expect(drift.departures[0]?.stale).toEqual(["FindingUnfolded"])
    expect(drift.dropped).toEqual([])
    expect(departureLines(drift)).toEqual(["2027-01-15T08:11Z FindingUnfolded (stale): stale ledger: tui/B1 was accepted in batch l"])
  })

  test("a departure with no refusal to decide again is judged by its rule: a finding folded into an ended unit still held it", () => {
    const lines = [
      ...written.slice(0, 9),
      line(8 * MIN, "VerifierStarted", { batch: "batch-m", units: [] }),
      line(8 * MIN, "VerifierEnded", { batch: "batch-m", verdict: "changes", findings: ["up/M1"] }),
      line(9 * MIN, "UnitStarted", { unit: "up", round: 1, direct: false }),
      line(9 * MIN, "FindingFolded", { finding: "up/M1", into: "up" }),
      line(10 * MIN, "UnitHandedBack", { unit: "up", ready: false }),
      line(10 * MIN, "UnitStarted", { unit: "push", round: 1, direct: false }),
      line(11 * MIN, "UnitHandedBack", { unit: "push", ready: true }),
      line(12 * MIN, "Departed", { rule: "FindingUnfolded", why: "stale ledger: up/M1 rides with up" }),
    ]
    expect(driftOf(DEFAULT_CADENCE, lines).counts).toEqual({ ...CLEAN.counts, departed: 1 })
    // While up still implements, the finding rides with it: the same departure broke nothing.
    expect(driftOf(DEFAULT_CADENCE, lines.filter((each) => !(each.kind === "UnitHandedBack" && each.unit === "up"))).counts).toEqual({ ...CLEAN.counts, stale: 1 })
  })
})
