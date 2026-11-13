// The dotfiles' post-land step (`rift.postLand`): after every pushed land, run the owed acceptance
// files (the deep run, `accept.ts --owed`), then merge upstream OpenCode into the fork and report the
// fork-update work that calls for.
//
// The rift plugin says how loaded the host is in RIFT_POST_LAND_LOAD (`loadOf`, `deepOf`): `loaded`
// runs the deep run two wide, niced by the launcher, without the files that bound a time, and no
// merge; `settled` (also when absent: a run by hand does everything) and `forced` run it with them,
// then the merge, unless the deep run is red: a red deep run holds the merge (the fix comes first, and
// a new fork head would make every file due again). A merge that moved prime-look runs the deep run
// again on the new head. The report opens with the deep block (`deepBlock`).
//
// On the Mac that owns the fork (`FORK_OWNER`) it fast-forwards prime-look to origin (`syncFork`),
// merges upstream/dev into it with `mergeUpstream` (the same merge, checks and report as
// `bun run daily`'s step 0, under the same lock), refreshes `upstream.json` for the TUI's corner,
// and writes one outcome line with the fork work (scripts/fork-work.ts) to `RIFT_POST_LAND_REPORT`
// (stdout without it): the report the land's session is woken with. On any other host (the
// workbox) it runs the deep run, merges nothing and says so. Under a land it holds the land's locks (mods/rift/process/flock.ts): the checks lock for each change to prime-look, which the land's gate and accept read, and the accept lock for the fork's tests, so they never run beside an accept check.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, hostname, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Array as Arr, Effect, Option } from "effect"
import { decodeDeepReport, type DeepReport } from "./accept-ledger.ts"
import { upstreamFile } from "../mods/prime/update.ts"
import { exclusively, exclusivelySync } from "../mods/rift/process/flock.ts"
import { readyFork } from "./fork.ts"
import { type ForkWork, droppable, forkWork, forkWorkText, ghLookup, readAgents } from "./fork-work.ts"
import { DEFAULT_FORK } from "../testbeds/gamut/gamut.ts"
import { BRANCH, forkChecks, mergeUpstream, type Outcome, ownsFork, syncFork, UPSTREAM_BRANCH, UPSTREAM_REMOTE, upstreamReading, withUpstreamLock } from "./upstream.ts"

/** What the step reaches, so a test runs it with no fork, no network and no push. */
export interface Steps {
  readonly host: string
  /** prime-look's commit now. */
  readonly head: () => string
  /** Fast-forwards prime-look to origin's, under the land's checks lock when a land runs the step. */
  readonly sync: () => void| Promise<void>
  /** The merge, under the lock daily's step 0 takes too; none while daily holds it. */
  readonly merge: () => Promise<Outcome | undefined>
  /** Writes `upstream.json` again; answers its line. */
  readonly refresh: () => string
  /** The fork work after a merge tried from `before`; `full` adds the candidates and the lookups. */
  readonly work: (before: string, full: boolean) => Promise<ForkWork>
  /** The merge's report (conflict, red check). */
  readonly report: string
  /** The deep run (`bun run accept:owed`): its outcome, none when it wrote none, and its log. Never under the land's accept lock. */
  readonly deep: (ask: DeepAsk) => Promise<DeepRun>
  /** The commit of the checkout the step runs in (the post-land Rift at main). */
  readonly checkout: () => string
}

/** What the step asks of a deep run: the files that bound a time too (`--settled`), and how wide. */
export interface DeepAsk {
  readonly settled: boolean
  /** None: as wide as the load leaves room for. */
  readonly width: Option.Option<number>
}

/** A deep run's outcome (`accept.ts --json`), none when it wrote none, and where its output went. */
export interface DeepRun {
  readonly report: Option.Option<DeepReport>
  readonly log: string
}

