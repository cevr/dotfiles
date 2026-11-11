// Public seam: real OpenCode (the fork, through its SDK) on the scripted
// model, with the orchestrate plugin and a fixture `rift` tool that only
// records its calls. A root that runs three units compacts mid-run and then
// drifts as the audited roots did (a verifier for one unit, a land of one
// Rift): the plugin tells it the machine and its run's state after the
// compaction, refuses both calls in the skill's words, and the run still
// lands as one batch and starts one verifier.
//
// The run is tests/orchestrate/run.ts's `machine` scenario; the root's script
// is the sim's `machine` task. The script keys on the last thing the root was
// told, never on a count of tool results: the compaction removes them.
//
//   1. `implementor alpha r1`, `implementor beta r1`, `implementor gamma r1`,
//      each in the foreground, each handing back `ready`;
//   2. the root's context passes its window, so it compacts before its next call;
//   3. `verifier alpha r1`                        → refused (VerifierPerUnit);
//   4. `rift({ action: "land", rifts: ["alpha"] })` → refused (LandPartial);
//   5. `rift({ action: "land", rifts: ["alpha", "beta", "gamma"] })` → runs;
//   6. `verifier batch-1 r1`                      → starts, hands back `accepted`;
//   7. a closing line.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { RULES } from "../mods/orchestrate/machine.ts"
import type { MoveResult, PipelineResult, Result, Spec } from "./orchestrate/run.ts"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/orchestrate-machine.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = mkdtempSync(join(tmpdir(), "orchestrate-machine-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** What the `machine` scenario adds to a run's result. */
interface MachineResult extends Result {
  /** The `rifts` of each land the fixture rift tool ran, in order: a refused call never reaches it. */
  readonly riftLands: ReadonlyArray<ReadonlyArray<string>>
  /** Each child of the root: its agent and its call's description. */
  readonly steps: ReadonlyArray<{ readonly agent: string; readonly description: string }>
  /** The ledger's lines for the root (the plugin's `ledger` file), each `{ at, sessionID, ... }`. */
  readonly ledger: ReadonlyArray<Record<string, unknown>>
  /** The root's own model requests in order, its compaction's summary request among them: the last message's text, and the messages as sent. */
  readonly rootRequests: ReadonlyArray<{ readonly last: string; readonly messages: ReadonlyArray<unknown> }>
}

/** Words of the machine block that nothing else in the run says. */
const BLOCK = "ONE fresh verifier per batch"

const run = async <R extends Result = MachineResult>(scenario: "machine" | "move" | "pipeline" = "machine"): Promise<R> => {
  const base = join(scratch, scenario)
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  const spec = { scenario, base, fork: resolve(fork ?? ""), plugin: join(ROOT, "cmd/orchestrate"), now: "2026-11-04T15:00:00Z" } as unknown as Spec
  writeFileSync(file, JSON.stringify(spec))
  const child = owned([process.execPath, join(import.meta.dir, "orchestrate/run.ts"), file], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 140_000)
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  clearTimeout(timer)
  const result = join(base, "result.json")
  if (child.exitCode !== 0 || !existsSync(result)) throw new Error(`the ${scenario} run failed (exit ${child.exitCode}):\n${stdout}\n${stderr}`)
  return JSON.parse(readFileSync(result, "utf8")) as R
}

const textOf = (value: unknown) => JSON.stringify(value)
const count = (text: string, part: string) => text.split(part).length - 1

describe.skipIf(!fork)("a root that compacts mid-run and drifts still lands as a batch and starts one verifier", () => {
  test(
    "the machine and the run's state follow the compaction; a verifier for one unit and a land of one Rift are refused in the skill's words; one land of three, one batch verifier",
    async () => {
      const result = await run()
      // The machine block is generated from SKILL.md (scripts/agents.ts), never hand-copied.
      const machine = (JSON.parse(readFileSync(join(ROOT, "mods/orchestrate/agents.json"), "utf8")) as { machine?: string }).machine ?? ""
      const skill = readFileSync(join(ROOT, "../skills/orchestrate/SKILL.md"), "utf8")
      expect(machine).toContain("ONE fresh verifier per batch")
      expect(skill).toContain(machine)

      // The root compacted once, and the requests after its summary request carry the block and the state.
      const requests = result.rootRequests
      const summary = requests.findIndex((seen) => seen.last.includes("You MUST summarize the conversation"))
      expect(summary).toBeGreaterThan(0)
      expect(requests.filter((seen) => seen.last.includes("You MUST summarize the conversation"))).toHaveLength(1)
      expect(textOf(requests.slice(0, summary + 1).map((seen) => seen.messages))).not.toContain(BLOCK)
      const after = requests.slice(summary + 1)
      expect(after.length).toBeGreaterThan(0)
      // In the root's context by its second request after the compaction, and once per compaction, not once per request.
      const told = after.findIndex((seen) => textOf(seen.messages).includes(BLOCK))
      expect(told).toBeGreaterThanOrEqual(0)
      expect(told).toBeLessThanOrEqual(1)
      const last = textOf(after.at(-1)!.messages)
      expect(count(last, BLOCK)).toBe(1)
      expect(last).toContain("ready: alpha")
      expect(last).toMatch(/a batch is due \(3 ready\)/)

      // The drift is refused in the skill's words, and nothing it asked for started.
      const root = textOf(result.root!.messages)
      expect(root).toContain(RULES.VerifierPerUnit.words)
      expect(root).toContain(RULES.LandPartial.words)
      expect(root).toContain("beta, gamma")

      // One land, of all three; one verifier, the batch's.
      expect(result.riftLands).toEqual([["alpha", "beta", "gamma"]])
      const verifiers = result.steps.filter((step) => step.agent === "verifier")
      expect(verifiers).toEqual([{ agent: "verifier", description: "verifier batch-1 r1" }])
      expect(result.steps.filter((step) => step.agent === "implementor").map((step) => step.description)).toEqual(["implementor alpha r1", "implementor beta r1", "implementor gamma r1"])

      // The ledger keeps what happened, for the drift metric: two refusals, one batch landed, one verifier over its three units.
      const kinds = result.ledger.map((line) => line.kind)
      expect(kinds.filter((kind) => kind === "Refused")).toHaveLength(2)
      expect(result.ledger.filter((line) => line.kind === "Refused").map((line) => line.rule)).toEqual(["VerifierPerUnit", "LandPartial"])
      expect(result.ledger.find((line) => line.kind === "BatchLanded")).toMatchObject({ units: ["alpha", "beta", "gamma"] })
      expect(result.ledger.find((line) => line.kind === "VerifierStarted")).toMatchObject({ batch: "batch-1", units: ["alpha", "beta", "gamma"] })
      expect(kinds).not.toContain("Departed")
    },
    200_000,
  )
})

// The pipeline (SKILL.md, "The pipeline"), in real OpenCode: batch-2 fans out
// while batch-1's verifier runs; the verdict's two findings fold forward, one
// into a running implementor (a follow-up with its sessionID), one into a new
// fix unit; batch-2 lands once the verdict is in and both are folded into
// ready units, and its one verifier is told them.
describe.skipIf(!fork)("a root runs batches as a pipeline", () => {
  // One run of the scenario serves both tests: the pipeline, and round 1's edges on a root of their own.
  let piped: Promise<PipelineResult> | undefined
  const pipeline = () => (piped ??= run<PipelineResult>("pipeline"))
  test(
    "fan-out during verify, a fold into a running implementor and one into a fix unit, the land after the verdict, the next verifier told the folds; a land before the verdict and one with a finding unfolded are refused",
    async () => {
      const result = await pipeline()
      const lines = result.ledger
      const kinds = lines.map((line) => line.kind)
      // Batch-2's implementors started while batch-1's verifier ran: no start was refused.
      const verifying = kinds.indexOf("VerifierStarted")
      const verdict = kinds.indexOf("VerifierEnded")
      expect(lines.slice(verifying, verdict).filter((line) => line.kind === "UnitStarted").map((line) => line.unit)).toEqual(["search", "export"])
      // The two drifts are refused in the skill's words, and neither land reached the rift tool.
      expect(lines.filter((line) => line.kind === "Refused").map((line) => line.rule)).toEqual(["VerdictPending", "FindingUnfolded"])
      const root = JSON.stringify(result.root!.messages)
      expect(root).toContain(RULES.VerdictPending.words)
      expect(root).toContain(RULES.FindingUnfolded.words)
      expect(result.riftLands).toEqual([["auth", "billing"], ["search", "export", "billing-fix1"]])
      // The verdict's findings, read from its report, and where each was folded.
      expect(lines.find((line) => line.kind === "VerifierEnded")).toMatchObject({ batch: "batch-1", verdict: "changes", findings: ["auth/M1", "billing/M1"] })
      expect(lines.filter((line) => line.kind === "FindingFolded").map((line) => [line.finding, line.into])).toEqual([["auth/M1", "export"], ["billing/M1", "billing-fix1"]])
      expect(lines.find((line) => line.kind === "BatchLanded" && (line.units as ReadonlyArray<string>).includes("export"))).toMatchObject({ units: ["search", "export", "billing-fix1"] })
      // One verifier for batch-2, told batch-1's findings as folded, in its prompt.
      expect(lines.filter((line) => line.kind === "VerifierStarted").map((line) => line.batch)).toEqual(["batch-1", "batch-2"])
      expect(lines.findLast((line) => line.kind === "VerifierStarted")).toMatchObject({ units: ["search", "export", "billing-fix1"], findings: ["auth/M1 → export", "billing/M1 → billing-fix1"] })
      // The verifier's own request: its prompt, not the root's probe that asked for it.
      const told = result.seen.find((seen) => JSON.stringify(seen.messages).includes("verifier batch-2 r1: accepted") && !JSON.stringify(seen.messages).includes("probe:"))
      expect(JSON.stringify(told?.messages)).toContain("- batch-1 auth/M1 → export\\n- batch-1 billing/M1 → billing-fix1")
      expect(kinds).not.toContain("Departed")
    },
    200_000,
  )

  // orch-pipeline r1's live probes, promoted: M2, a covered unit's next round does not end its batch's wait; M1, a
  // `changes` whose report does not read is never an empty set of findings.
  test(
    "a covered unit's round 2 cannot land while its batch's verifier runs; a changes whose report does not read holds the land until it reads and its finding folds",
    async () => {
      const { edges } = await pipeline()
      const lines = edges.ledger
      const refused = lines.filter((line) => line.kind === "Refused")
      expect(refused.map((line) => line.rule)).toEqual(["VerdictPending", "FindingUnfolded", "FindingUnfolded"])
      // M2: refused while batch-r1's verifier ran, after repeat r2 handed back ready; landed once the verdict was in.
      const verdict = lines.findIndex((line) => line.kind === "VerifierEnded" && line.batch === "batch-r1")
      expect(lines.indexOf(refused[0]!)).toBeLessThan(verdict)
      expect(lines.slice(0, verdict).filter((line) => line.kind === "BatchLanded")).toHaveLength(1)
      expect(String(refused[0]!.message)).toContain("Verifier batch-r1 still runs over repeat")
      // M1: the verdict whose report did not read is unresolved, not empty; the refusal says which report.
      expect(lines.find((line) => line.kind === "VerifierEnded" && line.batch === "batch-m1")).toMatchObject({
        verdict: "changes",
        unresolved: { report: expect.stringContaining("batch-m1-findings.md"), why: expect.stringContaining("does not read") },
      })
      expect(String(refused[1]!.message)).toContain("The findings of batch-m1's `changes` are not known")
      // Written since, the report is read again at the next land: its finding opens, unfolded, then folds into a fix unit.
      expect(lines.find((line) => line.kind === "ReportResolved")).toMatchObject({ batch: "batch-m1", findings: ["repeat/M1"] })
      expect(String(refused[2]!.message)).toContain("repeat/M1 (not folded)")
      expect(lines.filter((line) => line.kind === "FindingFolded").map((line) => [line.finding, line.into])).toEqual([["repeat/M1", "repeat-fix1"]])
      expect(edges.riftLands).toEqual([["repeat"], ["repeat"], ["after", "repeat-fix1"]])
      expect(lines.map((line) => line.kind)).not.toContain("Departed")
    },
    200_000,
  )
})

// The verifier's location probe (round 1, M1): a root that moves between two
// directories is decided by two plugin copies, one per location, over one
// ledger. Each must see the other's lines.
describe.skipIf(!fork)("a root that moves between locations is held to one machine", () => {
  test(
    "a land of one of two ready units made in two places is refused; a run that keeps the machine across moves is never refused",
    async () => {
      const result = await run<MoveResult>("move")
      expect(result.partial.filter((line) => line.kind === "Refused").map((line) => line.rule)).toEqual(["LandPartial"])
      expect(result.legal.filter((line) => line.kind === "Refused")).toEqual([])
      expect(result.legal.filter((line) => line.kind === "BatchLanded").map((line) => line.units)).toEqual([["legal-a", "legal-b"], ["legal-c"]])
      expect(result.legal.find((line) => line.kind === "VerifierEnded")).toMatchObject({ batch: "batch-1", verdict: "accepted" })
      expect(result.riftLands).toEqual([["legal-a", "legal-b"], ["legal-c"]])
    },
    200_000,
  )
})
