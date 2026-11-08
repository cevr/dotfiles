// `bun run accept`: the acceptance tests (tests/*.test.ts), most of which run
// real OpenCode from OPENCODE_DEV on a scripted model, every file at once
// across the cores, without ANTHROPIC_BASE_URL.
// `bun run accept:affected [base]`: only the files that reach a file changed
// since `base` (default: where HEAD left origin/main), committed or not, as
// scripts/reach.ts derives it; a change to a shared input (root manifest, lock
// file, configs, these scripts) runs them all. A change to the OpenCode
// checkout itself is outside this repository: run `bun run accept` after one.
//
// Usage: bun scripts/accept.ts [--affected [base]] [--list] [--parallel=N] [-- <bun test flags>]
// --list prints the files it would run and exits.
//
// One run at a time per machine: each run already fills every core, so a second
// one waits for the lock (ACCEPT_LOCK, default $TMPDIR/opencode-accept.lock)
// instead of starving the machine and the owner's own OpenCode windows.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"
import { listing, type Proc, servers, stop, survivors, table, watch } from "./leaks.ts"
import { acceptanceTests, load, packageOf, reach, ROOT, SHARED } from "./reach.ts"

/** How long a finished run's processes have to end before one still running counts as leaked. */
const LEAK_GRACE_MS = 5000

const argv = process.argv.slice(2)
const rest = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : []
const own = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv
const affected = own.includes("--affected")
const parallel = own.find((arg) => arg.startsWith("--parallel"))
const CACHE = path.join(ROOT, "node_modules/.cache/gate")
mkdirSync(CACHE, { recursive: true })

if (!process.env.OPENCODE_DEV) console.warn("accept: OPENCODE_DEV is not set, so the real-OpenCode tests skip. Point it at the fork.")

const workspace = await load()
let files = acceptanceTests(workspace)

if (affected) {
  const named = own[own.indexOf("--affected") + 1]
  const base =
    named !== undefined && !named.startsWith("--")
      ? named
      : (await $`git merge-base HEAD origin/main`.cwd(ROOT).quiet().nothrow().text()).trim() || "HEAD"
  const diff = await $`git diff --name-only --relative ${base}`.cwd(ROOT).quiet().text()
  const untracked = await $`git ls-files --others --exclude-standard`.cwd(ROOT).quiet().text()
  const changed = [...new Set([...diff.split("\n"), ...untracked.split("\n")].filter((file) => file !== ""))]
  if (changed.some((file) => SHARED.includes(file))) console.log(`accept: a shared input changed since ${base.slice(0, 12)}; running every file`)
  else {
    const memo = new Map<string, ReadonlyArray<string>>()
    files = files.filter((file) => {
      const reached = reach(workspace, [file], memo)
      const packages = new Set([...reached].flatMap((each) => packageOf(each) ?? []))
      // A deleted file is gone from the checkout; its package still counts.
      return changed.some((each) => reached.has(each) || (packageOf(each) !== undefined && packages.has(packageOf(each)!)))
    })
    console.log(`accept: ${files.length} of ${acceptanceTests(workspace).length} files reach the ${changed.length} files changed since ${base.slice(0, 12)}`)
  }
  if (files.length === 0) process.exit(0)
}
if (own.includes("--list")) {
  for (const file of files) console.log(file)
  process.exit(0)
}

const LOCK = process.env.ACCEPT_LOCK ?? path.join(os.tmpdir(), "opencode-accept.lock")
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const holder = () => {
  try {
    return JSON.parse(readFileSync(path.join(LOCK, "owner.json"), "utf8")) as { pid: number; root: string }
  } catch {
    return undefined
  }
}
let told = false
for (;;) {
  try {
    mkdirSync(LOCK)
    writeFileSync(path.join(LOCK, "owner.json"), JSON.stringify({ pid: process.pid, root: ROOT }))
    break
  } catch {
    const owner = holder()
    if (owner !== undefined && !alive(owner.pid)) {
      rmSync(LOCK, { recursive: true, force: true })
      continue
    }
    if (!told) console.log(`accept: waiting for the run in ${owner?.root ?? "another checkout"} (one at a time per machine)`)
    told = true
    await Bun.sleep(2000)
  }
}
const release = () => {
  if (holder()?.pid === process.pid) rmSync(LOCK, { recursive: true, force: true })
}
process.on("exit", release)

const env = { ...process.env }
delete env.ANTHROPIC_BASE_URL
const timings = path.join(CACHE, "accept-timings.json")
// The run is a process group of its own, so a signal to accept stops every test
// process with it; `watch` follows its descendants, the ones that leave the
// group too, and what is still running after it ends is a leak (scripts/leaks.ts).
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    parallel ?? "--parallel",
    "--timeout",
    "300000",
    `--timings=${timings}`,
    "--update-timings",
    ...rest,
    ...files.map((file) => `./${file}`),
  ],
  { cwd: ROOT, env, stdout: "inherit", stderr: "inherit", detached: true },
)
const watching = watch(child.pid)
let stopping = false
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      // The run's group is gone already.
    }
    // A test's own process groups are outside the run's: its servers are stopped by name.
    void stop(servers(survivors(watching.stop(), table()))).finally(() => {
      release()
      process.exit(130)
    })
  })
const code = await child.exited
if (stopping) await new Promise(() => {})
process.exit((await leaked(watching.stop())) ? code || 1 : code)

/** Whether the run left a server or drive behind; stops those and names every survivor. */
async function leaked(seen: ReadonlyArray<Proc>): Promise<boolean> {
  // A test's teardown may still be ending what it started.
  const deadline = Date.now() + LEAK_GRACE_MS
  let left = survivors(seen, table())
  while (left.length > 0 && Date.now() < deadline) {
    await Bun.sleep(250)
    left = survivors(seen, table())
  }
  const strays = servers(left)
  const others = left.filter((proc) => !strays.includes(proc))
  if (others.length > 0) console.warn(`accept: ${others.length} test processes outlived the run:\n${listing(others)}`)
  if (strays.length === 0) return false
  console.error(`accept: the run leaked ${strays.length} OpenCode servers or drive runs; stopping them:\n${listing(strays)}`)
  await stop(strays)
  return true
}
