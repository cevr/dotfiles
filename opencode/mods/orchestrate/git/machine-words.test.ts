// The machine's rules speak in the skill's words: each rule a refusal quotes
// (machine.ts `RULES`) is a sentence of the installed skill's SKILL.md, word
// for word, and its name is the heading or bold lead a run's `Departs from
// <rule>: <why>` line names it by. A skill edit that changes a sentence
// reddens this test, so the rule's words are changed with it, never left
// behind. The block a compacted root is told (agents.json `machine`,
// written by scripts/agents.ts) is SKILL.md's "The machine" section: the
// diagram and its four steps.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RULES } from "../machine.ts"

const ROOT = join(import.meta.dir, "../../..")
const skill = readFileSync(join(ROOT, "../skills/orchestrate/SKILL.md"), "utf8")
const flat = (text: string) => text.replace(/\s+/g, " ")

describe("the machine's words are the skill's", () => {
  test("each rule quotes SKILL.md word for word, under the name a departure names it by", () => {
    expect(Object.keys(RULES).sort()).toEqual(["BatchNotDue", "BatchUnverified", "LandPartial", "VerifierPerUnit", "VerifierRunning"])
    for (const [rule, { name, words }] of Object.entries(RULES)) {
      expect([rule, words.length > 20 && flat(skill).includes(flat(words))]).toEqual([rule, true])
      expect([rule, name.length > 0 && skill.includes(name)]).toEqual([rule, true])
    }
  })

  test("the block a compacted root is told is SKILL.md's machine section, generated", () => {
    const { machine } = JSON.parse(readFileSync(join(ROOT, "mods/orchestrate/agents.json"), "utf8")) as { machine?: string }
    expect(typeof machine).toBe("string")
    expect(skill).toContain(machine!)
    expect(machine!.startsWith("## The machine")).toBe(true)
    expect(machine).toContain("verify: ONE fresh verifier per batch, on the merged head")
    expect(machine).toContain("4. **Fan out what follows**")
    expect(machine).not.toContain("**States.**")
  })
})
