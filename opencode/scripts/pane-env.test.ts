import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { isPaneVariable, outsidePanes } from "./pane-env.ts"

const PANE = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p1",
  HC_TERMINAL_ID: "t1",
  REX_SESSION: "session:01a1",
  REX_BLOCK: "block:01a1",
  TERM_PROGRAM: "rex",
}

describe("a multiplexer pane's variables", () => {
  test("herdr's, herdr-core's, Rex's and TERM_PROGRAM are a pane's; others are not", () => {
    expect(Object.keys(PANE).filter((name) => !isPaneVariable(name))).toEqual([])
    expect(["PATH", "HOME", "TERM", "HC", "REXX", "OPENCODE_DEV"].filter(isPaneVariable)).toEqual([])
    expect(outsidePanes({ ...PANE, PATH: "/bin" })).toEqual({ PATH: "/bin" })
  })

  test("a test's child runs outside the pane the test started in, unless the test sets the pane itself", async () => {
    const run = Bun.spawn([process.execPath, join(import.meta.dir, "pane-env-fixture.ts")], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...PANE, KEPT: "yes" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    const { inherited, set } = JSON.parse(stdout) as { inherited: ReadonlyArray<string>; set: ReadonlyArray<string> }
    const names = (lines: ReadonlyArray<string>) => lines.map((line) => line.slice(0, line.indexOf("=")))
    expect(names(inherited).filter(isPaneVariable)).toEqual([])
    expect(inherited).toContain("KEPT=yes")
    expect(names(set).filter(isPaneVariable)).toEqual(["HERDR_ENV"])
  }, 30_000)
})