/** The outcome's one line. */
export const outcomeLine = (outcome: Outcome, report: string): string => {
  switch (outcome.kind) {
    case "skipped":
      return `upstream: skipped (${outcome.reason}).`
    case "fetch-failed":
      return `upstream: fetching ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} failed (${outcome.error}); the next land tries again.`
    case "up-to-date":
      return `upstream: up to date; ${BRANCH} has every commit of ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}.`
    case "would-merge":
      return `upstream: would merge ${outcome.commits} commits.`
    case "merged":
      return outcome.pushed
        ? `upstream: merged ${outcome.commits} commits into ${BRANCH} (${outcome.from.slice(0, 10)} -> ${outcome.merge.slice(0, 10)}) and pushed ${BRANCH}; the next install builds it.`
        : `upstream: merged ${outcome.commits} commits into ${BRANCH} (${outcome.from.slice(0, 10)} -> ${outcome.merge.slice(0, 10)}), but the push to origin failed; push ${BRANCH} from the fork.`
    case "conflict":
      return `upstream: the merge conflicts in ${outcome.files.length} files (${outcome.files.join(", ")}); ${BRANCH} unchanged. Report: ${report}`
    case "red":
      return `upstream: the merge is red: ${outcome.check}; ${BRANCH} unchanged, the merge kept on daily/upstream-merge (${outcome.merge.slice(0, 10)}). Log: ${report}`
    case "stuck":
      return `upstream: the merge is green but did not land (${outcome.reason}); kept on daily/upstream-merge. Report: ${report}`
  }
}

/** The to-do an outcome hands the orchestrator, before the fork work. */
const outcomeWork = (outcome: Outcome, report: string): ReadonlyArray<string> => {
  switch (outcome.kind) {
    case "conflict":
      return [
        `- resolve the conflicts as a fork unit: a Rift of the fork on a branch off ${BRANCH}, \`git merge ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}\`, resolve ${outcome.files.join(", ")} preferring upstream (opencode/AGENTS.md), the fork's checks green; the merge joins the next batch and its verifier. Report: ${report}`,
      ]
    case "red":
    case "stuck":
      return [`- make the merge land as a fork unit: start a fork Rift from daily/upstream-merge (${outcome.merge.slice(0, 10)}), fix it, the merge joins the next batch and its verifier. Report: ${report}`]
    default:
      return []
  }
}

/** The upstream merge and its report, as before this step ran acceptance files. */
const upstream = Effect.fn("PostLand.upstream")(function* (steps: Steps) {
  yield* Effect.promise(async () => steps.sync())
  const before = steps.head()
  const merged = Option.fromUndefinedOr(yield* Effect.promise(steps.merge))
  if (Option.isNone(merged)) return { text: "upstream: skipped; bun run daily is merging upstream now, and the next land runs this again.", moved: false }
  const outcome = merged.value
  const refreshed = steps.refresh()
  const tried = outcome.kind === "merged" || outcome.kind === "conflict" || outcome.kind === "red" || outcome.kind === "stuck"
  const work = yield* Effect.promise(() => steps.work(before, tried))
  const todo = [...outcomeWork(outcome, steps.report), ...forkWorkText(work)]
  const workLines = Arr.match(todo, { onEmpty: () => ["fork work: none."], onNonEmpty: (items) => ["fork work (report only; nothing dropped or asked yet):", ...items] })
  return { text: [outcomeLine(outcome, steps.report), refreshed, ...workLines].join("\n"), moved: steps.head() !== before }
})

/**
 * What `RIFT_POST_LAND_LOAD` allows (absent reads as `settled`, so the step run by hand does everything):
 * `loaded` runs the deep run two wide without the files that bound a time, and no merge; `settled` runs it
 * as wide as the load leaves room for with them, `forced` two wide with them; then, unless the deep run is
 * red, the upstream merge, and a second deep run when the merge moved the fork (every file is due on a new
 * fork head).
 */
export type Load = "loaded" | "settled" | "forced"

