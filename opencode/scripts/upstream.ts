// `bun run daily`'s first step on the Mac: merges upstream OpenCode (`upstream/dev`) into the fork's
// `prime-look` before the build.
//
// The merge happens in a worktree of the fork of its own (detached, kept between runs so its
// node_modules stay warm), never in the checkout `OPENCODE_DEV` builds. A conflict is aborted; a
// clean merge must pass the fork's typecheck (packages/tui, core, plugin) and the dotfiles
// acceptance tests most exposed to host changes, run against the merged worktree with the mods linked
// to it, on a calm host, a failed file rerun once (`acceptance`). Only then does
// `prime-look` fast-forward to the merge and go to origin. A conflict or a red check leaves
// `prime-look` where it was and writes the report an agent resolves it from; the install goes on
// with the fork as it is, so the merge never blocks it.
//
// Only the fork's owner runs it (the Mac, `FORK_OWNER`); the workbox pulls origin prime-look.
// Before it, on every host, `syncFork` fast-forwards prime-look to origin/prime-look, so the merge
// never starts from a branch origin has moved past.
import { dlopen, FFIType } from "bun:ffi"
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { loadavg, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { UpstreamReading } from "../mods/prime/update.ts"

/** The host that owns the fork, as `peersOf` names hosts (lower case, no `.local`). */
export const FORK_OWNER = "cristians-macbook-pro"
export const BRANCH = "prime-look"
export const UPSTREAM_REMOTE = "upstream"
export const UPSTREAM_BRANCH = "dev"

const hostKey = (host: string) => host.toLowerCase().replace(/\.local$/, "")
export const ownsFork = (host: string): boolean => hostKey(host) === FORK_OWNER

export type CheckResult = { readonly ok: true } | { readonly ok: false; readonly check: string; readonly log: string }
/** Checks a merged checkout of the fork at `dir`. */
export type Checks = (dir: string) => Promise<CheckResult>

export type Outcome =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "fetch-failed"; readonly error: string }
  | { readonly kind: "up-to-date" }
  | { readonly kind: "would-merge"; readonly commits: number; readonly upstream: string }
  | { readonly kind: "conflict"; readonly files: ReadonlyArray<string>; readonly upstream: string }
  | { readonly kind: "red"; readonly check: string; readonly merge: string; readonly upstream: string }
  | { readonly kind: "stuck"; readonly reason: string; readonly merge: string; readonly upstream: string }
  | { readonly kind: "merged"; readonly from: string; readonly merge: string; readonly commits: number; readonly pushed: boolean }

export interface Options {
  /** The fork checkout (`OPENCODE_DEV`); its repository gets the worktree, its remotes are read. */
  readonly fork: string
  readonly host: string
  /** `--no-upstream`. */
  readonly skip: boolean
  /** `--dry-run`: fetch and say what would merge, change nothing. */
  readonly dryRun: boolean
  readonly checks: Checks
  /**
   * Runs a green merge's change to the fork checkout (the fast-forward of prime-look and the install
   * after it) and answers what it answered: `unlocked` runs it as is; a land's post-land step holds the
   * land's checks lock around it, since the land's gate and accept read the checkout.
   */
  readonly landing: <A>(step: () => A) => A
  /** The merge worktree's directory. */
  readonly worktree: string
  /** The report a conflict or a red check writes, removed once the fork is current again. */
  readonly report: string
  readonly log: (line: string) => void
  /** The env of every git child (and the pre-push install); the process's when absent. A test hands a hermetic one. */
  readonly env?: GitEnv
}

/** An environment for the git children: names to values, unset where undefined. */
export type GitEnv = Readonly<NodeJS.ProcessEnv>

/** The branch a merge that could not land is kept on, so an agent can start from it. */
export const HELD_BRANCH = "daily/upstream-merge"

const decoder = new TextDecoder()

/** git run with `env` (plus no prompts and no merge editor) for every child: the process's env unless a caller hands its own. */
const runner = (env: GitEnv = process.env) => {
  const git = (dir: string, ...args: ReadonlyArray<string>) => {
    const ran = Bun.spawnSync(["git", "-C", dir, ...args], {
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
      stdout: "pipe",
      stderr: "pipe",
    })
    return { ok: ran.exitCode === 0, out: decoder.decode(ran.stdout).trim(), err: decoder.decode(ran.stderr).trim() }
  }
  const must = (dir: string, ...args: ReadonlyArray<string>) => {
    const ran = git(dir, ...args)
    if (!ran.ok) throw new Error(`git ${args.join(" ")} in ${dir}: ${ran.err || ran.out}`)
    return ran.out
  }
  return { git, must, env }
}
type Runner = ReturnType<typeof runner>

