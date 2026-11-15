// A multiplexer pane's variables, and the spawn helper the tests use (tests/owned.ts) leaving them out
// of a child's environment, so a scenario's TUI draws the same from a herdr pane, a Rex pane or a shell.
import { Effect, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { owned } from "../tests/owned.ts"
import { isPaneVariable, outsidePanes } from "./pane-env.ts"

const PANE = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p1",
  HC_TERMINAL_ID: "t1",
  REX_SESSION: "session:01a1",
  REX_BLOCK: "block:01a1",
  TERM_PROGRAM: "rex",
}

/** The names of `env`'s output lines (`NAME=value`). */
const names = (text: string) => text.split("\n").filter((line) => line !== "").map((line) => line.slice(0, line.indexOf("=")))

describe("a multiplexer pane's variables", () => {
  it.effect("herdr's, herdr-core's, Rex's and TERM_PROGRAM are a pane's; others are not", () =>
    Effect.sync(() => {
      expect(Object.keys(PANE).filter((name) => !isPaneVariable(name))).toEqual([])
      expect(["PATH", "HOME", "TERM", "HC", "REXX", "OPENCODE_DEV"].filter(isPaneVariable)).toEqual([])
      expect(outsidePanes({ ...PANE, PATH: "/bin" })).toEqual({ PATH: "/bin" })
    }),
  )

  it.live("a test's child runs outside the pane the test started in", () =>
    Effect.gen(function* () {
      const child = owned(["/usr/bin/env"], { env: { ...PANE, KEPT: "yes", TMPDIR: "/nonexistent/loop-probe-x" }, stdout: "pipe" })
      const text = yield* Stream.fromReadableStream({ evaluate: () => child.stdout, onError: String }).pipe(Stream.decodeText(), Stream.mkString)
      expect(yield* Effect.promise(() => child.exited)).toBe(0)
      expect(names(text).filter(isPaneVariable)).toEqual([])
      expect(names(text)).toContain("KEPT")
    }),
  )
})
