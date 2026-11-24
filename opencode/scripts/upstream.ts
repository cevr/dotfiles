// `bun run daily`'s first step on the Mac: merges upstream OpenCode (`upstream/dev`) into the fork's
// `prime-look` before the build.
//
// The merge happens in a worktree of the fork of its own (detached, kept between runs so its
// node_modules stay warm), never in the checkout `OPENCODE_DEV` builds, and starts from origin's
// prime-look. A conflict is aborted; a clean merge must pass the fork's `bun run check` (lint and
// typecheck, what its pre-push hook runs), the fork's feature checks (scripts/fork-checks.ts: the tests
// of each fork feature, scripts/fork-checks.json) and the dotfiles acceptance tests most exposed to host
// changes, run against the merged worktree with the mods linked to it, on a calm host, a failed file
// rerun once (`acceptance`). Only then does the merge go to origin, and only once origin holds it does
// `prime-look` fast-forward to it; when origin moved meanwhile, the merge starts over from its head. A
// conflict, a red check or a push that fails leaves `prime-look` where it was and writes the report an
// agent resolves it from; the install goes on with the fork as it is, so the merge never blocks it.
//
// Only the fork's owner runs it (the Mac, `FORK_OWNER`); the workbox pulls origin prime-look.
// Before it, on every host, `syncFork` fast-forwards prime-look to origin/prime-look, so the merge
// never starts from a branch origin has moved past.
import { dlopen, FFIType } from "bun:ffi"
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { loadavg, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import type { UpstreamReading } from "../mods/prime/update.ts"
import { decodeGitPaths, nulFields } from "./git-paths.ts"

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
  | { readonly kind: "merged"; readonly from: string; readonly merge: string; readonly commits: number }

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
  /** The install after the fast-forward, when the lockfile moved; `bunInstall` when absent. */
  readonly install?: Install
}

/** An environment for the git children: names to values, unset where undefined. */
export type GitEnv = Readonly<NodeJS.ProcessEnv>

/** The branch a merge that could not land is kept on, so an agent can start from it. */
export const HELD_BRANCH = "daily/upstream-merge"

const decoder = new TextDecoder()
const gitOutput = (args: ReadonlyArray<string>, bytes: Uint8Array) => {
  if (args.includes("-z")) return decodeGitPaths(bytes)
  return decoder.decode(bytes).trim()
}

/** git run with `env` (plus no prompts and no merge editor) for every child: the process's env unless a caller hands its own. */
const runner = (env: GitEnv = process.env) => {
  const git = (dir: string, ...args: ReadonlyArray<string>) => {
    const ran = Bun.spawnSync(["git", "-C", dir, ...args], {
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
      stdout: "pipe",
      stderr: "pipe",
    })
    return { ok: ran.exitCode === 0, out: gitOutput(args, ran.stdout), err: decoder.decode(ran.stderr).trim() }
  }
  const must = (dir: string, ...args: ReadonlyArray<string>) => {
    const ran = git(dir, ...args)
    if (!ran.ok) throw new Error(`git ${args.join(" ")} in ${dir}: ${ran.err || ran.out}`)
    return ran.out
  }
  return { git, must, env }
}
type Runner = ReturnType<typeof runner>

/** Installs the checkout `dir`'s lockfile as committed: whether it did, and the error's last line. */
export type Install = (dir: string, env: GitEnv) => { readonly ok: boolean; readonly err: string }

/** `bun install --frozen-lockfile` in `dir`. */
export const bunInstall: Install = (dir, env) => {
  const installed = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: dir, env: { ...env }, stdout: "pipe", stderr: "pipe" })
  return { ok: installed.exitCode === 0, err: installed.stderr.toString().trim().split("\n").slice(-1).join("") }
}

/** The install a caller hands, else `bunInstall`. */
const installOf = (options: { readonly install?: Install }): Install => {
  if (options.install) return options.install
  return bunInstall
}

/**
 * After the checkout `holder` moved from `from` to `to`, installs the new lockfile when it differs:
 * a checkout whose packages are the old commit's runs the new source against them (2026-11-20:
 * prime-look moved off a merge that installed psychoscript 0.2.1 to a commit pinning 0.1.2, with
 * no install; Code Mode's `execute` hung and tests/image.test.ts went red). scripts/fork.ts
 * `staleInstall` refuses such a fork to every script that takes it.
 */
