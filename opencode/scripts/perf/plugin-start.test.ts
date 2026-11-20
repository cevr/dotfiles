// The service's CPU time as plugin-start.ts reads it: `ps`'s `time` on macOS, `/proc/<pid>/stat` on Linux.
// And the harnesses' rule that no harness starts an installed build by its path.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { bindsTree, unboundBuild } from "../../testbeds/gamut/gamut.ts"
import { owned } from "../../tests/owned.ts"
import { groupCpu, procStat, psTime, serviceCommand } from "./plugin-start.ts"

describe("a harness and an installed build", () => {
  /** A scratch share directory holding a build with its plugin tree beside it, as the update installs one. */
  const installed = () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clone-"))
    const binary = join(root, "share", "opencode-2.3.0-prime.aaaaaaaa.11111111.tree")
    mkdirSync(`${binary}.plugins/config`, { recursive: true })
    writeFileSync(`${binary}.plugins/config/opencode.json`, "{}\n")
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    return { root, binary, [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }) }
  }

  test("plugin-start's service runs a clone of an installed build in its scratch directory, never the build by its path", () => {
    using share = installed()
    const command = serviceCommand([share.binary], join(share.root, "run"))
    const [program = ""] = command
    expect(program).not.toBe(share.binary)
    expect(dirname(program)).toBe(join(share.root, "run", "bin"))
    expect(bindsTree(program)).toBe(false)
    expect(readFileSync(program, "utf8")).toBe(readFileSync(share.binary, "utf8"))
    expect(command.slice(1)).toEqual(["serve", "--service"])
  })

  test("a build with no tree beside it, and the fork from source, run as they are", () => {
    using share = installed()
    rmSync(`${share.binary}.plugins`, { recursive: true })
    expect(serviceCommand([share.binary], share.root)).toEqual([share.binary, "serve", "--service"])
    expect(serviceCommand([process.execPath, "/fork/packages/cli/src/index.ts"], share.root)).toEqual([process.execPath, "/fork/packages/cli/src/index.ts", "serve", "--service"])
    expect(unboundBuild(share.binary, share.root)).toBe(share.binary)
    expect(existsSync(join(share.root, "opencode-clone"))).toBe(false)
  })

  test("a test's owned child refuses an installed build by its path", () => {
    using share = installed()
    expect(() => owned([share.binary, "serve"])).toThrow(/plugin tree beside it/)
  })
})

describe("the service's CPU time", () => {
  test("ps's time reads as ms, minutes and hours and days included", () => {
    expect(psTime("0:01.43")).toBeCloseTo(1_430)
    expect(psTime("12:00.50")).toBeCloseTo(720_500)
    expect(psTime("1:02:03.04")).toBeCloseTo(3_723_040)
    expect(psTime("2-00:00:01.00")).toBeCloseTo(172_801_000)
  })

  test("a /proc stat line gives its process group and its user and system ticks, whatever its command name holds", () => {
    // As the workbox's kernel writes it, the command name with a space and a parenthesis.
    const line = "2138369 (bun (x) y) R 2138357 2138300 2138357 0 -1 4194304 135 0 0 0 250 31 0 0 20 0 1 0 34781637 3346432 461"
    expect(procStat(line)).toEqual({ group: 2138300, ticks: 281 })
  })

  test("the init process's group has spent some CPU, and a group with no process none", () => {
    expect(groupCpu(1)).toBeGreaterThan(0)
    expect(groupCpu(999_999_999)).toBe(0)
  })
})
