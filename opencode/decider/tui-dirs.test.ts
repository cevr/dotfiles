// The TUI's host dirs: HOME and the XDG base dirs from the config source in
// force, each XDG dir under HOME when its variable is unset or empty; an
// install's undo puts the source before it back. Its registry is process-wide
// (Symbol.for), so a plugin that loaded its own copy reads the same source.
import { describe, expect, test } from "bun:test"
import { ConfigProvider } from "effect"
import * as TuiDirs from "./tui-dirs.ts"

const source = (env: Record<string, string>) => ConfigProvider.fromEnv({ env })

describe("TuiDirs.dirs", () => {
  test("an installed source's XDG dirs, as set", () => {
    const undo = TuiDirs.install(
      source({ HOME: "/h", XDG_STATE_HOME: "/s", XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: "/c", XDG_CACHE_HOME: "/k" }),
    )
    expect(TuiDirs.dirs()).toEqual({ home: "/h", state: "/s", data: "/d", config: "/c", cache: "/k" })
    undo()
  })

  test("each XDG dir under HOME when unset or empty", () => {
    const undo = TuiDirs.install(source({ HOME: "/h", XDG_STATE_HOME: "" }))
    expect(TuiDirs.dirs()).toEqual({ home: "/h", state: "/h/.local/state", data: "/h/.local/share", config: "/h/.config", cache: "/h/.cache" })
    undo()
  })

  test("an install's undo puts the source before it back", () => {
    const outer = TuiDirs.install(source({ HOME: "/outer" }))
    const inner = TuiDirs.install(source({ HOME: "/inner" }))
    expect(TuiDirs.dirs().home).toBe("/inner")
    inner()
    expect(TuiDirs.dirs().home).toBe("/outer")
    outer()
  })
})