/** The worktree that has `refs/heads/<branch>` checked out, if any. */
const checkedOut = ({ must }: Runner, fork: string, branch: string): string | undefined => {
  let path: string | undefined
  for (const line of must(fork, "worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length)
    if (line === `branch refs/heads/${branch}`) return path
  }
  return undefined
}

/** A detached worktree of the fork at `BRANCH`: the one from the last run when it is still there. */
const prepareWorktree = ({ git, must }: Runner, fork: string, dir: string) => {
  const registered = must(fork, "worktree", "list", "--porcelain")
    .split("\n")
    .some((line) => line === `worktree ${dir}`)
  if (registered && existsSync(join(dir, ".git"))) {
    git(dir, "merge", "--abort")
    must(dir, "checkout", "--detach", "--force", BRANCH)
    return
  }
  // A directory left without its registration (or the reverse) is ours: start it over. Never the
  // fork itself or a directory holding it.
  if (fork === dir || fork.startsWith(`${dir}/`)) throw new Error(`the merge worktree ${dir} holds the fork ${fork}`)
  rmSync(dir, { recursive: true, force: true })
  must(fork, "worktree", "prune")
  mkdirSync(dirname(dir), { recursive: true })
  must(fork, "worktree", "add", "--detach", dir, BRANCH)
}

const writeReport = (options: Options, lines: ReadonlyArray<string>) => {
  mkdirSync(dirname(options.report), { recursive: true })
  writeFileSync(options.report, `${lines.join("\n")}\n`)
  options.log(`upstream: report in ${options.report}`)
}

const reportHeader = (options: Options, title: string, upstream: string, base: string) => [
  `# ${title}`,
  "",
  `Written by \`bun run daily\` (dotfiles/opencode/scripts/upstream.ts) on ${new Date().toISOString()}.`,
  "",
  `- fork: ${options.fork}`,
  `- ${BRANCH}: ${base} (unchanged; the install built the fork as it was)`,
  `- ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}: ${upstream}`,
  "",
]

/** `Options.landing` with no lock: the step runs as is. */
export const unlocked = <A>(step: () => A): A => step()

/** Runs the step; never throws for a merge that cannot land, only for a broken fork checkout. */
export const mergeUpstream = async (options: Options): Promise<Outcome> => {
  const { fork, log } = options
  if (options.skip) return { kind: "skipped", reason: "--no-upstream" }
  if (!ownsFork(options.host)) return { kind: "skipped", reason: `${options.host} does not own the fork; it pulls origin ${BRANCH}` }
  const run = runner(options.env)
  const { git, must } = run

  const fetched = git(fork, "fetch", "--quiet", UPSTREAM_REMOTE, UPSTREAM_BRANCH)
  if (!fetched.ok) {
    log(`upstream: fetch failed, building the fork as it is: ${fetched.err}`)
    return { kind: "fetch-failed", error: fetched.err }
  }
  const tracking = `refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`
  const upstream = must(fork, "rev-parse", tracking)
  const base = must(fork, "rev-parse", `refs/heads/${BRANCH}`)
  const commits = Number(must(fork, "rev-list", "--count", `${base}..${upstream}`))
  if (commits === 0) {
    log(`upstream: ${BRANCH} has every commit of ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`)
    if (!options.dryRun) rmSync(options.report, { force: true })
    return { kind: "up-to-date" }
  }
  if (options.dryRun) {
    log(`upstream: would merge ${commits} commits of ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} (${upstream.slice(0, 10)}) into ${BRANCH} (${base.slice(0, 10)})`)
    return { kind: "would-merge", commits, upstream }
  }

  log(`upstream: merging ${commits} commits of ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} into ${BRANCH} in ${options.worktree}`)
  prepareWorktree(run, fork, options.worktree)
  const merged = git(options.worktree, "merge", "--no-edit", upstream)
  if (!merged.ok) {
    const files = git(options.worktree, "diff", "--name-only", "--diff-filter=U").out.split("\n").filter((file) => file !== "")
    git(options.worktree, "merge", "--abort")
    must(options.worktree, "checkout", "--detach", "--force", BRANCH)
    log(`upstream: the merge conflicts in ${files.length} files; ${BRANCH} unchanged`)
    for (const file of files) log(`  ${file}`)
    writeReport(options, [
      ...reportHeader(options, `Upstream merge conflicts in ${files.length} files`, upstream, base),
      "## Conflicting files",
      "",
      ...(files.length === 0 ? [`(none listed; git said: ${merged.err || merged.out})`] : files.map((file) => `- ${file}`)),
      "",
      "## To resolve",
      "",
      `In a checkout of ${BRANCH} (not the one a build is using): \`git fetch ${UPSTREAM_REMOTE} && git merge ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}\`, resolve, run the checks, push origin ${BRANCH}. The next \`bun run daily\` then finds ${BRANCH} current.`,
      "",
      "Prefer upstream (opencode/AGENTS.md): where upstream now does what a fork change does, take upstream's and drop ours, keeping only a difference the owner relies on; tell the owner what changes for them before dropping ours, and list each dropped or slimmed fork change in the hand-back.",
    ])
    return { kind: "conflict", files, upstream }
  }

  const merge = must(options.worktree, "rev-parse", "HEAD")
  const hold = (title: string, detail: ReadonlyArray<string>) => {
    must(fork, "branch", "--force", HELD_BRANCH, merge)
    writeReport(options, [
      ...reportHeader(options, title, upstream, base),
      `The merge is kept on branch \`${HELD_BRANCH}\` (${merge}).`,
      "",
      ...detail,
    ])
  }

  const result = await options.checks(options.worktree)
  if (!result.ok) {
    log(`upstream: the merge is red (${result.check}); ${BRANCH} unchanged`)
    hold(`Upstream merge is red: ${result.check}`, [
      "## Failing check",
      "",
      `\`${result.check}\`, run against the merged worktree ${options.worktree}:`,
      "",
      "```",
      result.log,
      "```",
    ])
    return { kind: "red", check: result.check, merge, upstream }
  }

  // Fast-forward prime-look where it is checked out (the working tree follows), else the ref alone,
  // compared against where the merge started so a branch that moved meanwhile is never overwritten.
  const holder = checkedOut(run, fork, BRANCH)
  const moved = options.landing(() => {
    const forwarded = holder === undefined ? git(fork, "update-ref", `refs/heads/${BRANCH}`, merge, base) : git(holder, "merge", "--ff-only", merge)
    // The push runs the fork's pre-push check (lint, typecheck) in the checkout, whose packages are
    // still the old merge's: install the merged lockfile first, or a package upstream changed fails it.
    if (forwarded.ok && holder !== undefined && existsSync(join(holder, "bun.lock"))) {
      const installed = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: holder, env: { ...run.env }, stdout: "pipe", stderr: "pipe" })
      if (installed.exitCode !== 0) log(`upstream: bun install in ${holder} failed before the push: ${installed.stderr.toString().trim().split("\n").at(-1)}`)
    }
    return forwarded
  })
  if (!moved.ok) {
    const reason = `could not fast-forward ${BRANCH}${holder === undefined ? "" : ` in ${holder}`}: ${moved.err || moved.out}`
    log(`upstream: the merge is green but ${reason}`)
    hold("Upstream merge is green but did not land", ["## Why", "", reason])
    return { kind: "stuck", reason, merge, upstream }
  }
  rmSync(options.report, { force: true })
  const pushed = git(fork, "push", "--quiet", "origin", BRANCH)
  log(
    pushed.ok
      ? `upstream: ${BRANCH} ${base.slice(0, 10)} -> ${merge.slice(0, 10)}, pushed to origin`
      : `upstream: ${BRANCH} ${base.slice(0, 10)} -> ${merge.slice(0, 10)}; push to origin failed: ${pushed.err}`,
  )
  return { kind: "merged", from: base, merge, commits, pushed: pushed.ok }
}

