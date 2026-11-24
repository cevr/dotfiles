// The legs of a land's merge check (scripts/merge-check.ts, which scripts/gate.ts --merge runs as given): which
// scripts/ tests a diff selects, and that a selected test is in the leg the merge check runs.
//
// Its selections run over the scripts/ folder as it is (`tree` reads every scripts/ source by path, not import), so a
// new or changed scripts/ file can change what it asserts; it declares them, or no merge check runs it (fork-checks.test
// and required-inputs.test landed by their merge checks and turned it red on main, b5735808):
// @reads scripts/*.ts scripts/*.tsx
// Which tests import or read a path is the tree's fact, derived (`found`); what a case pins by hand is a rule's decision.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Glob } from "bun"
import { Effect, FileSystem, Option, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { describe, expect, it } from "effect-bun-test"
import { parseNameStatus } from "./docs-guard.ts"
import { ACCEPT_TESTS, DOCS_GUARD, GIT_REPO_GUARD, lintFiles, mergeLegs, reachedWithin, scriptTests } from "./merge-check.ts"
import { importsOf, load, reach, readsOf } from "./reach.ts"

/** bb435bcc's change set from opencode/ (Rift U1's land): its cmd/work/server.ts import broke runtime-imports.test, which its merge check never ran. */
const BB435BCC = [
  "M\t.claude/skills/verify-opencode/features/orchestrate.md",
  "M\t.oxlintrc.json",
  "M\tAGENTS.md",
  "M\tbun.lock",
  "M\tcmd/orchestrate/orch-tools-world.ts",
  "D\tcmd/rift/package.json",
  "D\tcmd/rift/rpc.test.ts",
  "D\tcmd/rift/server.test.ts",
  "D\tcmd/rift/server.ts",
  "D\tcmd/rift/tsconfig.json",
  "M\tcmd/tool-names/server.test.ts",
  "M\tcmd/work/package.json",
  "M\tcmd/work/rpc.test.ts",
  "M\tcmd/work/server.test.ts",
  "M\tcmd/work/server.ts",
  "M\teffect-debt.json",
  "M\tmods/work/process/landing.ts",
  "D\tmods/work/process/rifts.test.ts",
  "D\tmods/work/process/rifts.ts",
  "M\tmods/work/process/unpushed.ts",
  "M\tmods/work/process/work.test.ts",
  "M\tmods/work/process/work.ts",
  "M\tmods/work/tool.ts",
  "M\tscripts/accept-ledger.ts",
  "M\tscripts/cache-audit.test.ts",
  "M\tscripts/verify-docs.test.ts",
  "M\tsim/plugins.ts",
  "D\ttests/rift.test.ts",
  "D\ttests/rift/run.ts",
  "D\ttests/rift/sim.ts",
  "M\ttests/work.test.ts",
  "M\ttests/work/run.ts",
  "M\ttests/work/sim.ts",
  "",
].join("\n")

/** The scripts/ folder as the merge check reads it (its files, each source's imports), and the selections over it. */
const tree = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
  const files = (yield* fs.readDirectory(path.join(root, "scripts"))).map((name) => `scripts/${name}`)
  const sources = files.filter((file) => /\.tsx?$/.test(file))
  const texts = new Map(yield* Effect.forEach(sources, (file) => Effect.map(fs.readFileString(path.join(root, file)), (text) => [file, text] as const)))
  const imports = new Map([...texts].map(([file, text]) => [file, importsOf(file, text)] as const))
  // The git-repo guard lives in tests/, outside the folder read here.
  const exists = (file: string) => files.includes(file) || file === GIT_REPO_GUARD
  const scripts = {
    files: sources.filter((file) => /\.test\.tsx?$/.test(file)),
    imports: (file: string) => imports.get(file) ?? [],
    reads: (file: string) => readsOf(texts.get(file) ?? ""),
  }
  const tools = (workbox: string) => ({
    bun: "bun",
    oxlint: "oxlint",
    typecheck: ["bun", "check", "-b"],
    projects: 3,
    exists,
    scripts,
    workbox: { changes: parseNameStatus(workbox), tests: ["../workbox/test/workrift.test.ts", "../workbox/test/hc.test.ts"] },
  })
  // The tree's facts, from the parts the selection composes (reachedWithin, @reads), not from scriptTests itself.
  const importers = (file: string) => scripts.files.filter((testPath) => reachedWithin(testPath, scripts, exists).has(file))
  const readers = (file: string) => scripts.files.filter((testPath) => scripts.reads(testPath).some((glob) => new Glob(glob).match(file)))
  /** The scripts/ tests whose imports reach, or whose @reads globs match, any of `files`. */
  const found = (...files: ReadonlyArray<string>) => [...new Set(files.flatMap((file) => [...importers(file), ...readers(file)]))].toSorted()
  return {
    exists,
    importers,
    found,
    /** What a diff of `files` must select: the `pinned` tests its rules name, beside every test the tree says imports or reads one. */
    expected: (pinned: ReadonlyArray<string>, ...files: ReadonlyArray<string>) => [...new Set([...pinned, ...found(...files)])].toSorted(),
    tests: (out: string) => scriptTests(parseNameStatus(out), exists, scripts),
    /** The files the merge check's `tests` leg runs over `out` (and `workbox`, the workbox/ diff), from opencode/. */
    ran: (out: string, workbox = "") =>
      mergeLegs("base", parseNameStatus(out), tools(workbox))
        .filter((leg) => leg.name === "tests")
        .flatMap((leg) => leg.argv.filter((arg) => arg.startsWith("./")).map((arg) => arg.slice(2))),
    legs: (out: string) => mergeLegs("base", parseNameStatus(out), tools("")),
  }
})

