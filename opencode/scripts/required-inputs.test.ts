// @reads **/*.test.{ts,tsx}
// An input a test needs and the gate does not give is required where it is read, never a reason to skip. The unit
// leg (every test outside tests/) runs with no installed tree and no `work` binary named, so a unit test that reads
// TREE_OPENCODE or WORK_BIN can only skip, or pass on something else, in every gate run: such a check lives in an
// acceptance file that requires it (tests/cli-tree-installed.test.ts fails `no installed tree given`,
// tests/work-process.test.ts `no work binary given`), which the acceptance runner runs or owes by name.
//
// It reads the test sources by glob, so it declares them for the gate's selection (scripts/reach.ts `readsOf`):
import * as BunServices from "@effect/platform-bun/BunServices"
import { Glob } from "bun"
import { Effect, FileSystem } from "effect"
import { matchingInput } from "../tests/read-path.ts"
import { describe, expect, it } from "effect-bun-test"

/** The inputs only an acceptance file may read, each with the file that requires it. */
const REQUIRED = { TREE_OPENCODE: "tests/cli-tree-installed.test.ts", WORK_BIN: "tests/work-process.test.ts" } as const

/** A read of the variable `name` from an environment: `env.NAME`, `env["NAME"]`, or `Config.<kind>("NAME")`. */
const readOf = (name: string) => new RegExp(`(\\.${name}\\b|\\[["'\`]${name}["'\`]\\]|Config\\.\\w+\\(["'\`]${name}["'\`])`)

/** Every test source of the workspace, from opencode/, dependencies' left out. */
const testSources = () => [...new Glob("**/*.test.{ts,tsx}").scanSync({ cwd: "." })].filter((file) => !file.includes("node_modules/")).sort()

describe("an input the gate does not give is required where it is read", () => {
  it.live.layer(BunServices.layer)("no unit test reads TREE_OPENCODE or WORK_BIN, and the acceptance file each names reads it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const reads = yield* Effect.forEach(testSources(), (file) =>
        fs.readFileString(matchingInput("**/*.test.{ts,tsx}", file)).pipe(Effect.map((text) => Object.keys(REQUIRED).filter((name) => readOf(name).test(text)).map((name) => `${file} reads ${name}`))),
      )
      const all = reads.flat()
      expect(all.filter((read) => !read.startsWith("tests/"))).toEqual([])
      for (const [name, file] of Object.entries(REQUIRED)) expect(all).toContain(`${file} reads ${name}`)
    }),
  )
})
