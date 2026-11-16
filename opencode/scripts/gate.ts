// `bun run gate`: the check every change passes before it is pushed.
//
// It links the fork's modules (scripts/link-fork.ts), then runs five legs at
// once and fails if any fails:
// - lint: oxlint over the whole workspace; debt: `scripts/effect-debt.ts --check`, its per-file Effect rule budgets;
// - agents: `scripts/agents.ts --check`, mods/orchestrate/agents.json against the skill;
// - types: every project (the root and each mods/*, cmd/* package) with
//   `bun check`, all of them every time;
// - unit: the test files outside tests/ (mods/**, cmd/**, decider/**, scripts/), in
//   parallel, without ANTHROPIC_BASE_URL. A file that passed is skipped while
//   the key over everything it reaches is unchanged (scripts/reach.ts): its
//   package, the packages that package depends on, and the shared inputs
//   (root manifest, lock file, configs, Bun, the OpenCode checkout). A change
//   to a shared package re-runs every test of every package that depends on it.
//
// The acceptance tests in tests/ run real OpenCode and are not part of it:
// `bun run accept` (all) and `bun run accept:affected` (those that reach a
// changed file) run them.
//
// One full gate runs on a host at a time: the whole run, link included, holds
// the host's checks lock (the one a land's gate and accept checks hold
// shared; mods/work/process/flock.ts's `gateTurn`) exclusively. A second gate
// waits for its turn, saying who holds the lock and since when, and a land's
// check that comes while it waits goes first. The land's own gate check
// (RIFT_LAND_CHECK=gate) runs at once, under the locks its land holds.
// Focused runs (`bun test <files>`) never take it.
//
// Receipts (mods/work/receipt.ts): a gate run by hand writes a `round` receipt for the head and tracked
// files it started at into the checkout (its Git dir's rift-receipt.json) and the host's receipts folder,
// green or red; a land takes it instead of running the Rift's checks again (any other proof of a round
// is written with scripts/receipt.ts). `--merge <base>` is a land's merge check (`rift.mergeCheck`): the link, every
// project's typecheck, oxlint over the files changed since <base> and the debt ratchet over them
// (`effect-debt.ts --check --since <base>`), and the scripts/ tests and the verify-opencode docs guard the changes can
// break (scripts/merge-check.ts), no lock and no receipt (the land writes it).
//
// Usage: bun scripts/gate.ts [--all]   (--all ignores the cache)
//        bun scripts/gate.ts --merge <base> [--dry-run]   (--dry-run prints each step it would start, runs nothing)
// The cache is node_modules/.cache/gate/passed.json; deleting it is safe.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { Option } from "effect"
import { hostLocks, landLogs, scriptReceipt } from "../mods/work/process/landing.ts"
import { parseNameStatus } from "./docs-guard.ts"
import { mergeLegs } from "./merge-check.ts"
import { checkCommand, projects } from "./typecheck.ts"
import { importsOf, keyOf, load, reach, ROOT, sharedKey, unitTests } from "./reach.ts"

const ENV = process.env
const ARGV = process.argv.slice(2)
const all = ARGV.includes("--all")
const CACHE = path.join(ROOT, "node_modules/.cache/gate")
const PASSED = path.join(CACHE, "passed.json")
const REPORT = path.join(CACHE, "unit.xml")
const TIMINGS = path.join(CACHE, "timings.json")
const KEPT = 8
mkdirSync(CACHE, { recursive: true })

const elapsed = (from: number) => `${((performance.now() - from) / 1000).toFixed(2)}s`

interface Leg {
  readonly name: string
  readonly ok: boolean
  readonly output: string
  readonly time: string
  readonly note?: string
}

/** Runs `argv` in ROOT, capturing its output. */
const run = (name: string, argv: ReadonlyArray<string>, env: Record<string, string | undefined> = ENV, note?: string): Promise<Leg> => {
  const from = performance.now()
  const child = Bun.spawn([...argv], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" })
  return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([out, err, code]) => ({
    name,
    ok: code === 0,
    output: `${out}${err}`,
    time: elapsed(from),
    ...(note === undefined ? {} : { note }),
  }))
}

/** Every project in one `bun check -b` (scripts/typecheck.ts). */
const types = () => run("types", [...checkCommand(), "--no-pretty"], ENV, `${projects().length + 1} projects`)

