// The legs of a land's merge check (scripts/merge-check.ts, which scripts/gate.ts --merge runs as given): which
// scripts/ tests a diff selects, and that a selected test is in the leg the merge check runs.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { parseNameStatus } from "./docs-guard.ts"
import { ACCEPT_TESTS, DOCS_GUARD, lintFiles, mergeLegs, scriptTests } from "./merge-check.ts"

/** The scripts/ folder as the merge check reads it (its files, its tests' texts), and the selections over it. */
const tree = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
  const files = (yield* fs.readDirectory(path.join(root, "scripts"))).map((name) => `scripts/${name}`)
  const texts = new Map(yield* Effect.forEach(files.filter((file) => /\.test\.tsx?$/.test(file)), (file) => Effect.map(fs.readFileString(path.join(root, file)), (text) => [file, text] as const)))
  const exists = (file: string) => files.includes(file)
  const scripts = { files: [...texts.keys()], read: (file: string) => texts.get(file) ?? "" }
  const tools = { bun: "bun", oxlint: "oxlint", typecheck: ["bun", "check", "-b"], projects: 3, exists, scripts }
  return {
    exists,
    tests: (out: string) => scriptTests(parseNameStatus(out), exists, scripts),
    /** The files the merge check's `tests` leg runs over `out`, from opencode/. */
    ran: (out: string) =>
      mergeLegs("base", parseNameStatus(out), tools)
        .filter((leg) => leg.name === "tests")
        .flatMap((leg) => leg.argv.filter((arg) => arg.startsWith("./")).map((arg) => arg.slice(2))),
    legs: (out: string) => mergeLegs("base", parseNameStatus(out), tools),
  }
})

describe("the merge check's tests", () => {
  const live = it.live.layer(BunServices.layer)

  live("a changed script runs its own test and every scripts/ test that imports it; a changed scripts/ test runs itself", () =>
    Effect.gen(function* () {
      const { exists, legs, ran, tests } = yield* tree
      expect(tests("M\tscripts/link-fork.ts\n")).toEqual(["scripts/link-fork.test.ts"])
      expect(tests("M\tscripts/leaks.ts\n")).toEqual(["scripts/accept.test.ts", "scripts/leaks.test.ts"])
      // reach.ts has no test of its own; the tests that import it run.
      expect(tests("M\tscripts/reach.ts\n")).toEqual(["scripts/accept-ledger.test.ts", "scripts/accept.test.ts"])
      expect(tests("M\tscripts/leaks.test.ts\n")).toEqual(["scripts/leaks.test.ts"])
      // A script no test reaches selects none: its typecheck and lint still run.
      expect(tests("M\tscripts/receipt.ts\n")).toEqual([])
    }),
  )

  live("the acceptance tree, its baselines and the accept scripts run accept.test and accept-parity (batch 2026-11-15cq)", () =>
    Effect.gen(function* () {
      const { exists, legs, ran, tests } = yield* tree
      // auto-claim renamed tests in tests/pool-resets.test.ts, and the work.test marker changed: both reached main red.
      const accept = [...ACCEPT_TESTS].toSorted()
      expect(tests("M\ttests/pool-resets.test.ts\n")).toEqual(accept)
      expect(tests("M\ttests/work.test.ts\n")).toEqual(accept)
      expect(tests("M\ttests/parity.json\n")).toEqual(accept)
      expect(tests("M\tcmd/pool/pool-resets.sim.test.ts\n")).toEqual(accept)
      expect(tests("M\tscripts/accept-ledger.ts\n")).toEqual(["scripts/accept-ledger.test.ts", "scripts/post-land.test.ts", ...ACCEPT_TESTS].toSorted())
    }),
  )

  live("a change to the verify docs runs the docs guard", () =>
    Effect.gen(function* () {
      const { exists, legs, ran, tests } = yield* tree
      expect(tests("M\t.claude/skills/verify-opencode/features/rex.md\n")).toEqual([DOCS_GUARD])
    }),
  )

  live("an unrelated diff runs none: mod source and its own tests, which the land's round gate ran", () =>
    Effect.gen(function* () {
      const { exists, legs, ran, tests } = yield* tree
      expect(tests("M\tmods/update/git/source.ts\nM\tmods/update/git/source.test.ts\nA\tcmd/escape/setup.test.ts\n")).toEqual([])
      expect(tests("")).toEqual([])
    }),
  )

  live("what a selection names is in the leg the merge check runs, and a docs change puts the docs guard there (docs-gate T1)", () =>
    Effect.gen(function* () {
      const { exists, legs, ran, tests } = yield* tree
      expect(ran("M\t.claude/skills/verify-opencode/features/rex.md\n")).toEqual([DOCS_GUARD])
      expect(ran("M\ttests/parity.json\nM\tscripts/link-fork.ts\n")).toEqual(["scripts/accept-parity.test.ts", "scripts/accept.test.ts", "scripts/link-fork.test.ts"])
      const none = legs("M\tmods/update/git/source.ts\n")
      expect(none.map((leg) => leg.name)).toEqual(["lint", "debt", "types", "tests"])
      expect(none.filter((leg) => leg.name === "tests").map((leg) => leg.argv)).toEqual([["true"]])
    }),
  )

  live("oxlint reads the changed TypeScript still on disk: a rename's new path, never a deletion", () =>
    Effect.gen(function* () {
      const { exists, legs, ran, tests } = yield* tree
      expect(lintFiles(parseNameStatus("M\tscripts/gate.ts\nD\tscripts/gone.ts\nR090\tscripts/old-name.ts\tscripts/reach.ts\nM\ttests/parity.json\n"), exists)).toEqual(["scripts/gate.ts", "scripts/reach.ts"])
    }),
  )
})
