// What a compaction keeps (ledger.ts `compact`): the store's retention, decided on lines alone.
import { expect, test } from "bun:test"
import { compact, lineOfEvent, type Retention, stateOf } from "./ledger.ts"
import { DEFAULT_CADENCE, Departed, UnitHandedBack, UnitStarted } from "./machine.ts"

const T = 1_800_000_000_000
const MIN = 60_000
const retention: Retention = { bytes: 1024, idleMs: 60 * MIN, roots: 2, audit: 2 }
const started = (root: string, unit: string, at: number) => lineOfEvent(root, UnitStarted.make({ unit, round: 1, direct: false, at }))

test("a root holding units becomes one checkpoint of its state, read back as that state", () => {
  const lines = [started("root", "alpha", T), started("root", "beta", T + MIN), lineOfEvent("root", UnitHandedBack.make({ unit: "alpha", ready: true, at: T + 2 * MIN }))]
  const kept = compact(DEFAULT_CADENCE, retention, T + 3 * MIN, lines)
  expect(kept.map((line) => line.kind)).toEqual(["Checkpoint"])
  expect(stateOf(DEFAULT_CADENCE, kept)).toEqual(stateOf(DEFAULT_CADENCE, lines))
  // A line after the checkpoint folds on it.
  const next = lineOfEvent("root", UnitHandedBack.make({ unit: "beta", ready: true, at: T + 4 * MIN }))
  expect(stateOf(DEFAULT_CADENCE, [...kept, next])).toEqual(stateOf(DEFAULT_CADENCE, [...lines, next]))
})

test("a root idle past the window is dropped; past the most roots, the least recent go", () => {
  const lines = [started("old", "a", T), started("one", "a", T + 50 * MIN), started("two", "a", T + 55 * MIN), started("three", "a", T + 58 * MIN)]
  const kept = compact(DEFAULT_CADENCE, retention, T + 70 * MIN, lines)
  expect(kept.map((line) => line.sessionID)).toEqual(["three", "two"])
})

test("a root that holds nothing keeps only its newest departures within the window, and a line that does not read goes", () => {
  const departed = (at: number) => lineOfEvent("root", Departed.make({ rule: "LandPartial", why: `at ${at}`, at }))
  const lines = [departed(T), "not a line", departed(T + 30 * MIN), departed(T + 40 * MIN), departed(T + 50 * MIN)]
  const kept = compact(DEFAULT_CADENCE, retention, T + 75 * MIN, lines)
  expect(kept.map((line) => line.why)).toEqual([`at ${T + 40 * MIN}`, `at ${T + 50 * MIN}`])
})

test("a ledger written when starts recorded a workspace still reads: the workspace is dropped, the unit kept", () => {
  const at = new Date(T).toISOString()
  const lines = [
    { at, sessionID: "root", kind: "UnitStarted", unit: "alpha", round: 2, direct: false, workspaces: ["/u/.rifts/app/web-3"] },
    { at, sessionID: "other", kind: "Checkpoint", state: { units: { beta: { state: "ready", round: 1, since: T, direct: false, workspaces: ["/u/.rifts/app/x"] } } } },
  ]
  expect(stateOf(DEFAULT_CADENCE, lines.slice(0, 1))).toEqual({ units: { alpha: { state: "implement", round: 2, since: T, direct: false } } })
  expect(stateOf(DEFAULT_CADENCE, lines.slice(1))).toEqual({ units: { beta: { state: "ready", round: 1, since: T, direct: false } } })
})

test("a unit's Rifts, as its starts named them, are kept through a compaction's checkpoint", () => {
  const lines = [
    lineOfEvent("root", UnitStarted.make({ unit: "db", round: 1, direct: false, rift: "/u/.rifts/app/db", at: T })),
    lineOfEvent("root", UnitStarted.make({ unit: "db", round: 2, direct: false, rift: "/u/.rifts/app/db-2", at: T + MIN })),
  ]
  const kept = compact(DEFAULT_CADENCE, retention, T + 2 * MIN, lines)
  expect(stateOf(DEFAULT_CADENCE, kept).units.db?.rifts).toEqual(["/u/.rifts/app/db", "/u/.rifts/app/db-2"])
})
