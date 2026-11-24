// @reads all
// @reads-reason subprocess reads at scripts/merge-check.test.ts: const child = yield* spawner.spawn(ChildProcess.make("bun", ["scripts/gate.ts", "--merge", "HEA
// The legs of a land's merge check (scripts/merge-check.ts, which scripts/gate.ts --merge runs as given): which
// scripts/ tests a diff selects, and that a selected test is in the leg the merge check runs.
//
// Its selections run over the scripts/ folder as it is (`tree` reads every scripts/ source by path, not import), so a
// new or changed scripts/ file can change what it asserts; it declares them, or no merge check runs it (fork-checks.test
// and required-inputs.test landed by their merge checks and turned it red on main, b5735808):
// Which tests import or read a path is the tree's fact, derived (`found`); what a case pins by hand is a rule's decision.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Glob } from "bun"
import { matchingInput } from "../tests/read-path.ts"
import { Effect, FileSystem, Option, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { describe, expect, it } from "effect-bun-test"
import { hangGuard } from "../tests/hang-guard.ts"
import { acceptKey } from "./accept-key.ts"
import { emptyLedger, select, tierOf, withPass } from "./accept-ledger.ts"
import { analyzeMerge } from "./gate.ts"
import { parseNameStatus as parseNulNameStatus } from "./git-paths.ts"
import { ACCEPT_TESTS, affectedUnits, DOCS_GUARD, GIT_REPO_GUARD, lintFiles, mergeLegs, reachedWithin, scriptTests } from "./merge-check.ts"
import { mergeUnitInputs, swarmInputs } from "./test-impact.ts"
import { readMatcher } from "./read-declarations.ts"
import { acceptReach, importsOf, inspectReads, load, reach, readState, readsOf, testReadInputs } from "./reach.ts"
import { acceptanceTests, checkedTests, mergeScriptTests, swarmTests, workboxTestFiles } from "./test-population.ts"
import { reachedSuites } from "./accept-plan.ts"

const parseNameStatus = (out: string) => parseNulNameStatus(out.replace(/[\t\n]/g, "\0"))

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

/** Scoped inputs from the real scripts/ tree. Unknown selection is exercised separately with a controlled reader. */
const tree = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const workspace = yield* Effect.promise(load)
  const files = [...new Glob("scripts/*.{ts,tsx}").scanSync()]
  const sources = files
  const texts = new Map(yield* Effect.forEach(sources, (file) => Effect.map(fs.readFileString(matchingInput("scripts/*.{ts,tsx}", file)), (text) => [file, text] as const)))
  const imports = new Map([...texts].map(([file, text]) => [file, importsOf(file, text)] as const))
  // The git-repo guard lives in tests/, outside the folder read here.
  const exists = (file: string) => files.includes(file) || file === GIT_REPO_GUARD || /^scripts\/.*\.json$/.test(file)
  const scripts = {
    files: sources.filter((file) => /\.test\.tsx?$/.test(file)),
    imports: (file: string) => imports.get(file) ?? [],
    reads: (file: string) => inspectReads(workspace, file).patterns,
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
  const importers = (file: string) => scripts.files.filter((suite) => reachedWithin(suite, scripts, exists).has(file))
  const readers = (file: string) => scripts.files.filter((suite) => scripts.reads(suite).some((glob) => glob === "all" || new Glob(glob).match(file)))
  /** The scripts/ tests whose imports reach, or whose @reads globs match, any of `files`. */
  const found = (...files: ReadonlyArray<string>) => [...new Set(files.flatMap((file) => [...importers(file), ...readers(file)]))].toSorted()
  return {
    exists,
    workspace,
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

describe("the fixed-seed unit leg of land", () => {
  it.effect("a change to a world plugin or the law table selects the host-call census", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(load)
      const suite = "sim/host-calls.test.ts"
      const tools = {
        bun: "bun",
        oxlint: "oxlint",
        typecheck: ["bun", "check", "-b"],
        projects: 3,
        exists: (file: string) => workspace.files.includes(file),
        scripts: { files: [], imports: () => [], reads: () => [] },
        workbox: { changes: [], tests: [] },
        unit: mergeUnitInputs(workspace),
      }
      for (const file of [suite, "cmd/wake/server.ts", "sim/host-laws.ts", "cmd/image/server.ts", "cmd/skills/server.ts", "sim/tsconfig.host-calls.json"]) {
        const leg = mergeLegs("base", parseNameStatus(`M\t${file}\n`), tools).find(({ name }) => name === "tests")
        expect(leg?.argv).toContain(`./${suite}`)
      }
      for (const file of ["cmd/image/server.ts", "cmd/skills/server.ts", "sim/tsconfig.host-calls.json"])
        expect(testReadInputs(workspace, suite).positive(file)).toBe(true)
      const unrelated = mergeLegs("base", parseNameStatus("M\t../AGENTS.md\n"), tools).find(({ name }) => name === "tests")
      expect(unrelated?.argv).not.toContain(`./${suite}`)
    }),
  )

  it.effect("every runner inventory file can be selected by its own change, and unit inputs retain their positive read evidence", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(load)
      const inventory = checkedTests(workspace)
      const unit = mergeUnitInputs(workspace)
      const scripted = mergeScriptTests(workspace)
      const workbox = workboxTestFiles(workspace)
      const acceptance = new Set(acceptanceTests(workspace))
      const swarm = swarmTests(workspace)
      const known = new Set([...workspace.files, ...(workspace.siblings ?? [])])
      const exists = (file: string) => known.has(file)
      const scriptedSelection = scriptTests(scripted.map((file) => ({ status: "M", paths: [file] })), exists)
      const unitSelected = affectedUnits(unit.files, unit)
      const swarmSelected = reachedSuites(swarm, () => new Set<string>(), swarm)
      const selected = new Set([...scriptedSelection, ...unitSelected, ...swarmSelected, ...workbox, ...acceptance])
      expect(inventory.filter((file) => !selected.has(file))).toEqual([])
      const memo = new Map<string, ReadonlyArray<string>>()
      expect([...acceptance].filter((file) => !acceptReach(workspace, file, memo).has(file))).toEqual([])
      expect(affectedUnits(["../local-bin.sh"], unit)).toContain("mods/update/git/source.test.ts")
      expect(affectedUnits(["../workbox/install-bin.sh"], unit)).toContain("mods/update/git/source.test.ts")
      expect(testReadInputs(workspace, "mods/update/git/source.test.ts").positive("../workbox/install-bin.sh")).toBe(true)
      expect(affectedUnits(["../unrelated-unit-control.txt"], unit)).toContain("mods/update/git/source.test.ts")
      expect(affectedUnits([], unit)).toEqual([])
    }),
  )

  it.effect("the existing swarm selects a golden file and an observed outer input, not an unrelated sibling", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(load)
      const suite = "cmd/escape/escape-send.sim.test.tsx"
      const files = swarmTests(workspace)
      const inputs = swarmInputs(workspace)
      expect(reachedSuites(files, inputs, ["sim-tui/golden/escape-send/checked.txt"])).toContain(suite)
      expect(reachedSuites(files, inputs, ["../skills/principle-nothing-is-hard/SKILL.md"])).toContain("cmd/orchestrate/principles.sim.test.ts")
      expect(reachedSuites(files, inputs, ["../unrelated-swarm-control.txt"])).toEqual(
        files.filter((file) => testReadInputs(workspace, file).unknown),
      )
    }),
  )
})

