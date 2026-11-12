// gent's suites without gent's checkout: no path is assumed, the suites skip, and the
// acceptance run says so in one SKIPPED line; a GENT_SOURCE naming a directory runs them.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GENT_SUITES, gentAvailable, gentSkipped, gentSource } from "../tests/gent/store.ts"
import { ROOT } from "./reach.ts"

const scratch = mkdtempSync(join(tmpdir(), "accept-gent-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** `bun scripts/accept.ts --list` with `GENT_SOURCE` as given, no fork, and no caller's GENT_SOURCE. */
const list = async (gent: string | undefined) => {
  const env: Record<string, string | undefined> = { ...process.env, GENT_SOURCE: gent }
  if (gent === undefined) delete env.GENT_SOURCE
  delete env.OPENCODE_DEV
  const child = Bun.spawn([process.execPath, "scripts/accept.ts", "--list"], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

const skipLines = (text: string) => text.split("\n").filter((line) => line.startsWith("SKIPPED: gent suites"))

describe("the acceptance run without gent's checkout", () => {
  test("with GENT_SOURCE unset, it lists gent's suites and carries one SKIPPED line naming them", async () => {
    const ran = await list(undefined)
    expect(ran.code).toBe(0)
    for (const suite of GENT_SUITES) expect(ran.stdout.split("\n")).toContain(suite)
    expect(skipLines(ran.stderr)).toEqual([
      `SKIPPED: gent suites (4 files: ${GENT_SUITES.join(", ")}): no gent checkout (GENT_SOURCE is not set)`,
    ])
  })

  test("with GENT_SOURCE at a missing path, the SKIPPED line names the path", async () => {
    const ran = await list("/nonexistent/gent-skip-probe")
    expect(ran.code).toBe(0)
    expect(skipLines(ran.stderr)).toEqual([
      `SKIPPED: gent suites (4 files: ${GENT_SUITES.join(", ")}): no gent checkout (GENT_SOURCE=/nonexistent/gent-skip-probe does not exist)`,
    ])
  })

  test("with GENT_SOURCE at a directory, no SKIPPED line", async () => {
    const ran = await list(scratch)
    expect(ran.code).toBe(0)
    expect(skipLines(`${ran.stdout}\n${ran.stderr}`)).toEqual([])
  })
})

describe("gent's checkout", () => {
  test("is GENT_SOURCE alone: unset, there is none and the suites are not available", () => {
    expect(gentSource({})).toBeUndefined()
    expect(gentSource({ GENT_SOURCE: "" })).toBeUndefined()
    expect(gentAvailable({})).toBe(false)
  })

  test("a GENT_SOURCE naming a directory makes the suites available", () => {
    expect(gentSource({ GENT_SOURCE: scratch })).toBe(scratch)
    expect(gentAvailable({ GENT_SOURCE: scratch })).toBe(true)
    expect(gentSkipped(GENT_SUITES, { GENT_SOURCE: scratch })).toBeUndefined()
  })

  test("a run with none of gent's suites prints nothing", () => {
    expect(gentSkipped(["tests/mail.test.ts", "./tests/orchestrate.test.ts"], {})).toBeUndefined()
    expect(gentSkipped(["./tests/pool-gent.test.ts"], {})).toBe(
      "SKIPPED: gent suites (1 file: tests/pool-gent.test.ts): no gent checkout (GENT_SOURCE is not set)",
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
