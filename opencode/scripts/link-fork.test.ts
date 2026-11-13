// `bun run link-fork` refuses an OPENCODE_DEV that is not an installed OpenCode
// checkout on this machine, before it touches any node_modules, and never
// leaves a link that points nowhere. The script runs from a copy in a scratch
// workspace (its root is the folder above the script), against a scratch fork.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** A fork path that exists on no machine, like a Mac path on the workbox. */
const ELSEWHERE = "/nonexistent/loop-probe-x/.rifts/opencode/prime-look"

let scratch: string
let workspace: string
let fork: string
const packages = () => ["mods/a", "cmd/b", "decider"].map((dir) => join(workspace, dir))

const file = (path: string, text = "{}") => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

/** A fork with its TUI package installed: the plugin API, Solid and Effect. */
const makeFork = (dir: string, options: { readonly checkout?: boolean } = {}) => {
  if (options.checkout !== false) file(join(dir, "packages/tui/package.json"))
  for (const name of ["@opencode/plugin", "solid-js", "effect"]) file(join(dir, "packages/tui/node_modules", name, "package.json"))
  return dir
}

const run = (dev: string | undefined) => {
  const env: Record<string, string | undefined> = { ...process.env, OPENCODE_DEV: dev, OPENCODE_FORK_ANCHORS: join(scratch, "state/opencode-fork") }
  if (dev === undefined) delete env.OPENCODE_DEV
  const child = Bun.spawnSync([process.execPath, join(workspace, "scripts/link-fork.ts")], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" })
  return { code: child.exitCode, err: child.stderr.toString() }
}

/** Every entry of every package's node_modules, one level into scopes, with its link text. */
const snapshot = () =>
  packages().flatMap((dir) => {
    const modules = join(dir, "node_modules")
    if (!existsSync(modules)) return [`${dir}: none`]
    const walk = (at: string): ReadonlyArray<string> =>
      readdirSync(at).flatMap((name) => {
        const path = join(at, name)
        const stat = lstatSync(path)
        if (stat.isSymbolicLink()) return [`${path} -> ${readlinkSync(path)}`]
        return name.startsWith("@") && stat.isDirectory() ? walk(path) : [`${path}`]
      })
    return walk(modules)
  })

/** The links in the packages' node_modules that resolve to nothing. */
const dangling = () =>
  snapshot()
    .filter((entry) => entry.includes(" -> "))
    .map((entry) => entry.split(" -> ")[0]!)
    .filter((link) => !existsSync(link))

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "link-fork-"))
  workspace = join(scratch, "dotfiles")
  for (const dir of packages()) {
    file(join(dir, "package.json"))
    // A workspace link Bun made, which the script must leave alone.
    mkdirSync(join(dir, "node_modules/@dotfiles"), { recursive: true })
  }
  // The script and the check it shares with the gate, accept and daily.
  for (const name of ["link-fork.ts", "fork.ts"])
    if (existsSync(join(import.meta.dir, name))) cpSync(join(import.meta.dir, name), join(workspace, "scripts", name))
  fork = makeFork(join(scratch, "fork"))
})

afterEach(() => rmSync(scratch, { recursive: true, force: true }))

describe("link-fork", () => {
  test("links the fork's modules into every package, each one resolving", () => {
    expect(run(fork)).toMatchObject({ code: 0 })
    for (const dir of packages()) {
      expect(realpathSync(join(dir, "node_modules/solid-js"))).toBe(realpathSync(join(fork, "packages/tui/node_modules/solid-js")))
      expect(existsSync(join(dir, "node_modules/@opencode/plugin/package.json"))).toBe(true)
    }
    expect(dangling()).toEqual([])
  })

  test("a link names no machine's fork: pointing the checkout at another fork rewrites no synced link", () => {
    expect(run(fork)).toMatchObject({ code: 0 })
    const links = snapshot()
    expect(links.filter((entry) => entry.includes(" -> ")).length).toBe(9)
    for (const entry of links) expect(entry).not.toContain(" -> /")
    for (const entry of links) expect(entry).not.toContain(fork)
    // Another machine's fork, as the workbox holds one where the Mac holds its own.
    const other = makeFork(join(scratch, "other"))
    expect(run(other)).toMatchObject({ code: 0 })
    expect(snapshot()).toEqual(links)
    for (const dir of packages())
      expect(realpathSync(join(dir, "node_modules/solid-js"))).toBe(realpathSync(join(other, "packages/tui/node_modules/solid-js")))
  })

  test("replaces the absolute links an older run left, through the anchor", () => {
    for (const dir of packages()) symlinkSync(join(fork, "packages/tui/node_modules/solid-js"), join(dir, "node_modules/solid-js"))
    expect(run(fork)).toMatchObject({ code: 0 })
    for (const entry of snapshot()) expect(entry).not.toContain(" -> /")
    expect(dangling()).toEqual([])
  })

  test("refuses a fork path that does not exist on this machine, naming it and what it expected, and touches nothing", () => {
    const before = snapshot()
    const { code, err } = run(ELSEWHERE)
    expect(code).not.toBe(0)
    expect(err).toContain(ELSEWHERE)
    expect(err).toContain("does not exist")
    expect(err).toContain("packages/tui/node_modules")
    expect(snapshot()).toEqual(before)
  })

  test("refuses an unexpanded ~ and says to write $HOME", () => {
    const before = snapshot()
    const { code, err } = run("~/Developer/personal/.rifts/opencode/prime-look")
    expect(code).not.toBe(0)
    expect(err).toContain("$HOME")
    expect(snapshot()).toEqual(before)
  })

  test("refuses when OPENCODE_DEV is unset", () => {
    const { code, err } = run(undefined)
    expect(code).not.toBe(0)
    expect(err).toContain("OPENCODE_DEV is not set")
  })

  test("refuses a folder that is not an OpenCode checkout, even with the modules in place", () => {
    const stray = makeFork(join(scratch, "stray"), { checkout: false })
    const before = snapshot()
    const { code, err } = run(stray)
    expect(code).not.toBe(0)
    expect(err).toContain("packages/tui/package.json")
    expect(snapshot()).toEqual(before)
  })

  test("refuses a fork whose installed modules point nowhere, rather than linking to them", () => {
    // The fork's own install was copied from another machine: its solid-js is a link to a path absent here.
    const modules = join(fork, "packages/tui/node_modules")
    rmSync(join(modules, "solid-js"), { recursive: true })
    symlinkSync(join(ELSEWHERE, "packages/tui/node_modules/solid-js"), join(modules, "solid-js"))
    const before = snapshot()
    const { code, err } = run(fork)
    expect(code).not.toBe(0)
    expect(err).toContain("solid-js")
    expect(err).toContain("bun install")
    expect(snapshot()).toEqual(before)
    expect(dangling()).toEqual([])
  })

  test("accept runs the same check, before it runs or lists any test", () => {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "accept.ts"), "--list"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OPENCODE_DEV: ELSEWHERE },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(child.exitCode).not.toBe(0)
    expect(child.stdout.toString()).toBe("")
    expect(child.stderr.toString()).toContain(`accept: OPENCODE_DEV is '${ELSEWHERE}', which does not exist`)
  })

  test("repairs the links an earlier run left into a fork that is gone, the ones the new fork lacks too", () => {
    for (const dir of packages()) {
      const modules = join(dir, "node_modules")
      for (const name of ["solid-js", "gone", "@opencode"]) symlinkSync(join(ELSEWHERE, "packages/tui/node_modules", name), join(modules, name))
    }
    expect(dangling().length).toBe(9)
    expect(run(fork)).toMatchObject({ code: 0 })
    expect(dangling()).toEqual([])
    for (const dir of packages()) {
      expect(existsSync(join(dir, "node_modules/solid-js/package.json"))).toBe(true)
      expect(existsSync(join(dir, "node_modules/@dotfiles"))).toBe(true)
    }
  })
})

