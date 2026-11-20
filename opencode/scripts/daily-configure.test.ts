// What a build's tree gives the TUI (`config/cli.json`, daily's `tuiEntries`): every plugin with a TUI
// part, in the old scheme's order. A tree's server entries carry no TUI part, so this list is the only
// way a TUI gets one.
// @reads cmd/*/tui.ts cmd/*/tui.tsx cmd/*/package.json
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import { Schema } from "effect"
import { tuiPluginsOf } from "../mods/update/trees.ts"
import { pluginDir, tuiEntries } from "./daily.ts"

/** This checkout's `opencode/` directory, which every plugin path starts with. */
const ROOT = pluginDir("pool").slice(0, -"/cmd/pool".length)

/** The TUI's plugin list a tree of this checkout gets, as its overlay's text. */
const tuiText = () => Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(tuiEntries(ROOT, (name) => pluginDir(name)))

describe("the TUI's plugin list in a build's tree", () => {
  test("lists every plugin with a TUI part: a tree's server entries carry none, so a TUI gets a TUI part only from it", () => {
    // Read straight off the tree of plugins, not through the derivation: each `cmd/<name>` with a TUI entry file.
    const withTui = [...new Glob("cmd/*/tui.{ts,tsx}").scanSync(ROOT)].map((path) => `${ROOT}/${path.slice(0, path.lastIndexOf("/"))}`)
    const tui = tuiText()
    expect(withTui.filter((dir) => !tui.includes(`"${dir}"`))).toEqual([])
    expect(withTui.length).toBeGreaterThan(10)
  })

  test("loads the TUI's plugins in the old scheme's order, whatever order the packages list in: Prime, the pool's status section second, then the rest as before, and a plugin it never listed after them, by name", () => {
    const tui = (name: string) => ({ name, manifest: `{ "exports": { "./tui": "./tui.tsx" } }` })
    const serverOnly = (name: string) => ({ name, manifest: `{ "exports": { "./server": "./server.ts" } }` })
    const packages = [tui("zeta"), tui("escape"), serverOnly("pool"), tui("queue"), tui("status"), tui("cache"), tui("prime"), tui("alpha"), tui("git")]
    expect(tuiPluginsOf(packages)).toEqual(["prime", "status", "git", "cache", "escape", "alpha", "queue", "zeta"])
    expect(tuiPluginsOf(packages.toReversed())).toEqual(tuiPluginsOf(packages))
    // This checkout's plugins: the list the TUI had before trees, and Queue, which reached it through the server, after it.
    const text = tuiText()
    const order = ["prime", "status", "herdr", "rex", "git", "cache", "questions", "model-next", "btw", "skills", "recover", "orchestrate", "escape", "queue"]
    const places = order.map((name) => text.indexOf(`"${ROOT}/cmd/${name}"`))
    expect(places.every((place) => place >= 0)).toBe(true)
    expect(places).toEqual(places.toSorted((left, right) => left - right))
    expect(text.split(`"${ROOT}/cmd/`).length - 1).toBe(order.length)
  })
})
