import { describe, expect, test } from "bun:test"
import { listsOurs, oursOf } from "./configs.ts"

const OWNED = oursOf("/h/dotfiles", "/h/.local/share/opencode-prime")
const UPDATE = { package: "/h/dotfiles/opencode/cmd/update", options: { host: "bite-cristian" } }

describe("the handoff's read of the server config for entries of ours (R2)", () => {
  test("finds our entries: the checkout's mods and cmd, the old auth loader, the built-ins off, the retired names", () => {
    const config = {
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-opus",
      plugins: ["/elsewhere/plugin", "/h/dotfiles/opencode/mods/prime", UPDATE, "/h/.local/share/opencode-prime/anthropic-auth/index.ts", "-opencode.tool.schedule", { package: "foreign-plugin" }, 7],
    }
    expect(listsOurs(config, OWNED)).toBe(true)
    for (const each of config.plugins) expect(listsOurs({ plugins: [each] }, OWNED)).toBe([1, 2, 3, 4].includes(config.plugins.indexOf(each)))
  })

  test("a config with nothing of ours lists none", () => {
    expect(listsOurs({ plugins: ["/elsewhere/plugin", "/h/dotfiles/opencode-other/mods"] }, OWNED)).toBe(false)
    expect(listsOurs({ model: "anthropic/claude-opus" }, OWNED)).toBe(false)
    expect(listsOurs({ plugins: "not a list" }, OWNED)).toBe(false)
  })

  test("another checkout's entries are not ours: only the live checkout's paths are", () => {
    expect(listsOurs({ plugins: ["/w/dotfiles/opencode/mods/prime"] }, OWNED)).toBe(false)
    expect(listsOurs({ plugins: ["/h/dotfiles/opencode/mods"] }, OWNED)).toBe(true)
  })
})