const installMoved = ({ git, env }: Runner, install: Install, holder: string, from: string, to: string, log: (line: string) => void) => {
  if (!existsSync(join(holder, "bun.lock")) || git(holder, "diff", "--quiet", from, to, "--", "bun.lock").ok) return
  const installed = install(holder, env)
  if (!installed.ok) log(`upstream: bun install --frozen-lockfile in ${holder} failed after its move to ${to.slice(0, 10)}: ${installed.err}`)
}

/**
 * Pushes the commit `merge` to origin's `BRANCH` by origin's fetch URL, never forced, so origin refuses it once
 * it has moved past where the merge started, and moves `origin/<BRANCH>` to `merge` as a push by the remote's
 * name would. By the URL, not the name: an adopted copy (the fork, prime-look) has the push URL work gives every
 * workspace, which refuses each push (`no-push:workspaces-never-push-origin`); the land pushes the same way
 * (mods/work/process/landing.ts `pushToOrigin`). With `--no-verify`: the fork's pre-push hook runs `bun run
 * check` (lint and typecheck, which `forkChecks` already ran on this merge) and a check of the pusher's Bun
 * version, which says nothing of the merge.
 */
const pushOrigin = ({ git }: Runner, fork: string, merge: string) => {
  const origin = git(fork, "remote", "get-url", "origin")
  if (!origin.ok) return origin
  const pushed = git(fork, "push", "--no-verify", origin.out, `${merge}:refs/heads/${BRANCH}`)
  if (pushed.ok) git(fork, "update-ref", `refs/remotes/origin/${BRANCH}`, merge)
  return pushed
}

/** Fetches origin's `BRANCH` into `origin/<BRANCH>`, forced as a fetch by the remote's name is. */
const fetchOrigin = ({ git }: Runner, fork: string) => git(fork, "fetch", "--quiet", "origin", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`)

/** The lines of git's stderr that say why a push failed: its hints and its `To <url>` line left out. */
const pushCause = (err: string) =>
  err
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("hint:") && !line.startsWith("To "))
    .join(" · ")

/** The worktree that has `refs/heads/<branch>` checked out, if any. */
const checkedOut = ({ must }: Runner, fork: string, branch: string): string | undefined => {
  let path: string | undefined
  for (const line of nulFields(must(fork, "worktree", "list", "--porcelain", "-z"))) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length)
    if (line === `branch refs/heads/${branch}`) return path
  }
  return undefined
}

/** A worktree of the fork detached at `base`: the one from the last run when it is still there. */
const prepareWorktree = ({ git, must }: Runner, fork: string, dir: string, base: string) => {
  const registered = nulFields(must(fork, "worktree", "list", "--porcelain", "-z")).includes(`worktree ${dir}`)
  if (registered && existsSync(join(dir, ".git"))) {
    git(dir, "merge", "--abort")
    must(dir, "checkout", "--detach", "--force", base)
    return
  }
  // A directory left without its registration (or the reverse) is ours: start it over. Never the
  // fork itself or a directory holding it.
  if (fork === dir || fork.startsWith(`${dir}/`)) throw new Error(`the merge worktree ${dir} holds the fork ${fork}`)
  rmSync(dir, { recursive: true, force: true })
  must(fork, "worktree", "prune")
  mkdirSync(dirname(dir), { recursive: true })
  must(fork, "worktree", "add", "--detach", dir, base)
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
  `- origin ${BRANCH}: ${base} (where the merge started; the fork checkout unchanged, the install built it as it was)`,
  `- ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}: ${upstream}`,
  "",
]

/** `Options.landing` with no lock: the step runs as is. */
export const unlocked = <A>(step: () => A): A => step()

/** How many merges the step starts, each from origin's head, while origin keeps moving under them. */
export const ATTEMPTS = 3

/** One try's answer: an outcome, or `moved` when origin moved past where the merge started and refused it. */
type Try = Outcome | { readonly kind: "moved"; readonly from: string; readonly to: string; readonly merge: string }

/** Where one try's merge stands: its upstream, origin's head it started from, and prime-look's commit then. */
interface Start {
  readonly upstream: string
  readonly base: string
  readonly local: string
}

/** Keeps `merge` on `HELD_BRANCH` and writes the report that says why it did not land. */
const holdMerge = (options: Options, run: Runner, start: Start, merge: string, title: string, detail: ReadonlyArray<string>) => {
  run.must(options.fork, "branch", "--force", HELD_BRANCH, merge)
  writeReport(options, [...reportHeader(options, title, start.upstream, start.base), `The merge is kept on branch \`${HELD_BRANCH}\` (${merge}).`, "", ...detail])
}