describe("the merge check's tests", () => {

  it.live.layer(BunServices.layer)("a changed script runs its own test and every scripts/ test that imports it; a changed scripts/ test runs itself", () =>
    Effect.gen(function* () {
      const { expected, importers, tests } = yield* tree
      // Pins: a changed script runs its own test.
      expect(tests("M\tscripts/link-fork.ts\n")).toEqual(expected(["scripts/link-fork.test.ts"], "scripts/link-fork.ts"))
      // Pins: a test that imports a script runs beside the script's own test (accept.test imports leaks.ts).
      expect(tests("M\tscripts/leaks.ts\n")).toEqual(expected(["scripts/leaks.test.ts"], "scripts/leaks.ts"))
      expect(tests("M\tscripts/leaks.ts\n")).toContain("scripts/accept.test.ts")
      // Pins: reach.ts has no test of its own; the tests that import it run, these three among them.
      expect(tests("M\tscripts/reach.ts\n")).toEqual(expected([], "scripts/reach.ts"))
      for (const testPath of ["scripts/accept-ledger.test.ts", "scripts/accept.test.ts", "scripts/merge-check.test.ts"]) expect(tests("M\tscripts/reach.ts\n")).toContain(testPath)
      // Pins: a changed scripts/ test runs itself, and the git-repo guard over its text.
      expect(tests("M\tscripts/leaks.test.ts\n")).toEqual(expected(["scripts/leaks.test.ts", GIT_REPO_GUARD], "scripts/leaks.test.ts"))
      // Pins: a script no test imports selects only the tests that read it by path; its typecheck and lint still run.
      expect(importers("scripts/receipt.ts")).toEqual([])
      expect(tests("M\tscripts/receipt.ts\n")).toEqual(expected([], "scripts/receipt.ts"))
    }),
  )

  it.live.layer(BunServices.layer)("the acceptance tree, its baselines and the accept scripts run accept.test and accept-parity (batch 2026-11-15cq)", () =>
    Effect.gen(function* () {
      const { expected, tests } = yield* tree
      // Pins: auto-claim renamed tests in tests/pool-resets.test.ts, and the work.test marker changed: both reached main red.
      // A changed tests/ file runs the accept tests and the git-repo guard.
      for (const file of ["tests/pool-resets.test.ts", "tests/work.test.ts"]) expect(tests(`M\t${file}\n`)).toEqual(expected([...ACCEPT_TESTS, GIT_REPO_GUARD], file))
      // Pins: a parity baseline runs the accept tests, and no git-repo guard (it is no test source).
      expect(tests("M\ttests/parity.json\n")).toEqual(expected(ACCEPT_TESTS, "tests/parity.json"))
      expect(tests("M\ttests/parity.json\n")).not.toContain(GIT_REPO_GUARD)
      // Pins: a simulated suite a parity manifest counts runs the accept tests; layout.test and runtime-imports.test read every cmd/** file too (@reads).
      expect(tests("M\tcmd/pool/pool-resets.sim.test.ts\n")).toEqual(expected([...ACCEPT_TESTS, GIT_REPO_GUARD], "cmd/pool/pool-resets.sim.test.ts"))
      for (const testPath of ["scripts/layout.test.ts", "scripts/runtime-imports.test.ts"]) expect(tests("M\tcmd/pool/pool-resets.sim.test.ts\n")).toContain(testPath)
      // Pins: an accept script runs the accept tests beside its own test and its importers (post-land.test).
      expect(tests("M\tscripts/accept-ledger.ts\n")).toEqual(expected(["scripts/accept-ledger.test.ts", ...ACCEPT_TESTS], "scripts/accept-ledger.ts"))
      expect(tests("M\tscripts/accept-ledger.ts\n")).toContain("scripts/post-land.test.ts")
    }),
  )

  it.live.layer(BunServices.layer)("a new or changed test or testbed file runs the git-repo guard, which no import reaches; a deleted one, or source, does not (batch 2026-11-16cv)", () =>
    Effect.gen(function* () {
      const { ran, tests } = yield* tree
      // small-fu3 added scripts/verify-fork.test.ts with a raw `git init`; its merge check ran no guard and main went red.
      expect(ran("A\tscripts/verify-fork.test.ts\n")).toContain(GIT_REPO_GUARD)
      expect(tests("M\ttestbeds/gamut/gamut.ts\n")).toContain(GIT_REPO_GUARD)
      expect(tests("A\ttests/git-repo.ts\n")).toContain(GIT_REPO_GUARD)
      expect(tests("D\tmods/update/git/source.test.ts\n")).not.toContain(GIT_REPO_GUARD)
      expect(tests("M\tmods/update/git/source.ts\n")).not.toContain(GIT_REPO_GUARD)
    }),
  )

  it.live.layer(BunServices.layer)("a test that reads files by path, not import, runs when a file it declares with @reads changes (Rift U1, bb435bcc)", () =>
    Effect.gen(function* () {
      const { ran, tests } = yield* tree
      const RUNTIME_IMPORTS = "scripts/runtime-imports.test.ts"
      // bb435bcc changed cmd/work/server.ts's imports; runtime-imports.test globs cmd/** and mods/**, imports neither, and stayed unselected.
      expect(tests("M\tcmd/work/server.ts\n")).toContain(RUNTIME_IMPORTS)
      expect(ran(BB435BCC)).toContain(RUNTIME_IMPORTS)
      expect(tests("M\tmods/work/tool.ts\n")).toContain(RUNTIME_IMPORTS)
      expect(tests("A\tscenarios/new.ts\n")).toContain(RUNTIME_IMPORTS)
      // The rest of the class: each reads its files by glob or path text.
      expect(tests("A\tcmd/new/tui.tsx\n")).toContain("scripts/daily-configure.test.ts")
      expect(tests("A\tmods/new/model.ts\n")).toContain("scripts/layout.test.ts")
      expect(tests("M\tcmd/git/server.ts\n")).toContain("scripts/tool-inputs.test.ts")
      expect(tests("M\tmods/update/source.ts\n")).toContain("scripts/old-scheme-gone.test.ts")
      expect(tests("M\tscripts/daily.ts\n")).toContain("scripts/old-scheme-gone.test.ts")
      for (const testPath of ["scripts/effect-domain-policy.test.ts", "scripts/effect-isolation.test.ts", "scripts/effect-process-policy.test.ts", "scripts/effect-small-rules.test.ts"])
        expect(tests("M\t.oxlintrc.json\n")).toContain(testPath)
      expect(tests("M\teffect-debt.json\n")).toContain("scripts/effect-domain-policy.test.ts")
      // a5821de8 changed the three ignore lists alone; effect-debt.test copies them into its workspaces by path, and stayed unselected.
      for (const file of ["effect-debt.json", ".oxlintrc.json", ".oxlintrc.effect-debt.json", "lint/package.json"])
        expect(tests(`M\t${file}\n`)).toContain("scripts/effect-debt.test.ts")
      expect(tests("M\tsim/seed.ts\n")).toContain("scripts/accept.test.ts")
      // What no test reads selects none of them.
      expect(tests("M\tREADME.txt\n")).toEqual([])
    }),
  )

  // The full gate's unit leg was never the gap: reach.ts follows the paths runtime-imports.test's code names (scripts/daily.ts names "cmd" and "mods").
  it.live.layer(BunServices.layer)("the full gate's cache key over runtime-imports.test covers cmd/** and mods/**: a cmd/work change makes it due", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(load)
      const reached = reach(workspace, ["scripts/runtime-imports.test.ts"])
      expect(["cmd/work/server.ts", "mods/work/tool.ts"].filter((file) => !reached.has(file))).toEqual([])
    }),
  )

  it.live.layer(BunServices.layer)("a new or changed scripts/ file runs this file, whose selections read the scripts/ folder (fe8b7bd1, fe8d8243 reached main red)", () =>
    Effect.gen(function* () {
      const { ran, tests } = yield* tree
      // fe8b7bd1 added fork-checks.test importing reach.ts; fe8d8243 added required-inputs.test reading every test source.
      // Each changed what this file selects, and each merge check ran only the new test.
      for (const out of ["A\tscripts/fork-checks.test.ts\n", "A\tscripts/required-inputs.test.ts\n", "A\tscripts/new.ts\n", "M\tscripts/receipt.ts\n"])
        expect(ran(out)).toContain("scripts/merge-check.test.ts")
      // What leaves scripts/ alone cannot change them.
      for (const out of ["A\ttests/new.test.ts\n", "M\tdecider/tui-clock.ts\n", "M\tscripts/fork-checks.json\n"]) expect(tests(out)).not.toContain("scripts/merge-check.test.ts")
    }),
  )

  it.live.layer(BunServices.layer)("a change to the verify docs runs the docs guard", () =>
    Effect.gen(function* () {
      const { expected, tests } = yield* tree
      // Pins: a feature page runs the docs guard.
      const page = ".claude/skills/verify-opencode/features/rex.md"
      expect(tests(`M\t${page}\n`)).toEqual(expected([DOCS_GUARD], page))
    }),
  )

  it.live.layer(BunServices.layer)("an unrelated diff runs none; TypeScript source runs its readers, and a test also runs the git-repo guard", () =>
    Effect.gen(function* () {
      const { expected, found, importers, tests } = yield* tree
      // Pins: source no scripts/ test imports or reads selects none, and an empty diff none.
      expect(tests("M\tREADME.txt\n")).toEqual([])
      expect(tests("")).toEqual([])
      // The timing guard resolves imported literals: a declaration can change a runner cap without a test-file diff.
      const clock = "decider/tui-clock.ts"
      expect(tests(`M\t${clock}\n`)).toEqual(found(clock))
      expect(tests(`M\t${clock}\n`)).toContain("scripts/wall-clock-assertions.test.ts")
      // Pins: its test runs the git-repo guard, beside the tests that read every test source (required-inputs.test's @reads).
      expect(tests("M\tdecider/tui-clock.ts\nM\tdecider/tui-clock.test.ts\n")).toEqual(expected([GIT_REPO_GUARD], "decider/tui-clock.ts", "decider/tui-clock.test.ts"))
      // Pins: mod source no scripts/ test imports runs only its readers, layout.test among them.
      expect(importers("mods/update/git/source.ts")).toEqual([])
      expect(tests("M\tmods/update/git/source.ts\n")).toEqual(found("mods/update/git/source.ts"))
      expect(tests("M\tmods/update/git/source.ts\n")).toContain("scripts/layout.test.ts")
    }),
  )

  it.live.layer(BunServices.layer)("a change under the repository's workbox/ runs every workbox/test/ test, beside what opencode/'s diff selects; none without one (batch 2026-11-16cy)", () =>
    Effect.gen(function* () {
      const { ran, tests } = yield* tree
      const workbox = ["../workbox/test/hc.test.ts", "../workbox/test/workrift.test.ts"]
      expect(ran("", "M\tworkbox/bin/workrift\n")).toEqual(workbox)
      expect(ran("M\tscripts/link-fork.ts\n", "M\tworkbox/test/workrift.test.ts\n")).toEqual([...tests("M\tscripts/link-fork.ts\n"), ...workbox])
      expect(ran("M\tscripts/link-fork.ts\n")).toEqual([...tests("M\tscripts/link-fork.ts\n")])
    }),
  )

  it.live.layer(BunServices.layer)("what a selection names is in the leg the merge check runs, and a docs change puts the docs guard there (docs-gate T1)", () =>
    Effect.gen(function* () {
      const { legs, ran, tests } = yield* tree
      const page = "M\t.claude/skills/verify-opencode/features/rex.md\n"
      expect(ran(page)).toEqual([...tests(page)])
      expect(ran(page)).toContain(DOCS_GUARD)
      const both = "M\ttests/parity.json\nM\tscripts/link-fork.ts\n"
      expect(ran(both)).toEqual([...tests(both)])
      for (const testPath of [...ACCEPT_TESTS, "scripts/link-fork.test.ts"]) expect(ran(both)).toContain(testPath)
      const none = legs("M\tREADME.txt\n")
      expect(none.map((leg) => leg.name)).toEqual(["lint", "debt", "types", "tests"])
      expect(none.filter((leg) => leg.name === "tests").map((leg) => leg.argv)).toEqual([["true"]])
    }),
  )

  it.live.layer(BunServices.layer)("a script a test reaches through other scripts runs that test (batch 2026-11-15cr T2: fork.ts → daily.ts → daily.test)", () =>
    Effect.gen(function* () {
      const { tests } = yield* tree
      // No test imports fork.ts; daily.ts and post-land.ts do, and their tests import them.
      expect(tests("M\tscripts/fork.ts\n")).toContain("scripts/daily.test.ts")
      expect(tests("M\tscripts/fork.ts\n")).toContain("scripts/post-land.test.ts")
      expect(tests("M\tscripts/merge-driver.ts\n")).toContain("scripts/daily.test.ts")
      expect(tests("M\tscripts/accept-plan.ts\n")).toContain("scripts/post-land.test.ts")
    }),
  )

  it.effect("the walk follows ./ imports within scripts/ any number of steps deep, once each, and stops outside it", () =>
    Effect.sync(() => {
      // Every file below exists, those outside scripts/ too: only the walk's scripts/ bound keeps them out. A `./`
      // specifier can still leave scripts/ (`./../mods/…`) or name a file under a scripts/ folder that is no script.
      const graph = new Map<string, ReadonlyArray<string>>([
        ["scripts/a.test.ts", ["./b.ts", "bun:test", "../mods/x/y.ts", "./../mods/x/y.ts"]],
        ["scripts/b.ts", ["./c", "./fixtures/data.json"]],
        ["scripts/c.ts", ["./b.ts", "./gone.ts", "./fixtures/helper.ts"]],
        ["scripts/d.ts", []],
        ["scripts/../mods/x/y.ts", ["./z.ts"]],
        ["mods/x/y.ts", []],
        ["scripts/fixtures/data.json", []],
        ["scripts/fixtures/helper.ts", []],
      ])
      const scripts = { files: ["scripts/a.test.ts"], imports: (file: string) => graph.get(file) ?? [], reads: () => [] }
      const exists = (file: string) => graph.has(file)
      expect([...reachedWithin("scripts/a.test.ts", scripts, exists)].toSorted()).toEqual(["scripts/a.test.ts", "scripts/b.ts", "scripts/c.ts"])
      expect(scriptTests(parseNameStatus("M\tscripts/c.ts\n"), exists, scripts)).toEqual(["scripts/a.test.ts"])
      expect(scriptTests(parseNameStatus("M\tscripts/d.ts\n"), exists, scripts)).toEqual([])
      // A change outside scripts/ that a ./ path reaches selects nothing through the walk.
      expect(scriptTests(parseNameStatus("M\tscripts/fixtures/helper.ts\nM\tmods/x/y.ts\n"), exists, scripts)).toEqual([])
    }),
  )

  it.effect("a test's @reads lines name the globs it reads; a change, an old path or a new one, that one matches selects it", () =>
    Effect.sync(() => {
      const source = ["/**", " * Reads its seeds by glob.", " * @reads cmd/** mods/*/server.ts", " */", "// @reads  data/*.json", "const reads = 1 // @reads not/this.ts"].join("\n")
      expect(readsOf(source)).toEqual(["cmd/**", "mods/*/server.ts", "data/*.json"])
      const scripts = { files: ["scripts/a.test.ts"], imports: () => [], reads: () => readsOf(source) }
      const exists = (file: string) => file === "scripts/a.test.ts"
      const due = (out: string) => scriptTests(parseNameStatus(out), exists, scripts)
      expect(due("M\tcmd/work/deep/x.ts\n")).toEqual(["scripts/a.test.ts"])
      expect(due("D\tmods/rift/server.ts\n")).toEqual(["scripts/a.test.ts"])
      expect(due("R100\tdata/a.json\tother/a.json\n")).toEqual(["scripts/a.test.ts"])
      expect(due("M\tmods/rift/deep/server.ts\nM\tnot/this.ts\nM\tdata/sub/a.json\n")).toEqual([])
    }),
  )

  it.live.layer(BunServices.layer)("gate.ts --merge starts every step the merge check names: the link, lint, debt, types and tests (batch 2026-11-15cr T1)", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(ChildProcess.make("bun", ["scripts/gate.ts", "--merge", "HEAD", "--dry-run"], { cwd: root, extendEnv: true, stdin: "ignore", forceKillAfter: "3 seconds" }))
      const [stdout, code] = yield* Effect.all([child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode], { concurrency: 2 })
      const steps = stdout.split("\n").flatMap((line) => Option.toArray(Option.map(Option.fromNullishOr(/^step (\w+): (.*)$/.exec(line)), (match) => [String(match[1]), String(match[2])] as const)))
      expect(Number(code)).toBe(0)
      // Each step prints from its own echo, so their order is not asserted.
      expect(steps.map(([name]) => name).toSorted()).toEqual(["debt", "link", "lint", "tests", "types"])
      // HEAD against itself changes nothing: no file to lint, no test due.
      expect(steps.filter(([name]) => name === "tests" || name === "lint").map(([, command]) => command)).toEqual(["true", "true"])
    }).pipe(Effect.scoped),
  )

  it.live.layer(BunServices.layer)("oxlint reads the changed TypeScript still on disk: a rename's new path, never a deletion", () =>
    Effect.gen(function* () {
      const { exists, legs, ran, tests } = yield* tree
      expect(lintFiles(parseNameStatus("M\tscripts/gate.ts\nD\tscripts/gone.ts\nR090\tscripts/old-name.ts\tscripts/reach.ts\nM\ttests/parity.json\n"), exists)).toEqual(["scripts/gate.ts", "scripts/reach.ts"])
    }),
  )
})
