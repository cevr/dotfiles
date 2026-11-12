// The drift of each root of a recorded ledger: the machine's JSONL file of
// 2026-11-12 (fixtures/, a scrubbed copy of ~/.cache/orchestrate/machine.jsonl:
// session ids faked, home paths and refusal messages cut), read through the
// file ledger and scored line by line (drift.ts).
import { afterAll, describe, expect, test } from "bun:test"
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { CLEAN, driftLine, driftOf, scoreOf } from "../drift.ts"
import { compact, type Line, lineOfRefusal } from "../ledger.ts"
import { DEFAULT_CADENCE, Refused, Start } from "../machine.ts"
import { Ledger } from "../service.ts"
import * as FileLedger from "./ledger.ts"

const FIXTURE = join(import.meta.dir, "fixtures/machine-2026-11-12.jsonl")
const MIN = 60_000
const WEEK = 7 * 24 * 60 * MIN

const lines = FileLedger.linesIn(readFileSync(FIXTURE, "utf8")) as ReadonlyArray<Line>
const roots = [...new Set(lines.map((line) => line.sessionID))]
const of = (root: string) => lines.filter((line) => line.sessionID === root)

const scratch = mkdtempSync(join(tmpdir(), "drift-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe("the ledger of 2026-11-12", () => {
  test("the dotfiles root drifted 29: the j-l verdicts' stale findings and batch m's, folded into an ended unit, are the ledger's; the dropped finding and the real departures are the run's", async () => {
    const file = join(scratch, "machine.jsonl")
    copyFileSync(FIXTURE, file)
    const drift = await Effect.runPromise(Effect.flatMap(Ledger, (ledger) => ledger.drift("ses_root007")).pipe(Effect.provide(FileLedger.layer(file, DEFAULT_CADENCE))))
    expect(drift.counts).toEqual({ unfoldedLand: 1, departed: 1, verifierPerUnit: 0, offCadence: 2, refused: 3, stale: 12 })
    expect(scoreOf(drift)).toBe(29)
    expect(drift.dropped).toEqual(["land-upstream/M1"])
    // The departures around the j-l verdicts' findings are stale, and so are batch m's: a finding folded into an ended unit is never open again.
    expect(drift.departures.filter((departure) => departure.why.startsWith("stale ledger")).map((departure) => departure.stale)).toEqual([["FindingUnfolded"], ["FindingUnfolded"]])
    expect(drift.departures.filter((departure) => departure.why.startsWith("batch m")).map((departure) => departure.stale)).toEqual([["FindingUnfolded"], ["FindingUnfolded"]])
  })

  test("the hymn root drifted 4, and every other root is clean", () => {
    expect(driftLine(driftOf(DEFAULT_CADENCE, of("ses_root009")))).toBe("drift 4: 1 off cadence ×2, 2 refused ×1")
    const others = roots.filter((root) => root !== "ses_root007" && root !== "ses_root009")
    expect(others.length).toBe(14)
    for (const root of others) expect(driftOf(DEFAULT_CADENCE, of(root))).toEqual(CLEAN)
  })

  test("a compaction keeps each root's drift: its tally line stands for the lines it drops, and lines after it count on it", () => {
    const last = Math.max(...lines.map((line) => Date.parse(line.at)))
    const retention = { bytes: 0, idleMs: WEEK, roots: 64, audit: 2 }
    const kept = compact(DEFAULT_CADENCE, retention, last + MIN, lines)
    expect(kept.length).toBeLessThan(lines.length / 2)
    for (const root of roots) expect(driftOf(DEFAULT_CADENCE, kept.filter((line) => line.sessionID === root))).toEqual(driftOf(DEFAULT_CADENCE, of(root)))
    // And a refusal after the compaction counts on the tally.
    const verifier = Start.make({ role: "verifier", name: "hsstart", round: 1, direct: false })
    const after = lineOfRefusal("ses_root009", last + 2 * MIN, new Refused({ rule: "VerifierPerUnit", message: "-" }), verifier)
    const twice = compact(DEFAULT_CADENCE, retention, last + 3 * MIN, [...kept, after])
    expect(driftOf(DEFAULT_CADENCE, twice.filter((line) => line.sessionID === "ses_root009")).counts).toMatchObject({ refused: 3, offCadence: 1 })
  })
})