/** Aborts a merge that conflicts, puts the worktree back at the base and reports the files. */
const reportConflict = (options: Options, run: Runner, start: Start, said: string): Outcome => {
  const { git, must } = run
  const files = nulFields(must(options.worktree, "diff", "--name-only", "-z", "--diff-filter=U"))
  git(options.worktree, "merge", "--abort")
  must(options.worktree, "checkout", "--detach", "--force", start.base)
  options.log(`upstream: the merge conflicts in ${files.length} files; ${BRANCH} unchanged`)
  for (const file of files) options.log(`  ${file}`)
  writeReport(options, [
    ...reportHeader(options, `Upstream merge conflicts in ${files.length} files`, start.upstream, start.base),
    "## Conflicting files",
    "",
    ...(files.length === 0 ? [`(none listed; git said: ${said})`] : files.map((file) => `- ${file}`)),
    "",
    "## To resolve",
    "",
    `In a checkout of ${BRANCH} (not the one a build is using): \`git fetch ${UPSTREAM_REMOTE} && git merge ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}\`, resolve, run the checks, push origin ${BRANCH}. The next \`bun run daily\` then finds ${BRANCH} current.`,
    "",
    "Prefer upstream (opencode/AGENTS.md): where upstream now does what a fork change does, take upstream's and drop ours, keeping only a difference the owner relies on; tell the owner what changes for them before dropping ours, and list each dropped or slimmed fork change in the hand-back.",
  ])
  return { kind: "conflict", files, upstream: start.upstream }
}

/**
 * Lands a green merge: origin first, then prime-look, so the checkout only ever moves to a commit origin
 * holds. A push origin refused because it moved past the base answers `moved`; any other failed push is
 * reported once with its cause, prime-look unchanged.
 */
const landMerge = (options: Options, run: Runner, start: Start, merge: string, commits: number): Try => {
  const { fork, log } = options
  const { git, must } = run
  const pushed = pushOrigin(run, fork, merge)
  if (!pushed.ok) {
    const now = fetchOrigin(run, fork).ok ? must(fork, "rev-parse", `refs/remotes/origin/${BRANCH}`) : start.base
    if (now !== start.base) return { kind: "moved", from: start.base, to: now, merge }
    const reason = `the push to origin failed: ${pushCause(pushed.err || pushed.out)}`
    log(`upstream: the merge is green but did not land: ${reason}; ${BRANCH} unchanged`)
    holdMerge(options, run, start, merge, "Upstream merge is green but its push to origin failed", ["## Why", "", "```", pushed.err || pushed.out, "```"])
    return { kind: "stuck", reason, merge, upstream: start.upstream }
  }
  // Fast-forward prime-look where it is checked out (the working tree follows), else the ref alone,
  // compared against where it was so a branch that moved meanwhile is never overwritten.
  const holder = checkedOut(run, fork, BRANCH)
  const moved = options.landing(() => {
    const forwarded = holder === undefined ? git(fork, "update-ref", `refs/heads/${BRANCH}`, merge, start.local) : git(holder, "merge", "--ff-only", merge)
    // The checkout's packages follow its new lockfile: the dotfiles tests run against the checkout load them.
    if (forwarded.ok && holder !== undefined) installMoved(run, installOf(options), holder, start.local, merge, log)
    return forwarded
  })
  if (!moved.ok) {
    const reason = `origin has the merge, but ${BRANCH} could not fast-forward to it${holder === undefined ? "" : ` in ${holder}`}: ${moved.err || moved.out}`
    log(`upstream: the merge is green but ${reason}`)
    holdMerge(options, run, start, merge, "Upstream merge is on origin but the fork checkout did not follow", ["## Why", "", reason])
    return { kind: "stuck", reason, merge, upstream: start.upstream }
  }
  rmSync(options.report, { force: true })
  log(`upstream: ${BRANCH} ${start.base.slice(0, 10)} -> ${merge.slice(0, 10)}, pushed to origin`)
  return { kind: "merged", from: start.base, merge, commits }
}

