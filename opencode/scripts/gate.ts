// `bun run gate`: the check every change passes before it is pushed.
//
// It links the fork's modules (scripts/link-fork.ts), then runs four legs at
// once and fails if any fails:
// - lint: oxlint over the whole workspace;
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
// Usage: bun scripts/gate.ts [--all]   (--all ignores the cache)
// The cache is node_modules/.cache/gate/passed.json; deleting it is safe.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { checkCommand, projects } from "./typecheck.ts"
import { keyOf, load, reach, ROOT, sharedKey, unitTests } from "./reach.ts"

const started = performance.now()
const all = process.argv.includes("--all")
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
const run = async (name: string, argv: ReadonlyArray<string>, env: Record<string, string | undefined> = process.env, note?: string): Promise<Leg> => {
  const from = performance.now()
  const child = Bun.spawn([...argv], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { name, ok: code === 0, output: `${out}${err}`, time: elapsed(from), ...(note === undefined ? {} : { note }) }
}

const link = await run("link", [process.execPath, "scripts/link-fork.ts"])
if (!link.ok) {
  process.stderr.write(link.output)
  process.exit(1)
}

/** Every project in one `bun check -b` (scripts/typecheck.ts). */
const types = () => run("types", [...checkCommand(), "--no-pretty"], process.env, `${projects().length + 1} projects`)

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
  const env = { ...process.env }
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

const legs = await Promise.all([
  run("lint", [path.join(ROOT, "node_modules/.bin/oxlint"), "--quiet"]),
  run("agents", [process.execPath, "scripts/agents.ts", "--check"]),
  types(),
  unit(),
])

for (const leg of legs.filter((each) => !each.ok)) process.stderr.write(`\n── ${leg.name} failed ──\n${leg.output.trimEnd()}\n`)
const line = legs.map((leg) => `${leg.ok ? "✓" : "✗"} ${leg.name} ${leg.time}${leg.note ? ` (${leg.note})` : ""}`).join("  ·  ")
const ok = legs.every((leg) => leg.ok)
console.log(`${line}\n${ok ? "gate green" : "gate red"} in ${elapsed(started)}`)
process.exit(ok ? 0 : 1)
