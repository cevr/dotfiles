// Which diffs make a land's merge check run the verify-opencode docs guard (scripts/docs-guard.ts), read from
// `git diff --name-status --relative` output as scripts/gate.ts reads it.
import { Effect } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { docsGuardDue, parseNameStatus } from "./docs-guard.ts"

const due = (out: string) => docsGuardDue(parseNameStatus(out))

describe("the merge check's docs guard", () => {
  it.effect("a docs-only diff runs it: rex-state's change to features/rex.md reached main with the guard red (batch 2026-11-15cp)", () =>
    Effect.sync(() => {
      expect(due("M\t.claude/skills/verify-opencode/features/rex.md\n")).toBe(true)
      expect(due("A\t.claude/skills/verify-opencode/features/escape.md\n")).toBe(true)
      expect(due("M\t.claude/skills/verify-opencode/SKILL.md\n")).toBe(true)
    }),
  )

  it.effect("so does a change to anything else the guard reads: AGENTS.md, package.json, its own code", () =>
    Effect.sync(() => {
      for (const path of ["AGENTS.md", "package.json", "scripts/verify-map.ts", "scripts/verify-docs.test.ts"]) expect(due(`M\t${path}\n`)).toBe(true)
    }),
  )

  it.effect("and a change to the tree the docs name: a deleted or renamed file, or a new world suite", () =>
    Effect.sync(() => {
      expect(due("D\tcmd/escape/escape-send.sim.test.tsx\n")).toBe(true)
      expect(due("R087\ttests/rex.test.ts\ttests/rex-pane.test.ts\n")).toBe(true)
      expect(due("A\tcmd/queue/queue-more.sim.test.ts\n")).toBe(true)
    }),
  )

  it.effect("an unrelated diff does not: source and tests changed or added in place", () =>
    Effect.sync(() => {
      expect(due("M\tmods/update/git/source.ts\nM\tmods/update/git/source.test.ts\nA\tcmd/escape/setup.test.ts\nM\tdocs/AGENTS-notes.md\n")).toBe(false)
      expect(due("")).toBe(false)
    }),
  )

  it.effect("one line that touches it is enough among many that do not", () =>
    Effect.sync(() => {
      expect(due("M\tmods/rex/model.ts\nM\tcmd/rex/show.ts\nM\t.claude/skills/verify-opencode/features/rex.md\n")).toBe(true)
    }),
  )
})
// @reads-indirect scripts/**
