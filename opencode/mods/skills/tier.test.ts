import { describe, expect, test } from "bun:test"
import { edits, type Found } from "./tier.ts"

const found = (id: string, tier: Found["tier"], path: string): Found => ({ id, name: id, path, content: `${tier} ${id}`, tier })

const local = found("review", "local", "/p/.claude/skills/review/SKILL.md")
const parent = found("review", "local", "/.claude/skills/review/SKILL.md")
const global = found("review", "global", "/h/.config/opencode/skills/review/SKILL.md")
const home = found("review", "global", "/h/.claude/skills/review/SKILL.md")

describe("tier edits", () => {
  test("both tiers hold an id: each tier's nearest copy is added under its qualified id, and the local one already holds the id", () => {
    expect(edits([{ id: "review", path: local.path }], [local, parent, global, home])).toEqual([
      { id: "review:local", skill: local },
      { id: "review:global", skill: global },
    ])
  })

  test("OpenCode kept the global one under the id: the local one takes it back", () => {
    expect(edits([{ id: "review", path: global.path }], [local, global])).toEqual([
      { id: "review", skill: local },
      { id: "review:local", skill: local },
      { id: "review:global", skill: global },
    ])
  })

  test("an id only one tier holds is left alone, as is a skill no scan found", () => {
    expect(edits([{ id: "review", path: global.path }, { id: "plugin", path: "/x" }], [global, home])).toEqual([])
    expect(edits([{ id: "review", path: local.path }], [local, parent])).toEqual([])
  })
})
