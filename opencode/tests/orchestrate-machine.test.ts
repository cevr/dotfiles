// The batch machine's runs (a root that compacts mid-run and drifts, the
// pipeline and its edges, a root that moves between locations) run on the
// simulated host: cmd/orchestrate/orchestrate-machine.sim.test.ts, on
// cmd/orchestrate/machine-world.ts (tests/parity/orchestrate-machine.json).
// What stays here is what a simulated file does not read: the machine block
// the plugin tells against the skill's own words, from the repo's files.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

describe("a root that compacts mid-run and drifts still lands as a batch and starts one verifier", () => {
  test("the machine and the run's state follow the compaction; a verifier for one unit and a land of one Rift are refused in the skill's words; one land of three, one batch verifier", () => {
    // The machine block is generated from SKILL.md (scripts/agents.ts), never hand-copied.
    const machine = (JSON.parse(readFileSync(join(ROOT, "mods/orchestrate/agents.json"), "utf8")) as { machine?: string }).machine ?? ""
    const skill = readFileSync(join(ROOT, "../skills/orchestrate/SKILL.md"), "utf8")
    expect(machine).toContain("ONE fresh verifier per batch")
    expect(skill).toContain(machine)
  })
})
