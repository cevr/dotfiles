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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  /** The merge worktree's directory. */
  readonly worktree: string
  /** The report a conflict or a red check writes, removed once the fork is current again. */
  readonly report: string
  readonly log: (line: string) => void
}

/** The branch a merge that could not land is kept on, so an agent can start from it. */
export const HELD_BRANCH = "daily/upstream-merge"

const decoder = new TextDecoder()
const git = (dir: string, ...args: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
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

/** The worktree that has `refs/heads/<branch>` checked out, if any. */
const checkedOut = (fork: string, branch: string): string | undefined => {
  let path: string | undefined
  for (const line of must(fork, "worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length)
    if (line === `branch refs/heads/${branch}`) return path
  }
  return undefined
}

/** A detached worktree of the fork at `BRANCH`: the one from the last run when it is still there. */
const prepareWorktree = (fork: string, dir: string) => {
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

/** Runs the step; never throws for a merge that cannot land, only for a broken fork checkout. */
export const mergeUpstream = async (options: Options): Promise<Outcome> => {
  const { fork, log } = options
  if (options.skip) return { kind: "skipped", reason: "--no-upstream" }
  if (!ownsFork(options.host)) return { kind: "skipped", reason: `${options.host} does not own the fork; it pulls origin ${BRANCH}` }

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
  prepareWorktree(fork, options.worktree)
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
  const holder = checkedOut(fork, BRANCH)
  const moved = holder === undefined ? git(fork, "update-ref", `refs/heads/${BRANCH}`, merge, base) : git(holder, "merge", "--ff-only", merge)
  if (!moved.ok) {
    const reason = `could not fast-forward ${BRANCH}${holder === undefined ? "" : ` in ${holder}`}: ${moved.err || moved.out}`
    log(`upstream: the merge is green but ${reason}`)
    hold("Upstream merge is green but did not land", ["## Why", "", reason])
    return { kind: "stuck", reason, merge, upstream }
  }
  rmSync(options.report, { force: true })
  // The push runs the fork's pre-push check (lint, typecheck) in the checkout, whose packages are
  // still the old merge's: install the merged lockfile first, or a package upstream changed fails it.
  if (holder !== undefined && existsSync(join(holder, "bun.lock"))) {
    const installed = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: holder, stdout: "pipe", stderr: "pipe" })
    if (installed.exitCode !== 0) log(`upstream: bun install in ${holder} failed before the push: ${installed.stderr.toString().trim().split("\n").at(-1)}`)
  }
  const pushed = git(fork, "push", "--quiet", "origin", BRANCH)
  log(
    pushed.ok
      ? `upstream: ${BRANCH} ${base.slice(0, 10)} -> ${merge.slice(0, 10)}, pushed to origin`
      : `upstream: ${BRANCH} ${base.slice(0, 10)} -> ${merge.slice(0, 10)}; push to origin failed: ${pushed.err}`,
  )
  return { kind: "merged", from: base, merge, commits, pushed: pushed.ok }
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
export const upstreamReading = (fork: string, report: string, fetch: boolean, now: Date = new Date()): UpstreamReading | undefined => {
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
 * run goes on with it. Untracked files never stop it.
 */
export const syncFork = (options: { readonly fork: string; readonly dryRun: boolean; readonly log: (line: string) => void }): SyncOutcome => {
  const { fork, log } = options
  const tracking = `refs/remotes/origin/${BRANCH}`
  const fetched = git(fork, "fetch", "--quiet", "origin", `+refs/heads/${BRANCH}:${tracking}`)
  if (!fetched.ok) {
    log(`fork: fetching origin ${BRANCH} failed, building ${BRANCH} as it is: ${fetched.err}`)
    return { kind: "fetch-failed", error: fetched.err }
  }
  const local = must(fork, "rev-parse", `refs/heads/${BRANCH}`)
  const remote = must(fork, "rev-parse", tracking)
  const behind = Number(must(fork, "rev-list", "--count", `${local}..${remote}`))
  if (behind === 0) return { kind: "current" }
  const leave = (reason: string): SyncOutcome => {
    log(`fork: ${BRANCH} is ${plural(behind, "commit")} behind origin but ${reason}; left as it is, building it unchanged`)
    return { kind: "left", reason }
  }
  const ahead = Number(must(fork, "rev-list", "--count", `${remote}..${local}`))
  if (ahead > 0) return leave(`has ${plural(ahead, "commit")} not on origin`)
  const holder = checkedOut(fork, BRANCH)
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
 */
export const forkChecks =
  (opencode: string, fork: string, gent: string, host: Host = realHost, log: (line: string) => void = console.log): Checks =>
  async (dir) => {
    const env: Record<string, string | undefined> = { ...process.env, OPENCODE_DEV: dir, GENT_SOURCE: gent }
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
