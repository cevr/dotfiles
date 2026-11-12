// The dotfiles' post-land step (`rift.postLand`): after every pushed land, merge upstream OpenCode
// into the fork and report the fork-update work that calls for.
//
// On the Mac that owns the fork (`FORK_OWNER`) it fast-forwards prime-look to origin (`syncFork`),
// merges upstream/dev into it with `mergeUpstream` (the same merge, checks and report as
// `bun run daily`'s step 0, under the same lock), refreshes `upstream.json` for the TUI's corner,
// and writes one outcome line with the fork work (scripts/fork-work.ts) to `RIFT_POST_LAND_REPORT`
// (stdout without it): the report the land's session is woken with. On any other host (the
// workbox) it does nothing and says so. Under a land it holds the land's locks (mods/rift/process/flock.ts): the checks lock for each change to prime-look, which the land's gate and accept read, and the accept lock for the fork's tests, so they never run beside an accept check.
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join, resolve } from "node:path"
import { upstreamFile } from "../mods/prime/update.ts"
import { exclusively, exclusivelySync } from "../mods/rift/process/flock.ts"
import { checkFork } from "./fork.ts"
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

/** Runs the step; answers the report. */
export const postLand = async (steps: Steps): Promise<string> => {
  if (!ownsFork(steps.host)) return `post-land: nothing to do on ${steps.host}; the fork's owner merges upstream.`
  steps.sync()
  const before = steps.head()
  const outcome = await steps.merge()
  if (outcome === undefined) return "upstream: skipped; bun run daily is merging upstream now, and the next land runs this again."
  const refreshed = steps.refresh()
  const tried = outcome.kind === "merged" || outcome.kind === "conflict" || outcome.kind === "red" || outcome.kind === "stuck"
  const work = await steps.work(before, tried)
  const todo = [...outcomeWork(outcome, steps.report), ...forkWorkText(work)]
  return [outcomeLine(outcome, steps.report), refreshed, ...(todo.length === 0 ? ["fork work: none."] : ["fork work (report only; nothing dropped or asked yet):", ...todo])].join("\n")
}

if (import.meta.main) {
  const home = homedir()
  const opencode = resolve(import.meta.dir, "..")
  const env = process.env
  const checked = checkFork(env.OPENCODE_DEV || DEFAULT_FORK)
  if ("problem" in checked) throw new Error(checked.problem)
  const fork = checked.fork
  const state = join(home, ".local/state/opencode-daily")
  const report = join(state, "upstream-conflict.md")
  const git = (...args: ReadonlyArray<string>) => Bun.spawnSync(["git", "-C", fork, ...args], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()
  const agents = readAgents(join(opencode, "AGENTS.md"))
  const checksLock = exclusivelySync(env.RIFT_LAND_CHECKS_LOCK || "")
  const acceptLock = exclusively(env.RIFT_LAND_ACCEPT_LOCK || "")
  const text = await postLand({
    host: hostname(),
    head: () => git("rev-parse", `refs/heads/${BRANCH}`),
    sync: () => checksLock(() => void syncFork({ fork, dryRun: false, log: console.log })),
    merge: () =>
      withUpstreamLock(state, () =>
        mergeUpstream({
          fork,
          host: hostname(),
          skip: false,
          dryRun: false,
          checks: (dir) => acceptLock(() => forkChecks(opencode, fork, env.GENT_SOURCE || join(home, "Developer/personal/.rifts/gent/untrack-local-settings"))(dir)),
          landing: checksLock,
          worktree: join(state, "upstream-merge"),
          report,
          log: console.log,
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
  })
  const out = env.RIFT_POST_LAND_REPORT
  if (out === undefined || out === "") console.log(text)
  else writeFileSync(out, `${text}\n`)
}
