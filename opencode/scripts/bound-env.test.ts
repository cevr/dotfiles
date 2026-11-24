// The plugin binding an older installed tree build (before fork 07bb11e0) set in its shells, and the spawn helper the tests use
// (tests/owned.ts) leaving it out of a child's environment, so a scenario that drives OpenCode from
// source loads its own plugins even when the test ran in an agent's shell under the installed build.
import { Effect, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { hangGuard } from "../tests/hang-guard.ts"
import { owned } from "../tests/owned.ts"
import { parentEnv } from "../tests/scratch.ts"
import { isBindingVariable, outsideBuild } from "./bound-env.ts"

const BOUND = {
  OPENCODE_CONFIG: "/nonexistent/loop-probe-x/opencode.plugins/config/opencode.json",
  OPENCODE_CLI_CONFIG_CONTENT: '{"plugins":["/nonexistent/loop-probe-x/opencode.plugins/opencode/cmd/prime"]}',
  OPENCODE_ADJACENT_CONFIG: "/nonexistent/loop-probe-x/opencode.plugins/config",
}

/** The names of `env`'s output lines (`NAME=value`). */
const names = (text: string) => text.split("\n").filter((line) => line.includes("=")).map((line) => line.slice(0, line.indexOf("=")))

describe("an installed build's plugin binding", () => {
  it.effect("the three keys a bound build sets are its binding; others are not", () =>
    Effect.sync(() => {
      expect(Object.keys(BOUND).filter((name) => !isBindingVariable(name))).toEqual([])
      expect(["PATH", "OPENCODE_DEV", "OPENCODE_CONFIG_DIR", "OPENCODE_FLAGS"].filter(isBindingVariable)).toEqual([])
    }),
  )

  it.effect("a child loses the binding it inherited and keeps a value its caller set", () =>
    Effect.sync(() => {
      const parent = { ...BOUND, PATH: "/bin" }
      expect(outsideBuild(parent, parent)).toEqual({ PATH: "/bin" })
      expect(outsideBuild({ ...parent, OPENCODE_CONFIG: "/nonexistent/loop-probe-x/own.json" }, parent)).toEqual({ PATH: "/bin", OPENCODE_CONFIG: "/nonexistent/loop-probe-x/own.json" })
    }),
  )

  it.effect("an unbound parent's own OPENCODE_CONFIG is the user's and stays", () =>
    Effect.sync(() => {
      const parent = { OPENCODE_CONFIG: "/nonexistent/loop-probe-x/mine.json", PATH: "/bin" }
      expect(outsideBuild(parent, parent)).toEqual(parent)
    }),
  )

  it.live("a test started under a bound build gives its owned child none of the binding", () =>
    Effect.gen(function* () {
      // The fixture is the test process under the bound build; its own owned child is the one checked.
      // Its path is the package root's, where bun test runs (as scripts/accept.test.ts names its fixtures).
      const fixture = owned(["bun", "scripts/bound-env.fixture.ts"], { env: { ...parentEnv, ...BOUND }, stdout: "pipe" })
      const text = yield* Stream.fromReadableStream({ evaluate: () => fixture.stdout, onError: String }).pipe(Stream.decodeText(), Stream.mkString)
      expect(yield* Effect.promise(() => fixture.exited)).toBe(0)
      expect(names(text)).toContain("PATH")
      expect(names(text).filter(isBindingVariable)).toEqual([])
    }),
    hangGuard("short-fixture"),
  )
})
