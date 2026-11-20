// scripts/agents.ts's orchestrator entry: its section carries SKILL.md's no-block rule word for word, and `--check`
// fails once that line changes in the skill without `bun run agents` writing agents.json again.
import { describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { scratch } from "../tests/scratch.ts"
import { build, DEFAULT_SOURCE, NO_BLOCK, ORCHESTRATOR, orchestratorSection, ROOT, stale } from "./agents.ts"

const skill = readFileSync(join(DEFAULT_SOURCE, "SKILL.md"), "utf8")
const rule = skill.split("\n").find((line) => line.startsWith(NO_BLOCK))

/** The orchestrate skill and what its agents script reads beside it (loop/safety.md, the agents dir), under `dir`. */
const copySkill = (dir: string) => {
  const source = join(dir, "skills/orchestrate")
  mkdirSync(join(source, "scripts"), { recursive: true })
  for (const file of ["SKILL.md", "protocol.md", "scripts/agents.ts"]) cpSync(join(DEFAULT_SOURCE, file), join(source, file))
  mkdirSync(join(dir, "skills/loop"), { recursive: true })
  cpSync(join(DEFAULT_SOURCE, "../loop/safety.md"), join(dir, "skills/loop/safety.md"))
  cpSync(join(DEFAULT_SOURCE, "../../agents"), join(dir, "agents"), { recursive: true })
  return source
}

describe("the orchestrator entry", () => {
  test("its section ends with SKILL.md's no-block rule, word for word", async () => {
    expect(rule).toBeDefined()
    const written = JSON.parse((await build()).text) as { [ORCHESTRATOR]: { section: string; description: string } }
    expect(written[ORCHESTRATOR].section.endsWith(rule!.slice(2))).toBe(true)
    expect(written[ORCHESTRATOR].section).toContain("Load the `orchestrate` skill before you coordinate")
    expect(written[ORCHESTRATOR].section).toContain("A plain question or a small edit needs no run")
  })

  test("--check is green on the written file", async () => {
    expect(stale(await build())).toBe(false)
    const check = Bun.spawnSync([process.execPath, join(ROOT, "scripts/agents.ts"), "--check"], { stderr: "pipe" })
    expect(check.exitCode).toBe(0)
  })

  test("--check fails when the skill's rule line is edited without regenerating", () => {
    using dir = scratch("agents-check-")
    const source = copySkill(dir.path)
    const run = () => Bun.spawnSync([process.execPath, join(ROOT, "scripts/agents.ts"), "--check", "--source", source], { stderr: "pipe" })
    // The copy as it is matches the written file.
    expect(run().exitCode).toBe(0)
    writeFileSync(join(source, "SKILL.md"), skill.replace(rule!, rule!.replace("about 10 seconds", "about 30 seconds")))
    const edited = run()
    expect(edited.exitCode).toBe(1)
    expect(edited.stderr.toString()).toContain("stale:")
  })

  test("a skill that lost the rule fails the build, naming it", () => {
    expect(() => orchestratorSection(skill.replace(rule!, ""))).toThrow(NO_BLOCK)
  })
})
