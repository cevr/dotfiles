// A multiplexer pane's variables, and the spawn helper the tests use (tests/owned.ts) leaving the ones
// a test inherited out of a child's environment, so a scenario's TUI draws the same from a herdr pane,
// a Rex pane or a shell, while the ones the test sets for its child stay.
import { Effect, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { owned } from "../tests/owned.ts"
import { parentEnv } from "../tests/scratch.ts"
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
    }),
  )

  it.effect("a child loses the pane variables it inherited and keeps the ones its caller set", () =>
    Effect.sync(() => {
      const parent = { ...PANE, PATH: "/bin" }
      // Spread from the parent, as a test spreads process.env, with the herdr test's socket and a pane of its own on top.
      const env = { ...parent, HERDR_FAKE_SOCKET: "/nonexistent/loop-probe-x/herdr.sock", HERDR_PANE_ID: "wtest:p1" }
      expect(outsidePanes(env, parent)).toEqual({ PATH: "/bin", HERDR_FAKE_SOCKET: "/nonexistent/loop-probe-x/herdr.sock", HERDR_PANE_ID: "wtest:p1" })
      expect(outsidePanes(parent, {})).toEqual(parent)
    }),
  )

  it.live("a test's child runs outside the pane the test started in, with the pane variables the test set", () =>
    Effect.gen(function* () {
      const env = { ...parentEnv, HERDR_FAKE_SOCKET: "/nonexistent/loop-probe-x/herdr.sock", KEPT: "yes", TMPDIR: "/nonexistent/loop-probe-x" }
      const child = owned(["/usr/bin/env"], { env, stdout: "pipe" })
      const text = yield* Stream.fromReadableStream({ evaluate: () => child.stdout, onError: String }).pipe(Stream.decodeText(), Stream.mkString)
      expect(yield* Effect.promise(() => child.exited)).toBe(0)
      expect(names(text).filter(isPaneVariable)).toEqual(["HERDR_FAKE_SOCKET"])
      expect(names(text)).toContain("KEPT")
    }),
  )
})
