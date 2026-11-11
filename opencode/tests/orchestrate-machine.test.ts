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
import type { Result, Spec } from "./orchestrate/run.ts"
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

const run = async (): Promise<MachineResult> => {
  const base = join(scratch, "machine")
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  const spec = { scenario: "machine", base, fork: resolve(fork ?? ""), plugin: join(ROOT, "cmd/orchestrate"), now: "2026-11-04T15:00:00Z" } as unknown as Spec
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
  if (child.exitCode !== 0 || !existsSync(result)) throw new Error(`the machine run failed (exit ${child.exitCode}):\n${stdout}\n${stderr}`)
  return JSON.parse(readFileSync(result, "utf8")) as MachineResult
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
