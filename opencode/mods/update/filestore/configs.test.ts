import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Configs } from "../service.ts"
import { layer, listsOurs, oursOf, type Paths, stripped, tuiKeptOf, tuiOursOf } from "./configs.ts"

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

describe("the late strip of the TUI config, on files", () => {
  /** A scratch config directory and its kept directory, with `layer`'s paths over them. */
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "late-strip-"))
    const paths: Paths = {
      config: [join(dir, "opencode.json"), join(dir, "cli.json")],
      kept: join(dir, "kept"),
      server: join(dir, "opencode.json"),
      owned: OWNED,
      tui: join(dir, "cli.json"),
      tuiOwned: tuiOursOf("/h/dotfiles", "/h/.local/share/opencode-prime"),
    }
    return { dir, paths, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) }
  }
  const configs = (paths: Paths) => <A, E>(use: (each: Configs["Service"]) => Effect.Effect<A, E>) => Effect.runPromise(Configs.use(use).pipe(Effect.provide(layer(paths))))

  test("keeps the TUI config byte for byte under its own name, then drops our entries (the checkout's, the built-ins off) and keeps every other key and entry", async () => {
    using each = scratch()
    const before = `${JSON.stringify({ theme: { name: "prime" }, tabs: { scope: "window" }, plugins: ["/h/dotfiles/opencode/cmd/prime", "/mine/tui-plugin", "/h/dotfiles/opencode/cmd/queue", "-opencode.btw"] }, null, 2)}\n`
    writeFileSync(each.paths.tui, before)
    writeFileSync(join(each.dir, "opencode.json"), "{}\n")
    const use = configs(each.paths)
    expect(await use((one) => one.tuiOurs)).toBe(true)
    await use((one) => one.stripTui)
    expect(readFileSync(tuiKeptOf(each.paths), "utf8")).toBe(before)
    expect(JSON.parse(readFileSync(each.paths.tui, "utf8"))).toEqual({ theme: { name: "prime" }, tabs: { scope: "window" }, plugins: ["/mine/tui-plugin"] })
    expect(await use((one) => one.tuiOurs)).toBe(false)
    // The migration's copies are not the late strip's: a restore of them never brings the TUI config back.
    expect(existsSync(join(each.paths.kept, "cli.json"))).toBe(false)
    // A second strip writes nothing and keeps the first copy.
    await use((one) => one.stripTui)
    expect(readFileSync(tuiKeptOf(each.paths), "utf8")).toBe(before)
  })

  test("a TUI config that is absent or lists none of ours is not written; one that is not JSON fails, written nothing", async () => {
    using each = scratch()
    const use = configs(each.paths)
    expect(await use((one) => one.tuiOurs)).toBe(false)
    await use((one) => one.stripTui)
    expect([existsSync(each.paths.tui), existsSync(tuiKeptOf(each.paths))]).toEqual([false, false])
    writeFileSync(each.paths.tui, `{ "plugins": ["/mine/tui-plugin"] }\n`)
    await use((one) => one.stripTui)
    expect([readFileSync(each.paths.tui, "utf8"), existsSync(tuiKeptOf(each.paths))]).toEqual([`{ "plugins": ["/mine/tui-plugin"] }\n`, false])
    writeFileSync(each.paths.tui, `{ // a comment\n "plugins": ["/h/dotfiles/opencode/cmd/prime"] }\n`)
    expect(await Effect.runPromise(Effect.flip(Configs.use((one) => one.stripTui).pipe(Effect.provide(layer(each.paths)))))).toMatchObject({ step: "read the TUI config" })
    expect(existsSync(tuiKeptOf(each.paths))).toBe(false)
  })
})
