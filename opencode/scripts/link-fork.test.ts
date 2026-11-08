// `bun run link-fork` refuses an OPENCODE_DEV that is not an installed OpenCode
// checkout on this machine, before it touches any node_modules, and never
// leaves a link that points nowhere. The script runs from a copy in a scratch
// workspace (its root is the folder above the script), against a scratch fork.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
  const env: Record<string, string | undefined> = { ...process.env, OPENCODE_DEV: dev }
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
      expect(readlinkSync(join(dir, "node_modules/solid-js"))).toBe(join(fork, "packages/tui/node_modules/solid-js"))
      expect(existsSync(join(dir, "node_modules/@opencode/plugin/package.json"))).toBe(true)
    }
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