/** Every entry under `dir`, one level into scopes, with its link text: a fork's modules as a run found or left them. */
const listing = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return [`${name} -> ${readlinkSync(path)}`]
    if (name.startsWith("@") && stat.isDirectory()) return listing(path).map((entry) => `${name}/${entry}`)
    return [name]
  })

describe("link-fork, sim-tui's extra links", () => {
  /** sim-tui's package, and in the fork the protocol package and the TUI's test folder it links besides the modules. */
  const simTui = () => {
    const dir = join(workspace, "sim-tui")
    file(join(dir, "package.json"))
    file(join(fork, "packages/protocol/package.json"))
    file(join(fork, "packages/tui/test/preload.ts"), "")
    return dir
  }
  const forkModules = () => join(fork, "packages/tui/node_modules")

  test("land in sim-tui's own node_modules, each resolving into the fork, and the fork's modules stay as they were", () => {
    const dir = simTui()
    const before = listing(forkModules())
    expect(run(fork)).toMatchObject({ code: 0 })
    expect(listing(forkModules())).toEqual(before)
    const modules = join(dir, "node_modules")
    expect(lstatSync(join(modules, "@opencode")).isSymbolicLink()).toBe(false)
    expect(realpathSync(join(modules, "@opencode/protocol"))).toBe(realpathSync(join(fork, "packages/protocol")))
    expect(realpathSync(join(modules, "@opencode-tui/test"))).toBe(realpathSync(join(fork, "packages/tui/test")))
    expect(realpathSync(join(modules, "@opencode/plugin"))).toBe(realpathSync(join(forkModules(), "@opencode/plugin")))
    // A second run, as every gate and install makes one, changes nothing either.
    expect(run(fork)).toMatchObject({ code: 0 })
    expect(listing(forkModules())).toEqual(before)
  })

  test("replace a scope an older run linked whole to the fork's with sim-tui's own", () => {
    const dir = simTui()
    const before = listing(forkModules())
    mkdirSync(join(dir, "node_modules"), { recursive: true })
    symlinkSync(join(forkModules(), "@opencode"), join(dir, "node_modules/@opencode"))
    expect(run(fork)).toMatchObject({ code: 0 })
    expect(lstatSync(join(dir, "node_modules/@opencode")).isSymbolicLink()).toBe(false)
    expect(listing(forkModules())).toEqual(before)
  })

  test("a link an older run wrote into the fork's modules, pointing nowhere, is removed and the run goes on", () => {
    const dir = simTui()
    const before = listing(forkModules())
    // As one went in through that scope: relative to a checkout, through the anchors folder, nothing from the fork.
    symlinkSync("../../../../../../../.local/state/opencode-fork/Developer/personal/dotfiles/opencode/modules/../../protocol", join(forkModules(), "@opencode/protocol"))
    expect(run(fork)).toMatchObject({ code: 0 })
    expect(listing(forkModules())).toEqual(before)
    expect(realpathSync(join(dir, "node_modules/@opencode/protocol"))).toBe(realpathSync(join(fork, "packages/protocol")))
  })

  test("a link of the fork's own that points nowhere is never removed: the run refuses it", () => {
    simTui()
    symlinkSync(join(ELSEWHERE, "packages/protocol"), join(forkModules(), "@opencode/protocol"))
    const { code, err } = run(fork)
    expect(code).not.toBe(0)
    expect(err).toContain("@opencode/protocol")
    expect(lstatSync(join(forkModules(), "@opencode/protocol")).isSymbolicLink()).toBe(true)
  })
})
