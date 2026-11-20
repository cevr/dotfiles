// The fork check every script that takes OPENCODE_DEV runs (scripts/fork.ts), on a fork laid out
// in a scratch folder: Bun's isolated install, each package's links into node_modules/.bun.
import { describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { scratch } from "../tests/scratch.ts"
import { readyFork, staleInstall } from "./fork.ts"

const json = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

/** Installs `name` at `version` into the store and links it from the package folder `dir`. */
const link = (fork: string, dir: string, name: string, version: string) => {
  const stored = join(fork, "node_modules/.bun", `${name.replace("/", "+")}@${version}+0123abcd`, "node_modules", name)
  json(join(stored, "package.json"), { name, version })
  const at = join(dir, "node_modules", name)
  mkdirSync(dirname(at), { recursive: true })
  rmSync(at, { force: true })
  symlinkSync(relative(dirname(at), stored), at)
}

/** A fork whose codemode package pins psychoscript 0.1.2 and takes effect from the catalog, installed as its lockfile says. */
const fork = (root: string) => {
  json(join(root, "package.json"), { workspaces: { packages: ["packages/*"], catalog: { effect: "4.1.0" } } })
  const tui = join(root, "packages/tui")
  json(join(tui, "package.json"), { name: "@opencode/tui", dependencies: { "solid-js": "1.9.17", "@opencode/plugin": "workspace:*" } })
  link(root, tui, "solid-js", "1.9.17")
  link(root, tui, "@opencode/plugin", "0.0.0")
  const codemode = join(root, "packages/codemode")
  json(join(codemode, "package.json"), { name: "@opencode/codemode", dependencies: { psychoscript: "0.1.2", effect: "catalog:", ranged: "^2.0.0" } })
  link(root, codemode, "psychoscript", "0.1.2")
  link(root, codemode, "effect", "4.1.0")
  link(root, codemode, "ranged", "2.5.0")
  return { tui, codemode }
}

describe("the fork's install", () => {
  test("an install that is the checkout's own passes, ranges and workspace links unread", () => {
    using dir = scratch("fork-install-")
    const root = realpathSync(dir.path)
    fork(root)
    expect(staleInstall(root)).toEqual([])
    expect(readyFork(root)).toEqual({ fork: root, modules: join(root, "packages/tui/node_modules") })
  })

  test("a checkout moved past its install (an exact pin, or a catalog one, linked at another version) is refused with the install to run (2026-11-20, image.test.ts red)", () => {
    using dir = scratch("fork-install-")
    const root = realpathSync(dir.path)
    const { codemode } = fork(root)
    link(root, codemode, "psychoscript", "0.2.1")
    link(root, codemode, "effect", "4.0.0")
    expect(staleInstall(root)).toEqual(["packages/codemode: psychoscript 0.2.1, pinned 0.1.2", "packages/codemode: effect 4.0.0, pinned 4.1.0"])
    const checked = readyFork(root)
    expect(checked).toEqual({
      problem: `${root}'s install is not its checkout's (moved without an install?): packages/codemode: psychoscript 0.2.1, pinned 0.1.2; packages/codemode: effect 4.0.0, pinned 4.1.0. Run bun install --frozen-lockfile in ${root}.`,
    })
  })
})
