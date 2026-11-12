import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { GENT_SUITES, gentAvailable, gentSkipped, gentSource } from "../tests/gent/store.ts"
import { scratch } from "../tests/scratch.ts"
import { ROOT } from "./reach.ts"

/** `bun scripts/accept.ts --list` with `GENT_SOURCE` as given (empty: unset) and no fork. */
const list = (gent: string) => {
  const child = Bun.spawnSync([process.execPath, "scripts/accept.ts", "--list"], {
    cwd: ROOT,
    env: { ...process.env, OPENCODE_DEV: "", GENT_SOURCE: gent },
    stdout: "pipe",
    stderr: "pipe",
  })
  const lines = child.stdout.toString().split("\n")
  return { code: child.exitCode, lines, skipped: lines.filter((line) => line.startsWith("SKIPPED: gent suites")) }
}

/** The SKIPPED line for all of gent's suites, with its reason. */
const skipLine = (why: string) => `SKIPPED: gent suites (4: ${GENT_SUITES.join(", ")}): no gent checkout (${why})`

describe("the acceptance run without gent's checkout", () => {
  test("with GENT_SOURCE unset, it lists gent's suites and ends with one SKIPPED line naming them", () => {
    const ran = list("")
    expect(ran.code).toBe(0)
    expect(ran.lines).toEqual(expect.arrayContaining([...GENT_SUITES]))
    expect(ran.skipped).toEqual([skipLine("GENT_SOURCE is not set")])
    expect(ran.lines.filter((line) => line !== "").at(-1)).toBe(skipLine("GENT_SOURCE is not set"))
  })

  test("a real run of gent's suites alone, with GENT_SOURCE unset, skips them and ends with the SKIPPED line", () => {
    using dir = scratch("accept-gent-run-")
    const child = Bun.spawnSync([process.execPath, "scripts/accept.ts", ...GENT_SUITES], {
      cwd: ROOT,
      env: { ...process.env, OPENCODE_DEV: "", GENT_SOURCE: "", ACCEPT_LOCK: join(dir.path, "accept.lock") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = child.stdout.toString().split("\n").filter((line) => line !== "")
    expect(child.exitCode).toBe(0)
    expect(child.stderr.toString()).toMatch(/Ran \d+ tests across 4 files/)
    expect(out.at(-1)).toBe(skipLine("GENT_SOURCE is not set"))
    expect(out.filter((line) => line.startsWith("SKIPPED: gent suites"))).toHaveLength(1)
  }, 120_000)

  test("with GENT_SOURCE at a missing path, the SKIPPED line names the path", () => {
    expect(list("/nonexistent/gent-skip-probe").skipped).toEqual([skipLine("GENT_SOURCE=/nonexistent/gent-skip-probe does not exist")])
  })

  test("with GENT_SOURCE at a directory, it lists gent's suites and no SKIPPED line", () => {
    using dir = scratch("accept-gent-")
    const ran = list(dir.path)
    expect(ran.code).toBe(0)
    expect(ran.lines).toEqual(expect.arrayContaining([...GENT_SUITES]))
    expect(ran.skipped).toEqual([])
  })
})

describe("gent's checkout", () => {
  test("is GENT_SOURCE alone: unset or empty, there is none and the suites are not available", () => {
    expect(gentSource({})).toBe("")
    expect(gentSource({ GENT_SOURCE: "" })).toBe("")
    expect(gentAvailable({})).toBe(false)
  })

  test("a GENT_SOURCE naming a directory makes the suites available, and their run prints no SKIPPED line", () => {
    using dir = scratch("accept-gent-")
    expect(gentSource({ GENT_SOURCE: dir.path })).toBe(dir.path)
    expect(gentAvailable({ GENT_SOURCE: dir.path })).toBe(true)
    expect(gentSkipped(GENT_SUITES, { GENT_SOURCE: dir.path })).toBe("")
  })

  test("a run with none of gent's suites prints no SKIPPED line; one with a single suite names it", () => {
    expect(gentSkipped(["tests/mail.test.ts", "./tests/orchestrate.test.ts"], {})).toBe("")
    expect(gentSkipped(["./tests/pool-gent.test.ts"], {})).toBe(
      "SKIPPED: gent suites (1: tests/pool-gent.test.ts): no gent checkout (GENT_SOURCE is not set)",
    )
  })

  test("GENT_SUITES is every acceptance suite on gent's store, and each skips on gentAvailable", () => {
    const tests = join(ROOT, "tests")
    const users = readdirSync(tests)
      .filter((name) => name.endsWith(".test.ts") && readFileSync(join(tests, name), "utf8").includes('from "./gent/store.ts"'))
      .map((name) => `tests/${name}`)
      .sort()
    expect(users).toEqual([...GENT_SUITES])
    for (const suite of GENT_SUITES) {
      const text = readFileSync(join(ROOT, suite), "utf8")
      expect(text).toContain("gentAvailable()")
      expect(text).toContain("describe.skipIf(!ready)")
    }
  })
})