const unit = async (): Promise<Leg> => {
  const from = performance.now()
  const workspace = await load()
  const shared = await sharedKey(["unit", "--timeout 300000"])
  const memo = new Map<string, ReadonlyArray<string>>()
  const files = unitTests(workspace)
  const keys = new Map(files.map((file) => [file, keyOf(shared, reach(workspace, [file], memo))]))
  // Each file keeps the keys of its last few passes, so going back to an earlier state (a revert, a branch switch) hits too.
  const stored: Record<string, ReadonlyArray<string>> = existsSync(PASSED) ? JSON.parse(readFileSync(PASSED, "utf8")) : {}
  const passed = Object.fromEntries(Object.entries(stored).filter(([, list]) => Array.isArray(list)))
  const due = files.filter((file) => all || !passed[file]?.includes(keys.get(file)!))
  const note = `${due.length} of ${files.length} files run`
  if (due.length === 0) return { name: "unit", ok: true, output: "", time: elapsed(from), note: `${note}; all passed unchanged` }
  const env = { ...ENV }
  delete env.ANTHROPIC_BASE_URL
  const leg = await run(
    "unit",
    [
      process.execPath,
      "test",
      "--parallel",
      "--timeout",
      "300000",
      `--timings=${TIMINGS}`,
      "--update-timings",
      "--reporter=junit",
      `--reporter-outfile=${REPORT}`,
      ...due.map((file) => `./${file}`),
    ],
    env,
  )
  // Record each file that passed, keyed on what it reaches; a failed file stays due.
  const report = existsSync(REPORT) ? readFileSync(REPORT, "utf8") : ""
  const green = new Set<string>()
  for (const match of report.matchAll(/^ {2}<testsuite name="[^"]*" file="([^"]+)" tests="\d+" assertions="\d+" failures="(\d+)"/gm))
    if (match[2] === "0") green.add(match[1]!)
  const next = { ...passed }
  for (const file of due) if (leg.ok && green.has(file)) next[file] = [keys.get(file)!, ...(next[file] ?? []).filter((key) => key !== keys.get(file))].slice(0, KEPT)
  for (const file of Object.keys(next)) if (!keys.has(file)) delete next[file]
  writeFileSync(PASSED, JSON.stringify(next, null, 2))
  return { ...leg, time: elapsed(from), note }
}

/** Prints the failed legs' output and the summary line; answers the exit code. */
const summary = (name: string, started: number, legs: ReadonlyArray<Leg>): number => {
  for (const leg of legs.filter((each) => !each.ok)) process.stderr.write(`\n── ${leg.name} failed ──\n${leg.output.trimEnd()}\n`)
  const line = legs.map((leg) => `${leg.ok ? "✓" : "✗"} ${leg.name} ${leg.time}${leg.note ? ` (${leg.note})` : ""}`).join("  ·  ")
  const ok = legs.every((leg) => leg.ok)
  console.log(`${line}\n${name} ${ok ? "green" : "red"} in ${elapsed(started)}`)
  return ok ? 0 : 1
}

/** The link, then `legs` at once, as `name`; answers its exit code. `runner` starts the link (a dry run's prints it). */
const linked = async (name: string, legs: () => ReadonlyArray<Promise<Leg>>, runner: typeof run = run): Promise<number> => {
  const started = performance.now()
  const link = await runner("link", [process.execPath, "scripts/link-fork.ts"])
  if (!link.ok) {
    process.stderr.write(link.output)
    return 1
  }
  return summary(name, started, await Promise.all(legs()))
}

/** The gate in its turn: the link, then the five legs at once; answers its exit code. */
const gate = () =>
  linked("gate", () => [
    run("lint", [path.join(ROOT, "node_modules/.bin/oxlint"), "--quiet"]),
    run("debt", [process.execPath, "scripts/effect-debt.ts", "--check"]),
    run("agents", [process.execPath, "scripts/agents.ts", "--check"]),
    types(),
    unit(),
  ])

/** The changes since `base`, from this folder. */
const changesSince = (base: string) =>
  $`git -C ${ROOT} diff --name-status --relative ${base} HEAD -- .`.nothrow().quiet().text().then(parseNameStatus)

/** The environment the merge check's legs run in: the unit leg's, without ANTHROPIC_BASE_URL, so its tests ask no model. */
const legEnv = () => {
  const env = { ...ENV }
  delete env.ANTHROPIC_BASE_URL
  return env
}

/**
 * A land's merge check of the merged tree: the link, then the legs scripts/merge-check.ts names over the changes
 * since `base` (every project's typecheck, oxlint and the Effect debt ratchet over the changed files, and the
 * scripts/ tests and docs guard a change can break), at once.
 */
const mergeCheck = (base: string, runner: typeof run) =>
  planned(base).then((legs) => linked("merge check", () => legs.map((leg) => runner(leg.name, leg.argv, legEnv(), leg.note)), runner))

/**
 * `--dry-run`'s runner: it runs nothing, prints the leg (`step <name>: <command>`) and answers it passed. The merge
 * check runs the same path with it, link and every leg, so scripts/merge-check.test.ts reads the steps it starts.
 */
const printed: typeof run = (name, argv, _env, note) => {
  console.log(`step ${name}: ${argv.join(" ")}`)
  return Promise.resolve({ name, ok: true, output: "", time: "0.00s", note: Option.getOrElse(Option.fromUndefinedOr(note), () => "") })
}

/** The merge check's legs over the changes since `base` (scripts/merge-check.ts), with each scripts/ file's imports. */
const planned = (base: string) =>
  changesSince(base).then((changes) =>
    mergeLegs(base, changes, {
      bun: process.execPath,
      oxlint: path.join(ROOT, "node_modules/.bin/oxlint"),
      typecheck: checkCommand(),
      projects: projects().length + 1,
      exists: (file) => existsSync(path.join(ROOT, file)),
      scripts: {
        files: readdirSync(path.join(ROOT, "scripts")).filter((name) => /\.test\.tsx?$/.test(name)).map((name) => `scripts/${name}`),
        imports: (file) => importsOf(file, readFileSync(path.join(ROOT, file), "utf8")),
      },
    }),
  )

/** The full gate: by hand, its `round` receipt written from where the repository stood; under a land (RIFT_LAND_CHECK set), the land writes its own. */
const fullGate = () =>
  Option.match(Option.fromUndefinedOr(ENV.RIFT_LAND_CHECK), {
    onSome: gate,
    onNone: () => scriptReceipt(landLogs(ENV), path.resolve(ROOT, ".."), "round", "bun run gate", gate, (code) => code),
  })

/** `--merge <base>`: the merge check, or with `--dry-run` its legs printed. */
const mergeRun = (base: string) => {
  if (ARGV.includes("--dry-run")) return mergeCheck(base, printed)
  return mergeCheck(base, run)
}

const merging = Option.filter(Option.some(ARGV.indexOf("--merge")), (at) => at >= 0)
process.exit(
  await Option.match(merging, {
    onSome: (at) => mergeRun(ARGV[at + 1] ?? "HEAD"),
    onNone: () => hostLocks(ENV).gate(ROOT)(fullGate),
  }),
)