describe("the real host law's acceptance leg", () => {
  it.live.layer(BunServices.layer)("a law or real harness edit makes a previous pass due without relying on the HEAD term", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const workspace = yield* Effect.promise(load)
      const file = "tests/host-laws.test.ts"
      const tier = tierOf(yield* fs.readFileString(matchingInput("tests/host-laws.test.ts")))
      expect(readState(workspace, file)).toBe(workspace.head ?? "<missing workspace HEAD>")
      const runtime = testReadInputs(workspace, file)
      const imports = reach(workspace, [file])
      const inputs = acceptReach(workspace, file)
      const key = (changed: string) => acceptKey("same shared key", inputs, (path) => (path === changed && "edited") || "before")
      const prior = withPass(emptyLedger, file, key(""), 1)
      expect(tier).toBe("deep")
      expect(select("owed", [{ file, tier, key: key("") }], prior, 2).run).toEqual([])
      for (const changed of ["sim/host-laws.ts", "tests/host-laws/real.ts"]) {
        // A conservative HEAD term does not excuse a missing positive input.
        expect(runtime.positive(changed) || imports.has(changed)).toBe(true)
        expect(inputs.has(changed)).toBe(true)
        const candidate = { file, tier, key: key(changed) }
        expect(select("owed", [candidate], prior, 2).run).toEqual([file])
        expect(select("land", [candidate], prior, 2).settled).toContainEqual({ file, status: "owed", why: "deep", detail: "" })
      }
    }),
  )
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
      for (const suite of ["scripts/fork-checks.test.ts", "scripts/accept.test.ts", "scripts/merge-check.test.ts"]) expect(tests("M\tscripts/reach.ts\n")).toContain(suite)
      expect(tests("M\tscripts/accept-key.ts\n")).toContain("scripts/accept-ledger.test.ts")
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
      const { expected, ran, tests } = yield* tree
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
      // A path-specific reader is not selected simply because another test has unknown inputs.
      expect(tests("M\tREADME.txt\n")).toEqual(expected([], "README.txt"))
      expect(tests("M\tREADME.txt\n")).not.toContain(RUNTIME_IMPORTS)
    }),
  )

  it.live.layer(BunServices.layer)("the full gate's explicit cache inputs cover runtime-imports.test's cmd and mod readers without covering the whole tree", () =>
    Effect.gen(function* () {
      const { workspace } = yield* tree
      const inputs = ["cmd/work/server.ts", "mods/work/tool.ts", "themes/prime.json"]
        .filter(readMatcher(inspectReads(workspace, "scripts/runtime-imports.test.ts").patterns))
      expect(inputs).toEqual(["cmd/work/server.ts", "mods/work/tool.ts"])
    }),
  )

  it.live.layer(BunServices.layer)("the full gate's import reach still covers runtime-imports.test's named cmd and mod source", () =>
    Effect.gen(function* () {
      const { workspace } = yield* tree
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
      for (const out of ["A\ttests/new.test.ts\n", "M\tdecider/tui-clock.ts\n"]) expect(tests(out)).not.toContain("scripts/merge-check.test.ts")
      // JSON from a static import is in the import graph, not an @reads dependency.
      expect(tests("M\tscripts/fork-checks.json\n")).toContain("scripts/fork-checks.test.ts")
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

  it.effect("an unrelated diff runs unknown-input tests, not a test with a scoped declaration", () =>
    Effect.sync(() => {
      const files = ["scripts/opaque.test.ts", "scripts/scoped.test.ts"]
      const scripts = {
        files,
        imports: () => [],
        reads: (file: string) => (file === "scripts/opaque.test.ts" && ["all"]) || ["fixtures/**"],
      }
      const exists = (file: string) => files.includes(file)
      expect(scriptTests(parseNameStatus("M\t../some/unrelated.txt\n"), exists, scripts)).toEqual(["scripts/opaque.test.ts"])
      expect(scriptTests(parseNameStatus("D\t../a-deleted-file\n"), exists, scripts)).toEqual(["scripts/opaque.test.ts"])
      expect(scriptTests([], exists, scripts)).toEqual([])
    }),
  )

  it.live.layer(BunServices.layer)("a change selects readers and unknown-input tests; an empty diff selects none", () =>
    Effect.gen(function* () {
      const { expected, found, importers, tests, workspace } = yield* tree
      expect(tests("M\tthemes/prime.json\n")).toEqual(expected([], "themes/prime.json"))
      expect(tests("")).toEqual([])
      // The timing guard resolves imported literals: a declaration can change a runner cap without a test-file diff.
      const clock = "decider/tui-clock.ts"
      expect(tests(`M\t${clock}\n`)).toEqual(found(clock))
      const timing = "scripts/wall-clock-assertions.test.ts"
      expect(testReadInputs(workspace, timing).positive(clock)).toBe(true)
      const analysis = analyzeMerge(workspace)
      const selected = mergeLegs("base", parseNameStatus(`M\t${clock}\n`), {
        ...analysis.tools,
        workbox: { changes: [], tests: analysis.workbox },
      }).find((leg) => leg.name === "tests")
      expect(selected?.argv).toContain(`./${timing}`)
      // Pins: its test runs the git-repo guard, beside the tests that read every test source (required-inputs.test's @reads).
      expect(tests("M\tthemes/prime.json\nM\tdecider/tui-clock.test.ts\n")).toEqual(expected([GIT_REPO_GUARD], "themes/prime.json", "decider/tui-clock.test.ts"))
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
      for (const suite of [...ACCEPT_TESTS, "scripts/link-fork.test.ts"]) expect(ran(both)).toContain(suite)
      const none = legs("")
      expect(none.map((leg) => leg.name)).toEqual(["lint", "test-reads", "debt", "types", "tests"])
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
      expect([...reachedWithin("scripts/a.test.ts", scripts, exists)].toSorted()).toEqual(["scripts/a.test.ts", "scripts/b.ts", "scripts/c.ts", "scripts/fixtures/data.json"])
      expect(scriptTests(parseNameStatus("M\tscripts/c.ts\n"), exists, scripts)).toEqual(["scripts/a.test.ts"])
      expect(scriptTests(parseNameStatus("M\tscripts/fixtures/data.json\n"), exists, scripts)).toEqual(["scripts/a.test.ts"])
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

  it.live.layer(BunServices.layer)("gate.ts --merge starts the link, lint, debt, test-read guard, types and selected tests (batch 2026-11-15cr T1)", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(ChildProcess.make("bun", ["scripts/gate.ts", "--merge", "HEAD", "--dry-run"], { cwd: root, extendEnv: true, stdin: "ignore", forceKillAfter: "3 seconds" }))
      const [stdout, code] = yield* Effect.all([child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode], { concurrency: 2 })
      const steps = stdout.split("\n").flatMap((line) => Option.toArray(Option.map(Option.fromNullishOr(/^step ([\w-]+): (.*)$/.exec(line)), (match) => [String(match[1]), String(match[2])] as const)))
      expect(Number(code)).toBe(0)
      // Each step prints from its own echo, so their order is not asserted.
      expect(steps.map(([name]) => name).toSorted()).toEqual(["debt", "link", "lint", "test-reads", "tests", "types"])
      // HEAD against itself changes nothing: no file to lint, no test due.
      expect(steps.filter(([name]) => name === "tests" || name === "lint").map(([, command]) => command)).toEqual(["true", "true"])
    }).pipe(Effect.scoped),
    hangGuard("unit-law"),
  )

  it.live.layer(BunServices.layer)("oxlint reads the changed TypeScript still on disk: a rename's new path, never a deletion", () =>
    Effect.gen(function* () {
      const { exists, legs, ran, tests } = yield* tree
      expect(lintFiles(parseNameStatus("M\tscripts/gate.ts\nD\tscripts/gone.ts\nR090\tscripts/old-name.ts\tscripts/reach.ts\nM\ttests/parity.json\n"), exists)).toEqual(["scripts/gate.ts", "scripts/reach.ts"])
    }),
  )
})
