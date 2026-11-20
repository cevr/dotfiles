// The global configs `daily --configure` writes stay byte for byte what they were when the plugin
// lists became data (mods/update/trees.ts): the old updater's last handoff runs it (plugin-trees
// spec, Migration step 6). The golden (`daily-configure.golden.ts`) was written by this function at the
// change, and the change's own run of `--configure` before and after it, in two scratch homes on one
// host, wrote the same bytes but for the home's path.
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import { Option } from "effect"
import { settingsFor } from "../mods/update/process/install.ts"
import { CLI, EXISTING, SERVER } from "./daily-configure.golden.ts"
import { configured, type HostFacts, jsonText, pluginDir } from "./daily.ts"

const HOME = "/home/golden"

/** One host's facts, fixed: the MacBook, with a login store, a Tailscale address and a catalog of one Opus and one Fable. */
const FACTS: HostFacts = {
  host: "cristians-macbook-pro",
  tailscale: Option.some("100.64.0.7"),
  fleet: { dotfiles: `${HOME}/dotfiles`, fork: `${HOME}/fork` },
  catalog: {
    anthropic: {
      models: {
        "claude-opus-5-5": { family: "claude-opus", release_date: "2026-09-22" },
        "claude-fable-5-2": { family: "claude-fable", release_date: "2026-10-01" },
      },
    },
  },
  store: Option.some(`${HOME}/.local/share/opencode-prime/pool-auth`),
  settings: settingsFor({
    host: "cristians-macbook-pro",
    home: HOME,
    state: `${HOME}/.local/state`,
    checkout: `${HOME}/dotfiles`,
    fork: `${HOME}/fork`,
    bun: `${HOME}/.bun/bin/bun`,
    resident: `${HOME}/.local/state/opencode-prime/resident`,
    launcher: `${HOME}/.local/bin/opencode`,
  }),
}

/** This checkout's `opencode/` directory, which every plugin path starts with; the golden names it `<opencode>`. */
const ROOT = pluginDir("pool").slice(0, -"/cmd/pool".length)

describe("the global configs --configure writes", () => {
  test("are, byte for byte, the golden: our plugins in order with their options, the role models, the theme and every foreign key and plugin kept", () => {
    const written = configured(EXISTING, FACTS, `${HOME}/.local/share/opencode-prime`)
    expect(jsonText(written.server).replaceAll(ROOT, "<opencode>")).toBe(SERVER)
    expect(jsonText(written.cli).replaceAll(ROOT, "<opencode>")).toBe(CLI)
  })

  test("list every plugin with a TUI part in the TUI's config: a tree's server entries carry none, so a TUI gets a TUI part only from it", () => {
    // Read straight off the tree of plugins, not through the derivation: each `cmd/<name>` with a TUI entry file.
    const withTui = [...new Glob("cmd/*/tui.{ts,tsx}").scanSync(ROOT)].map((path) => `${ROOT}/${path.slice(0, path.lastIndexOf("/"))}`)
    const tui = jsonText(configured(EXISTING, FACTS, `${HOME}/.local/share/opencode-prime`).cli)
    expect(withTui.filter((dir) => !tui.includes(`"${dir}"`))).toEqual([])
    expect(withTui.length).toBeGreaterThan(10)
  })
})