/** Reads `RIFT_POST_LAND_LOAD`: absent, or anything but `loaded` and `forced`, is `settled`. */
export const loadOf = (word: string | undefined): Load => {
  if (word === "loaded" || word === "forced") return word
  return "settled"
}

/** The deep run a load word asks for: with or without `--settled`, and how wide (none: as the load leaves room). */
export const deepOf = (load: Load): DeepAsk => ({ settled: load !== "loaded", width: Option.liftPredicate(2, () => load !== "settled") })

/** Whether a deep run ran any file. */
const ranAny = (report: DeepReport) => report.files.some((file) => file.status === "passed" || file.status === "failed")

const failedOf = (report: DeepReport) => report.files.filter((file) => file.status === "failed")

/** The commit a deep report names: 12 hex. */
const short = (head: string) => head.slice(0, 12)

/**
 * The deep block, the report's first lines: red (every failed file with its log) or green, then each file
 * that passed only on its second run and each file still owed, with why. The passed files are a count.
 */
export const deepBlock = (report: DeepReport): ReadonlyArray<string> => {
  const failed = failedOf(report)
  const passed = report.files.filter((file) => file.status === "passed")
  const owed = report.files.filter((file) => file.status === "owed")
  const load = report.load.start.toFixed(1)
  const head = Arr.match(failed, {
    onEmpty: () => [`accept deep: green at ${short(report.head)} on ${report.host}: ${passed.length} passed, 0 failed, ${owed.length} still owed, load ${load}.`],
    onNonEmpty: (red) => [
      `accept deep: RED at ${short(report.head)} (${red.length} failed) on ${report.host}, load ${load}. Hosts may already have installed this head: the install target does not wait for the deep run. Start a fix unit before other work.`,
      ...red.map((file) => `  failed: ${file.file} (${file.log})`),
    ],
  })
  return [
    ...head,
    ...passed.filter((file) => file.second).map((file) => `  ${file.why}: ${file.file}`),
    ...owed.map((file) => `  still owed: ${file.file} (${file.why})`),
  ]
}

/** The block of a deep run that wrote no outcome: red, since nothing says it passed. */
const missingBlock = (head: string, host: string, log: string) => [
  `accept deep: RED at ${short(head)} (the deep run wrote no outcome) on ${host}. Hosts may already have installed this head: the install target does not wait for the deep run. Start a fix unit before other work.`,
  `  log: ${log}`,
]

/** Runs the step at `load`; answers the report (empty for a `loaded` run that ran no file). */
export const postLand = (steps: Steps, load: Load = "settled"): Promise<string> => Effect.runPromise(step(steps, load))

const step = Effect.fn("PostLand.step")(function* (steps: Steps, load: Load) {
  const deep = yield* Effect.promise(() => steps.deep(deepOf(load)))
  const block = Option.match(deep.report, { onNone: () => missingBlock(steps.checkout(), steps.host, deep.log), onSome: deepBlock })
  const red = Option.match(deep.report, { onNone: () => true, onSome: (report) => failedOf(report).length > 0 })
  if (load === "loaded") {
    if (!red && !Option.exists(deep.report, ranAny)) return ""
    return [...block, "upstream: waits for a settled host"].join("\n")
  }
  if (!ownsFork(steps.host)) return [...block, `post-land: nothing to do on ${steps.host}; the fork's owner merges upstream.`].join("\n")
  if (red)
    return [
      ...block,
      `upstream: held; the deep run is red at ${short(Option.match(deep.report, { onNone: steps.checkout, onSome: (report) => report.head }))}, and a merge would make every file due again. The next land tries again.`,
    ].join("\n")
  const merged = yield* upstream(steps)
  if (!merged.moved) return [...block, merged.text].join("\n")
  const again = yield* Effect.promise(() => steps.deep(deepOf(load)))
  const after = Option.match(again.report, { onNone: () => missingBlock(steps.checkout(), steps.host, again.log), onSome: deepBlock })
  return [...block, merged.text, `accept deep after the merge, on the fork's new head ${short(steps.head())}:`, ...after].join("\n")
})