/** Where a try starts, or why it does not: origin's head, unless prime-look has commits origin lacks. */
const startOf = (options: Options, run: Runner, upstream: string): Start | Outcome => {
  const { fork, log } = options
  const { must } = run
  const fetched = fetchOrigin(run, fork)
  if (!fetched.ok) {
    log(`upstream: fetching origin ${BRANCH} failed, building the fork as it is: ${fetched.err}`)
    return { kind: "fetch-failed", error: fetched.err }
  }
  // The merge starts from origin's head, so what it pushes is a fast-forward of origin. A prime-look with
  // commits origin lacks is left alone: the merge would publish them, or the checkout could not follow it.
  const base = must(fork, "rev-parse", `refs/remotes/origin/${BRANCH}`)
  const local = must(fork, "rev-parse", `refs/heads/${BRANCH}`)
  const unpublished = Number(must(fork, "rev-list", "--count", `${base}..${local}`))
  if (unpublished === 0) return { upstream, base, local }
  const reason = `${BRANCH} has ${plural(unpublished, "commit")} not on origin; push or drop them, and the next run merges`
  log(`upstream: skipped: ${reason}`)
  return { kind: "skipped", reason }
}

/** A clean merge in the worktree, not yet checked: where it started, its commit, and the upstream commits it brings. */
interface Made {
  readonly start: Start
  readonly merge: string
  readonly commits: number
}

/** One try's merge: upstream into origin's head in the worktree, or the outcome that ends the step before any check. */
const makeMerge = (options: Options, run: Runner, upstream: string): Made | Outcome => {
  const { log } = options
  const { git, must } = run
  const start = startOf(options, run, upstream)
  if ("kind" in start) return start
  const commits = Number(must(options.fork, "rev-list", "--count", `${start.base}..${upstream}`))
  if (commits === 0) {
    log(`upstream: ${BRANCH} has every commit of ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`)
    if (!options.dryRun) rmSync(options.report, { force: true })
    return { kind: "up-to-date" }
  }
  if (options.dryRun) {
    log(`upstream: would merge ${commits} commits of ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} (${upstream.slice(0, 10)}) into ${BRANCH} (${start.base.slice(0, 10)})`)
    return { kind: "would-merge", commits, upstream }
  }
  log(`upstream: merging ${commits} commits of ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} into ${BRANCH} (${start.base.slice(0, 10)}) in ${options.worktree}`)
  prepareWorktree(run, options.fork, options.worktree, start.base)
  const merged = git(options.worktree, "merge", "--no-edit", upstream)
  if (!merged.ok) return reportConflict(options, run, start, merged.err || merged.out)
  return { start, merge: must(options.worktree, "rev-parse", "HEAD"), commits }
}

/** A checked merge: landed when its checks are green, else held and reported. */
const judgeMerge = (options: Options, run: Runner, made: Made, result: CheckResult): Try => {
  if (result.ok) return landMerge(options, run, made.start, made.merge, made.commits)
  options.log(`upstream: the merge is red (${result.check}); ${BRANCH} unchanged`)
  holdMerge(options, run, made.start, made.merge, `Upstream merge is red: ${result.check}`, [
    `Upstream commits it brings: \`git log ${made.start.base.slice(0, 10)}..${made.start.upstream.slice(0, 10)}\` (${plural(made.commits, "commit")}).`,
    "",
    "## Failing check",
    "",
    `\`${result.check}\`, run against the merged worktree ${options.worktree}:`,
    "",
    "```",
    result.log,
    "```",
  ])
  return { kind: "red", check: result.check, merge: made.merge, upstream: made.start.upstream }
}

/**
 * Runs the step; never throws for a merge that cannot land, only for a broken fork checkout. Each try
 * merges upstream into origin's head, checks the merge, pushes it to origin, and only then fast-forwards
 * prime-look; a try origin moved under (the push refused, origin no longer where the merge started)
 * starts over from origin's new head, at most `ATTEMPTS` times.
 */