/** `flock(2)`'s operations; the same numbers on macOS and Linux. */
const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

let libc: ((fd: number, operation: number) => number) | undefined
/** libc's `flock`, opened once (macOS's libSystem, glibc's libc.so.6). */
const flock = (fd: number, operation: number): number => {
  libc ??= dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }).symbols.flock as (fd: number, operation: number) => number
  return libc(fd, operation)
}

/**
 * Runs `merge` holding an exclusive `flock` on `<state>/upstream.lock`, so `bun run daily`'s step 0
 * and a land's post-land step never merge in the one worktree at once. Answers nothing, running
 * nothing, while another process holds it. The kernel owns the lock: taking it is one atomic call,
 * exactly one of any racing processes wins, and it ends with its holder (a crash, a kill, a cut at
 * any point), so there is no stale lock to judge or take over, and the file is never removed (a
 * removal would let a second holder lock a new file while the first holds the old one). The file
 * says which pid holds it, for a person reading it; nothing reads it back.
 */
export const withUpstreamLock = async <A>(state: string, merge: () => Promise<A>): Promise<A | undefined> => {
  mkdirSync(state, { recursive: true })
  // Opened without truncating: what it says is only rewritten by the holder.
  const fd = openSync(join(state, "upstream.lock"), "a+")
  try {
    if (flock(fd, LOCK_EX | LOCK_NB) !== 0) return undefined
    ftruncateSync(fd, 0)
    writeSync(fd, `${process.pid}\n`)
    try {
      return await merge()
    } finally {
      flock(fd, LOCK_UN)
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Upstream OpenCode against the build at the fork's HEAD, for the TUI's corner
 * (mods/prime/update.ts): the commits of `upstream/dev` the build lacks, and
 * whether the last merge is blocked (its `report` is there: a conflict, a red
 * check or a merge that could not land; `mergeUpstream` removes it once the
 * fork is current). With `fetch` (a host that does not own the fork, so the
 * merge step fetched nothing) it fetches upstream first, once, if the fork has
 * the remote. None when the fork has no `upstream/dev` to count against.
 */
export const upstreamReading = (fork: string, report: string, fetch: boolean, now: Date = new Date(), env?: GitEnv): UpstreamReading | undefined => {
  const { git, must } = runner(env)
  if (fetch && git(fork, "remote", "get-url", UPSTREAM_REMOTE).ok) git(fork, "fetch", "--quiet", UPSTREAM_REMOTE, UPSTREAM_BRANCH)
  const upstream = git(fork, "rev-parse", "--verify", "--quiet", `refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`)
  if (!upstream.ok) return undefined
  const build = must(fork, "rev-parse", "HEAD")
  const commits = Number(must(fork, "rev-list", "--count", `${build}..${upstream.out}`))
  return { commits, blocked: existsSync(report), upstream: upstream.out, build, at: now.toISOString() }
}

export type SyncOutcome =
  | { readonly kind: "fetch-failed"; readonly error: string }
  | { readonly kind: "current" }
  | { readonly kind: "would-fast-forward"; readonly commits: number }
  | { readonly kind: "fast-forwarded"; readonly from: string; readonly to: string; readonly commits: number }
  | { readonly kind: "left"; readonly reason: string }

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/**
 * Brings the fork's `prime-look` up to `origin/prime-look` before the merge and the build: the
 * branch may have moved from another checkout (the workbox, an agent's Rift), and a stale one
 * would redo merges origin already holds and build old code. Only a fast-forward: a branch with
 * commits origin lacks, or a checkout with uncommitted tracked changes, is left as it is and the
 * run goes on with it. Untracked files never stop it. With `to` (a commit origin's branch holds:
 * the update's verified fork commit), it goes no further than that commit.
 */
export const syncFork = (options: { readonly fork: string; readonly dryRun: boolean; readonly to?: string; readonly log: (line: string) => void; readonly env?: GitEnv }): SyncOutcome => {
  const { fork, log } = options
  const run = runner(options.env)
  const { git, must } = run
  const tracking = `refs/remotes/origin/${BRANCH}`
  const fetched = git(fork, "fetch", "--quiet", "origin", `+refs/heads/${BRANCH}:${tracking}`)
  if (!fetched.ok) {
    log(`fork: fetching origin ${BRANCH} failed, building ${BRANCH} as it is: ${fetched.err}`)
    return { kind: "fetch-failed", error: fetched.err }
  }
  const local = must(fork, "rev-parse", `refs/heads/${BRANCH}`)
  const remote = options.to ?? must(fork, "rev-parse", tracking)
  const behind = Number(must(fork, "rev-list", "--count", `${local}..${remote}`))
  if (behind === 0) return { kind: "current" }
  const leave = (reason: string): SyncOutcome => {
    log(`fork: ${BRANCH} is ${plural(behind, "commit")} behind origin but ${reason}; left as it is, building it unchanged`)
    return { kind: "left", reason }
  }
  const ahead = Number(must(fork, "rev-list", "--count", `${remote}..${local}`))
  if (ahead > 0) return leave(`has ${plural(ahead, "commit")} not on origin`)
  const holder = checkedOut(run, fork, BRANCH)
  if (holder !== undefined && git(holder, "status", "--porcelain", "--untracked-files=no").out !== "") return leave(`${holder} has uncommitted changes`)
  if (options.dryRun) {
    log(`fork: would fast-forward ${BRANCH} ${plural(behind, "commit")} to origin (${remote.slice(0, 10)})`)
    return { kind: "would-fast-forward", commits: behind }
  }
  const moved = holder === undefined ? git(fork, "update-ref", `refs/heads/${BRANCH}`, remote, local) : git(holder, "merge", "--ff-only", "--quiet", remote)
  if (!moved.ok) return leave(`the fast-forward failed: ${moved.err || moved.out}`)
  log(`fork: fast-forwarded ${BRANCH} ${local.slice(0, 10)} -> ${remote.slice(0, 10)} (${plural(behind, "commit")} from origin)`)
  return { kind: "fast-forwarded", from: local, to: remote, commits: behind }
}

/** The dotfiles acceptance tests most exposed to host changes: Prime's, the TUI's CPU, mail, orchestrate. */
export const exposedTests = (opencode: string): ReadonlyArray<string> =>
  readdirSync(join(opencode, "tests"))
    .filter((name) => /^prime-.*\.test\.ts$/.test(name) || ["tui-cpu.test.ts", "mail.test.ts", "orchestrate.test.ts"].includes(name))
    .sort()
    .map((name) => `./tests/${name}`)

const tail = (text: string, lines = 80) => text.trimEnd().split("\n").slice(-lines).join("\n")

/** The 1-minute load the acceptance tests start under; the install scripts wait for the same. */
export const CALM_LOAD = 20
/** How long the acceptance tests wait for a calm host before they start anyway. */
export const CALM_WAIT_MS = 30 * 60_000

export interface Host {
  /** The 1-minute load average. */
  readonly load: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
}
export const realHost: Host = { load: () => loadavg()[0] ?? 0, sleep: (ms) => Bun.sleep(ms), now: () => Date.now() }

/**
 * Waits until the 1-minute load is under `CALM_LOAD`, at most `CALM_WAIT_MS`. Under a load past
 * the core count the Prime scenarios miss their frames (2026-11-09: the daily ran at load 32 beside
 * another agent's full gate, and prime-goal, prime-rows, prime-wake and prime-sidebar went red),
 * so the check waits for the host rather than judging the merge by it. True when the host calmed.
 */
export const awaitCalm = async (host: Host, log: (line: string) => void, every = 15_000): Promise<boolean> => {
  const start = host.now()
  let told = false
  for (;;) {
    const load = host.load()
    if (load < CALM_LOAD) return true
    if (host.now() - start >= CALM_WAIT_MS) {
      log(`upstream: load ${load.toFixed(1)} after ${Math.round(CALM_WAIT_MS / 60_000)} min of waiting; running the acceptance tests anyway`)
      return false
    }
    if (!told) log(`upstream: load ${load.toFixed(1)} ≥ ${CALM_LOAD}; the acceptance tests wait for it to drop`)
    told = true
    await host.sleep(every)
  }
}

/** The test files (`./<path>`, as `bun test` takes them) with a failing test in bun's JUnit report. */
export const failedFiles = (junit: string): ReadonlyArray<string> => {
  const files = new Set<string>()
  for (const match of junit.matchAll(/<testsuite\b[^>]*>/g)) {
    const file = /\bfile="([^"]+)"/.exec(match[0])?.[1]
    const failures = Number(/\bfailures="(\d+)"/.exec(match[0])?.[1] ?? 0)
    if (file !== undefined && failures > 0) files.add(file.startsWith("/") || file.startsWith("./") ? file : `./${file}`)
  }
  return [...files].sort()
}

/** One `bun test` run of `files`: its exit, its output, and the files bun reported failing. */
export type TestRun = (files: ReadonlyArray<string>) => Promise<{ readonly code: number; readonly log: string; readonly failed: ReadonlyArray<string> }>

/**
 * The acceptance check: waits for a calm host, runs `files`, and reruns only the files that failed,
 * once, after another wait. A file that passes on its rerun is a flake, named in the log and not
 * held against the merge; a file red twice, or a run red with no file to blame (a crash, a load
 * error), makes the check red. Assertions stay as written: the rerun is the same test.
 */
export const acceptance = async (files: ReadonlyArray<string>, run: TestRun, host: Host, log: (line: string) => void): Promise<CheckResult> => {
  const check = "acceptance tests"
  await awaitCalm(host, log)
  const first = await run(files)
  if (first.code === 0) return { ok: true }
  if (first.failed.length === 0) return { ok: false, check, log: first.log }
  log(`upstream: ${first.failed.length} acceptance files red (${first.failed.join(", ")}); rerunning them once`)
  await awaitCalm(host, log)
  const second = await run(first.failed)
  if (second.code === 0) {
    log(`upstream: flaky, green on the rerun: ${first.failed.join(", ")}`)
    return { ok: true }
  }
  const twice = second.failed.length === 0 ? first.failed : second.failed
  return { ok: false, check: `${check} (red twice: ${twice.join(", ")})`, log: second.log }
}

/**
 * The real checks, each niced: the merged lockfile installs as committed, packages/tui, core and
 * plugin typecheck, and the exposed acceptance tests pass with `OPENCODE_DEV` at the merge,
 * without the caller's Anthropic routing (`acceptance`: on a calm host, a failed file rerun once).
 * `gent` is gent's checkout as the caller's `GENT_SOURCE` names it; empty assumes no path.
 */
export const forkChecks =
  (opencode: string, fork: string, gent: string, host: Host = realHost, log: (line: string) => void = console.log): Checks =>
  async (dir) => {
    const env: Record<string, string | undefined> = { ...process.env, OPENCODE_DEV: dir, GENT_SOURCE: gent }
    if (!gent) delete env.GENT_SOURCE
    delete env.ANTHROPIC_BASE_URL
    const spawn = async (cwd: string, command: ReadonlyArray<string>, extra: Record<string, string> = {}) => {
      const child = Bun.spawn(["nice", "-n", "10", ...command], { cwd, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" })
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { code, log: tail(`${out}\n${err}`) }
    }
    const steps: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
      ["bun install --frozen-lockfile", dir, ["bun", "install", "--frozen-lockfile"]],
      ...["tui", "core", "plugin"].map((name) => [`typecheck packages/${name}`, join(dir, "packages", name), ["bun", "run", "typecheck"]] as const),
    ]
    for (const [check, cwd, command] of steps) {
      const ran = await spawn(cwd, command)
      if (ran.code !== 0) return { ok: false, check, log: ran.log }
    }
    const report = join(mkdtempSync(join(tmpdir(), "upstream-accept-")), "junit.xml")
    const run: TestRun = async (files) => {
      rmSync(report, { force: true })
      const ran = await spawn(opencode, ["bun", "test", "--timeout", "300000", "--reporter=junit", `--reporter-outfile=${report}`, ...files])
      return { ...ran, failed: existsSync(report) ? failedFiles(readFileSync(report, "utf8")) : [] }
    }
    // The TUI plugins resolve `solid-js` through the links scripts/link-fork.ts makes. Linked to the
    // fork while the TUI under test is the merge's, the plugins hold a second Solid whose signals the
    // merge's renderer never tracks: rows never take a worker's thought, the goal line never shows
    // (2026-11-09, red at load 4 and green once linked to the merge). So the tests run linked to the
    // merge, and the links go back to the fork whatever the result.
    const link = (target: string) => spawn(opencode, [process.execPath, join(opencode, "scripts/link-fork.ts")], { OPENCODE_DEV: target })
    const linked = await link(dir)
    if (linked.code !== 0) {
      await link(fork)
      return { ok: false, check: "link the mods to the merge", log: linked.log }
    }
    try {
      return await acceptance(exposedTests(opencode), run, host, log)
    } finally {
      const back = await link(fork)
      if (back.code !== 0) log(`upstream: relinking the mods to ${fork} failed; run \`bun run link-fork\`: ${back.log}`)
      rmSync(dirname(report), { recursive: true, force: true })
    }
  }
