import { describe, expect, test } from "bun:test"
import { attachments, catalog, label, resolve, row, type Entry } from "./catalog.ts"
import type { Found } from "./tier.ts"

const found = (id: string, tier: Found["tier"], path: string): Found => ({ id, name: id, path, content: "", tier })

const local = found("review", "local", "/p/.claude/skills/review/SKILL.md")
const global = found("review", "global", "/h/.claude/skills/review/SKILL.md")
const deploy = found("deploy", "global", "/h/.claude/skills/deploy/SKILL.md")

/**
 * The registry after the tier edits: OpenCode kept the global review under
 * the plain id, beside the two qualified copies; a global deploy; a plugin's skill.
 */
const entries = catalog(
  [
    { id: "review:global", path: global.path, description: "global review" },
    { id: "plugin", path: "/plugin/SKILL.md" },
    { id: "review", path: global.path, description: "global review" },
    { id: "review:local", path: local.path, description: "local review" },
    { id: "deploy", path: deploy.path },
  ],
  [local, global, deploy],
)

describe("the catalog", () => {
  test("each registered skill with its tier, sorted by id; an id both tiers hold is its local copy and the global one it shadows", () => {
    expect(entries).toEqual([
      { token: "deploy", id: "deploy", tier: "global", shadowed: false },
      { token: "plugin", id: "plugin", shadowed: false },
      { token: "review", id: "review:local", description: "local review", tier: "local", shadowed: false },
      { token: "review:global", id: "review:global", description: "global review", tier: "global", shadowed: true },
    ])
    expect(entries.map(label)).toEqual(["global", undefined, "local", "global · shadowed"])
  })

  test("a popup row inserts the token and attaches the registry id, tagged by tier", () => {
    expect(entries.map(row)).toEqual([
      { value: "deploy", label: "global", part: { type: "skill", id: "deploy" } },
      { value: "plugin", part: { type: "skill", id: "plugin" } },
      { value: "review", description: "local review", label: "local", part: { type: "skill", id: "review:local" } },
      { value: "review:global", description: "global review", label: "global · shadowed", part: { type: "skill", id: "review:global" } },
    ])
  })
})

describe("resolving a token", () => {
  test("a plain id takes the plain entry: the local copy when both tiers hold it", () => {
    expect(resolve({ id: "review" }, entries)).toBe("review:local")
    expect(resolve({ id: "plugin" }, entries)).toBe("plugin")
  })

  test(":global takes the shadowed copy, or the plain entry when it is global", () => {
    expect(resolve({ id: "review", tier: "global" }, entries)).toBe("review:global")
    expect(resolve({ id: "deploy", tier: "global" }, entries)).toBe("deploy")
  })

  test(":local takes the plain entry only when it is local", () => {
    expect(resolve({ id: "review", tier: "local" }, entries)).toBe("review:local")
    expect(resolve({ id: "deploy", tier: "local" }, entries)).toBeUndefined()
  })

  test("an unknown id names nothing", () => {
    expect(resolve({ id: "nope" }, entries)).toBeUndefined()
    expect(resolve({ id: "plugin", tier: "global" }, entries)).toBeUndefined()
  })
})

describe("a prompt's attachments", () => {
  test("each known token once, in order, skipping what the prompt attaches already; unknown tokens stay text", () => {
    const text = "$review then $nope, $review:global and $review again, `$deploy`, $plugin"
    expect(attachments(text, ["plugin"], entries)).toEqual([
      { id: "review:local", mention: { start: 0, end: 7, text: "$review" } },
      { id: "review:global", mention: { start: 20, end: 34, text: "$review:global" } },
    ])
  })

  test("nothing to attach in a price or an empty catalog", () => {
    const none: ReadonlyArray<Entry> = []
    expect(attachments("$5 for $review", [], none)).toEqual([])
    expect(attachments("costs $5", [], entries)).toEqual([])
  })
})