export const mergeUpstream = async (options: Options): Promise<Outcome> => {
  const { fork, log } = options
  if (options.skip) return { kind: "skipped", reason: "--no-upstream" }
  if (!ownsFork(options.host)) return { kind: "skipped", reason: `${options.host} does not own the fork; it pulls origin ${BRANCH}` }
  const run = runner(options.env)
  const fetched = run.git(fork, "fetch", "--quiet", UPSTREAM_REMOTE, UPSTREAM_BRANCH)
  if (!fetched.ok) {
    log(`upstream: fetch failed, building the fork as it is: ${fetched.err}`)
    return { kind: "fetch-failed", error: fetched.err }
  }
  const upstream = run.must(fork, "rev-parse", `refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`)
  for (let attempt = 1; ; attempt++) {
    const made = makeMerge(options, run, upstream)
    if ("kind" in made) return made
    const tried = judgeMerge(options, run, made, await options.checks(options.worktree))
    if (tried.kind !== "moved") return tried
    const moved = `${tried.from.slice(0, 10)} -> ${tried.to.slice(0, 10)}`
    if (attempt < ATTEMPTS) {
      log(`upstream: origin ${BRANCH} moved ${moved} during the merge; starting over from it`)
      continue
    }
    const reason = `origin ${BRANCH} moved during each of ${ATTEMPTS} merges, last ${moved}`
    log(`upstream: the merge is green but did not land: ${reason}; ${BRANCH} unchanged`)
    holdMerge(options, run, { upstream, base: tried.from, local: tried.from }, tried.merge, "Upstream merge is green but origin kept moving", ["## Why", "", `${reason}. The next run merges again from origin's head.`])
    return { kind: "stuck", reason, merge: tried.merge, upstream }
  }
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
export const upstreamLockFile = (state: string) => join(state, "upstream.lock")

export const withOpenedUpstreamLock = async <A>(open: () => number, merge: () => Promise<A>): Promise<A | undefined> => {
  // Opened without truncating: what it says is only rewritten by the holder.
  const fd = open()
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

export const withUpstreamLock = <A>(state: string, merge: () => Promise<A>) =>
  withOpenedUpstreamLock(() => {
    mkdirSync(state, { recursive: true })
    return openSync(upstreamLockFile(state), "a+")
  }, merge)

/**
 * Upstream OpenCode against the build at the fork's HEAD, for the TUI's corner
 * (mods/prime/update.ts): the commits of `upstream/dev` the build lacks, and
 * whether the last merge is blocked (its `report` is there: a conflict, a red
 * check or a merge that could not land; `mergeUpstream` removes it once the
 * fork is current). With `fetch` (a host that does not own the fork, so the
 * merge step fetched nothing) it fetches upstream first, once, if the fork has
 * the remote. None when the fork has no `upstream/dev` to count against.
 */
export const upstreamReadingFrom = (
  fork: string, report: string, fetch: boolean, now: Date,
  { git, must, exists }: Pick<Runner, "git" | "must"> & { readonly exists: (file: string) => boolean },
): UpstreamReading | undefined => {
  if (fetch && git(fork, "remote", "get-url", UPSTREAM_REMOTE).ok) git(fork, "fetch", "--quiet", UPSTREAM_REMOTE, UPSTREAM_BRANCH)
  const upstream = git(fork, "rev-parse", "--verify", "--quiet", `refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`)
  if (!upstream.ok) return undefined
  const build = must(fork, "rev-parse", "HEAD")
  const commits = Number(must(fork, "rev-list", "--count", `${build}..${upstream.out}`))
  return { commits, blocked: exists(report), upstream: upstream.out, build, at: now.toISOString() }
}

export const upstreamReading = (fork: string, report: string, fetch: boolean, now: Date = new Date(), env?: GitEnv) =>
  upstreamReadingFrom(fork, report, fetch, now, { ...runner(env), exists: existsSync })

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
 * the update's verified fork commit), it goes no further than that commit. A checkout it moves to a
 * commit whose bun.lock differs gets that lockfile installed (`installMoved`), so post-land's sync
 * leaves no checkout running new source on old packages.
 */
export const syncFork = (options: {
  readonly fork: string
  readonly dryRun: boolean
  readonly to?: string
  readonly log: (line: string) => void
  readonly env?: GitEnv
  readonly install?: Install
}): SyncOutcome => {
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
  if (holder !== undefined && git(holder, "status", "--porcelain", "-z", "--untracked-files=no").out !== "") return leave(`${holder} has uncommitted changes`)
  if (options.dryRun) {
    log(`fork: would fast-forward ${BRANCH} ${plural(behind, "commit")} to origin (${remote.slice(0, 10)})`)
    return { kind: "would-fast-forward", commits: behind }
  }
  const moved = holder === undefined ? git(fork, "update-ref", `refs/heads/${BRANCH}`, remote, local) : git(holder, "merge", "--ff-only", "--quiet", remote)
  if (!moved.ok) return leave(`the fast-forward failed: ${moved.err || moved.out}`)
  if (holder) installMoved(run, installOf(options), holder, local, remote, log)
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

/** One check's exit and the tail of its output. */
export interface StepRun {
  readonly code: number
  readonly log: string
}
/** One check of a merge, over its worktree. */
export type Step = (dir: string) => Effect.Effect<StepRun>

/** The checks a merge passes, in order; `accept` last, a whole check of its own (it links the mods to the merge and back). */
export interface MergeSteps {
  readonly install: Step
  readonly check: Step
  readonly features: Step
  readonly accept: (dir: string) => Effect.Effect<CheckResult>
}

/**
 * A merge's checks, each in turn, the first red one answering: the merged lockfile installs as committed, the
 * fork's `bun run check` (lint and typecheck of every package, what its pre-push hook runs, so the push may skip
 * the hook, `pushOrigin`), the fork's feature checks (scripts/fork-checks.ts over scripts/fork-checks.json: a red
 * test, a listed file the merge lost, or a run that could not finish holds the merge), then the acceptance tests.
 * `bun run daily` and post-land run it through `forkChecks`; a test hands fakes for the steps that need a real fork.
 */
export const mergeChecks =
  (steps: MergeSteps): Checks =>
  (dir) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const named: ReadonlyArray<readonly [string, Step]> = [
          ["bun install --frozen-lockfile", steps.install],
          ["bun run check", steps.check],
          ["fork feature checks (scripts/fork-checks.ts)", steps.features],
        ]
        for (const [check, step] of named) {
          const ran = yield* step(dir)
          if (ran.code !== 0) return { ok: false, check, log: ran.log } satisfies CheckResult
        }
        return yield* steps.accept(dir)
      }),
    )