if (import.meta.main) {
  const home = homedir()
  const opencode = resolve(import.meta.dir, "..")
  const env = process.env
  const checked = readyFork(env.OPENCODE_DEV || DEFAULT_FORK)
  if ("problem" in checked) throw new Error(checked.problem)
  const fork = checked.fork
  const state = join(home, ".local/state/opencode-daily")
  const report = join(state, "upstream-conflict.md")
  /** A command run to its end, its output piped. */
  const run = (argv: ReadonlyArray<string>) => Bun.spawnSync([...argv], { cwd: opencode, stdout: "pipe", stderr: "pipe" })
  const git = (...args: ReadonlyArray<string>) => run(["git", "-C", fork, ...args]).stdout.toString().trim()
  const agents = readAgents(join(opencode, "AGENTS.md"))
  const checksLock = exclusivelySync(env.RIFT_LAND_CHECKS_LOCK || "")
  const acceptLock = exclusively(env.RIFT_LAND_ACCEPT_LOCK || "")
  const log = console.log
  const checkout = () => run(["git", "rev-parse", "HEAD"]).stdout.toString().trim()
  const text = await postLand({
    // The deep run takes the machine's accept lock itself and yields it to a land's run; it never holds the
    // land's accept flock (RIFT_LAND_ACCEPT_LOCK), which a land's check takes before its own run starts.
    deep: async (ask) => {
      const out = join(tmpdir(), `post-land-deep-${process.pid}.json`)
      rmSync(out, { force: true })
      const settled = Arr.filter(["--settled"], () => ask.settled)
      const width = Option.toArray(Option.map(ask.width, (each) => `--parallel=${each}`))
      // Its output goes into the step's own log.
      Bun.spawnSync([process.execPath, "scripts/accept.ts", "--owed", ...settled, ...width, "--json", out], { cwd: opencode, stdout: "inherit", stderr: "inherit" })
      const read = Option.flatMap(Option.liftPredicate(out, existsSync), (file) => decodeDeepReport(readFileSync(file, "utf8")))
      rmSync(out, { force: true })
      return { report: read, log: join(env.ACCEPT_LOGS || join(home, ".cache/opencode-accept/logs"), checkout().slice(0, 12)) }
    },
    checkout,
    host: hostname(),
    head: () => git("rev-parse", `refs/heads/${BRANCH}`),
    sync: () => checksLock(() => void syncFork({ fork, dryRun: false, log })),
    merge: () =>
      withUpstreamLock(state, () =>
        mergeUpstream({
          fork,
          host: hostname(),
          skip: false,
          dryRun: false,
          checks: (dir) => acceptLock(() => forkChecks(opencode, fork)(dir)),
          landing: checksLock,
          worktree: join(state, "upstream-merge"),
          report,
          log,
        }),
      ),
    refresh: () => {
      const file = upstreamFile(home, env.XDG_STATE_HOME)
      const reading = upstreamReading(fork, report, false)
      if (reading === undefined) {
        rmSync(file, { force: true })
        return "upstream.json: removed (no upstream/dev to count against)."
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(reading, null, 2)}\n`, { mode: 0o600 })
      return `upstream.json: ${reading.commits} commits past the fork's checkout${reading.blocked ? ", merge blocked" : ""}.`
    },
    work: async (before, full) => {
      const upstream = `refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`
      const input = { fork, branch: `refs/heads/${BRANCH}`, upstream, before, agents, lookup: ghLookup() }
      return full ? forkWork(input) : { candidates: [], closed: [], unread: 0, droppable: droppable(input) }
    },
    report,
  }, loadOf(env.RIFT_POST_LAND_LOAD))
  const out = env.RIFT_POST_LAND_REPORT
  if (out === undefined || out === "") log(text)
  // A loaded run that ran no file writes an empty report, and wakes no one.
  else writeFileSync(out, Arr.filter([`${text}\n`], () => text !== "").join(""))
}
