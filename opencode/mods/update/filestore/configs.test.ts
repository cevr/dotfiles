import { describe, expect, test } from "bun:test"
import { listsOurs, oursOf, stripped } from "./configs.ts"

const OWNED = oursOf("/h/dotfiles", "/h/.local/share/opencode-prime")
const UPDATE = { package: "/h/dotfiles/opencode/cmd/update", options: { host: "bite-cristian" } }

describe("the first tree install's strip of the server config", () => {
  test("drops our entries (the checkout's mods and cmd, the old auth loader, the built-ins off, the retired names), keeps the rest in order and every other key", () => {
    const config = {
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-opus",
      plugins: ["/elsewhere/plugin", "/h/dotfiles/opencode/mods/prime", UPDATE, "/h/.local/share/opencode-prime/anthropic-auth/index.ts", "-opencode.tool.schedule", { package: "foreign-plugin" }, 7],
    }
    expect(listsOurs(config, OWNED)).toBe(true)
    expect(stripped(config, OWNED)).toEqual({ $schema: "https://opencode.ai/config.json", model: "anthropic/claude-opus", plugins: ["/elsewhere/plugin", { package: "foreign-plugin" }, 7] })
  })

  test("a config with nothing of ours lists none, so the strip writes nothing", () => {
    expect(listsOurs({ plugins: ["/elsewhere/plugin", "/h/dotfiles/opencode-other/mods"] }, OWNED)).toBe(false)
    expect(listsOurs({ model: "anthropic/claude-opus" }, OWNED)).toBe(false)
    expect(listsOurs({ plugins: "not a list" }, OWNED)).toBe(false)
  })

  test("another checkout's entries are not ours: only the live checkout's paths are", () => {
    expect(listsOurs({ plugins: ["/w/dotfiles/opencode/mods/prime"] }, OWNED)).toBe(false)
    expect(listsOurs({ plugins: ["/h/dotfiles/opencode/mods"] }, OWNED)).toBe(true)
  })
})