/** The env of a check of the merge `dir`: `OPENCODE_DEV` at it, without the caller's Anthropic routing. */
const mergeEnv = (dir: string) => {
  const { ANTHROPIC_BASE_URL: _routing, ...env } = process.env
  return { ...env, OPENCODE_DEV: dir }
}

/** `command` niced in `cwd` with `env`: its exit and the tail of its output. */
const niced = (cwd: string, command: ReadonlyArray<string>, env: NodeJS.ProcessEnv): Promise<StepRun> => {
  const child = Bun.spawn(["nice", "-n", "10", ...command], { cwd, env, stdout: "pipe", stderr: "pipe" })
  return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([out, err, code]) => ({ code, log: tail(`${out}\n${err}`) }))
}

/** The command the fork's feature checks run by: the dotfiles' `opencode` dir, the checkout, and any flags (a test's `--list`). */
export const featureCheckArgv = (opencode: string, fork: string, flags: ReadonlyArray<string> = []): ReadonlyArray<string> => ["bun", join(opencode, "scripts/fork-checks.ts"), "--fork", fork, ...flags]

/**
 * The fork's feature checks over the merge (`bun scripts/fork-checks.ts --fork <merge>`, which bounds its own time and
 * waits), a process of its own so this module, which `bun run daily` loads, imports no platform layer; `flags` for a test's list.
 */
export const featureStep =
  (opencode: string, flags: ReadonlyArray<string> = []): Step =>
  (dir) =>
    Effect.promise(() => niced(opencode, featureCheckArgv(opencode, dir, flags), mergeEnv(dir)))

/**
 * The real checks (`mergeChecks`), each niced, the acceptance tests with `OPENCODE_DEV` at the merge, without the
 * caller's Anthropic routing (`acceptance`: on a calm host, a failed file rerun once).
 */
export const forkChecks = (opencode: string, fork: string, host: Host = realHost, log: (line: string) => void = console.log): Checks =>
  mergeChecks({
    install: (dir) => Effect.promise(() => niced(dir, ["bun", "install", "--frozen-lockfile"], mergeEnv(dir))),
    check: (dir) => Effect.promise(() => niced(dir, ["bun", "run", "check"], mergeEnv(dir))),
    features: featureStep(opencode),
    accept: (dir) => Effect.promise(() => linkedAcceptance(opencode, fork, host, log)(dir)),
  })

/** The exposed acceptance tests run linked to the merge, the links put back to the fork whatever the result. */
const linkedAcceptance =
  (opencode: string, fork: string, host: Host, log: (line: string) => void): Checks =>
  async (dir) => {
    const spawn = (cwd: string, command: ReadonlyArray<string>, extra: Readonly<Record<string, string>> = {}) => niced(cwd, command, { ...mergeEnv(dir), ...extra })
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
