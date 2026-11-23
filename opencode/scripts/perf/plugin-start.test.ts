// The service's CPU time as plugin-start.ts reads it: `ps`'s `time` on macOS, `/proc/<pid>/stat` on Linux.
// And the harnesses' rule that no harness starts an installed build by its path.
import { describe, expect, test } from "bun:test"
import { argv, readableStreamToText, spawnSync } from "bun"
import { Effect, Option } from "effect"
import { it } from "effect-bun-test"
import { bindsTree, unboundBuild } from "../../testbeds/gamut/gamut.ts"
import { owned, released } from "../../tests/owned.ts"
import { scratch } from "../../tests/scratch.ts"
import { groupCpu, procStat, psTime, serviceCommand } from "./plugin-start.ts"

/** Runs `script` in /bin/sh with `args` as $1…, and answers whether it exited 0. */
const sh = (script: string, ...args: ReadonlyArray<string>) => spawnSync(["/bin/sh", "-c", script, "sh", ...args]).exitCode === 0

describe("a harness and an installed build", () => {
  /** A scratch share directory holding a build with its plugin tree beside it, as the update installs one. */
  const installed = () => {
    const held = scratch("harness-clone-")
    const binary = `${held.path}/share/opencode-2.3.0-prime.aaaaaaaa.11111111.tree`
    expect(sh('mkdir -p "$1.plugins/config" && printf "{}\\n" > "$1.plugins/config/opencode.json" && printf "#!/bin/sh\\necho \\"\\$0\\"\\n" > "$1" && chmod 755 "$1"', binary)).toBe(true)
    return { root: held.path, binary, [Symbol.dispose]: held[Symbol.dispose] }
  }

  test("plugin-start's service runs a clone of an installed build in its scratch directory, never the build by its path", () => {
    using share = installed()
    const command = serviceCommand([share.binary], `${share.root}/run`)
    const [program = ""] = command
    expect(program).not.toBe(share.binary)
    expect(program.slice(0, program.lastIndexOf("/"))).toBe(`${share.root}/run/bin`)
    expect(bindsTree(program)).toBe(false)
    expect(sh('cmp -s "$1" "$2"', program, share.binary)).toBe(true)
    expect(command.slice(1)).toEqual(["serve", "--service"])
  })

  test("a build with no tree beside it, and the fork from source, run as they are", () => {
    using share = installed()
    expect(sh('rm -r "$1.plugins"', share.binary)).toBe(true)
    expect(serviceCommand([share.binary], share.root)).toEqual([share.binary, "serve", "--service"])
    expect(serviceCommand([argv[0] ?? "bun", "/fork/packages/cli/src/index.ts"], share.root)).toEqual([argv[0] ?? "bun", "/fork/packages/cli/src/index.ts", "serve", "--service"])
    expect(unboundBuild(share.binary, share.root)).toBe(share.binary)
    expect(sh('test -e "$1"', `${share.root}/opencode-clone`)).toBe(false)
  })

  it.live("a test's owned child runs a clone of an installed build, removed with it, never the build by its path", () =>
    Effect.gen(function* () {
      using share = installed()
      const child = owned([share.binary, "serve"])
      const ran = (yield* Effect.promise(() => readableStreamToText(child.stdout))).trim()
      expect(ran).not.toBe(share.binary)
      expect(ran.endsWith("/opencode-clone")).toBe(true)
      yield* Option.match(Option.fromNullishOr(released(child.pid)), { onNone: () => Effect.void, onSome: (done) => Effect.promise(() => done) })
    }),
  )
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
// @reads-indirect scripts/** tests/** testbeds/** cmd/**
