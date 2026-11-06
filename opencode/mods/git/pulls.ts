// The `pr` tool's handlers and the per-machine watcher. A tool call reads
// GitHub now and answers in text; `watch` records a PrWatch for the calling
// session. The watcher (`tick`, run by one plugin instance of the server every
// interval) reads each repository that has a watch or a followed default
// branch: first a conditional probe of the REST resources that change when a
// request or the branch does (free when nothing changed), then, on a change,
// on a `poke` or every `refreshMs`, one GraphQL read of all the repository's
// watched requests and its default branch. Each read goes through PrWatch and
// DefaultBranch; what they notice goes to the sessions as steered messages.
//
// `poke(repo)` is the seam a push source (a webhook receiver) plugs into: it
// makes the next tick read the repository without probing.
import { Clock, Context, Effect, Layer, Ref } from "effect"
import { type BranchRead, DefaultBranch, branchNotice, followed, pruned, recipients, type RepoRecord, used } from "./branch.ts"
import { jobFailure, unread } from "./failure.ts"
import { BadInput, type PrInput, refOf, repoOfUrl, reviewersFor } from "./pr.ts"
import { failingLines, logsToRead, type Report, reportText } from "./report.ts"
import { Courier, type GhMissing, GitHub, type GitHubUnreadable, SessionDirectories, type SessionUnreadable, WatchStore } from "./service.ts"
import { noticeText, noticeTitle, Observe, PrWatch, type PrRef, refText, Start, Stop, summaryOf, type Watch, watchLine } from "./watch.ts"

export interface Settings {
  /** The repositories whose default branch is followed whatever the tool was used on. */
  readonly follow: ReadonlyArray<string>
  /** Owner (or `owner/name`) → the logins `create` asks for review by default. */
  readonly reviewers: Readonly<Record<string, ReadonlyArray<string>>>
  /** How often a repository is read in full even when its probes say nothing changed. */
  readonly refreshMs: number
}

/** What a tool call could not do, in words the agent reads. */
export type Refusal = BadInput | GhMissing | GitHubUnreadable | SessionUnreadable

export const refusalText = (refusal: Refusal): string => {
  switch (refusal._tag) {
    case "BadInput":
      return refusal.reason
    case "GhMissing":
      return "gh is not on PATH: the pr tool reads GitHub through it"
    case "GitHubUnreadable":
      return `GitHub did not answer: ${refusal.message}`
    case "SessionUnreadable":
      return refusal.message
  }
}

export class Pulls extends Context.Service<
  Pulls,
  {
    /** One `pr` tool call of `sessionID`: its answer, or why it could not. */
    readonly run: (sessionID: string, input: PrInput) => Effect.Effect<string, Refusal>
    /** One pass of the watcher. A repository that cannot be read waits for the next pass. */
    readonly tick: Effect.Effect<void>
    /** Read `repo` at the next pass without probing it. */
    readonly poke: (repo: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/git/Pulls") {}

const key = (ref: PrRef) => refText(ref)

/** The REST resources whose answers move when a watched request or the default branch does. */
export const probePaths = (repo: string, watched: ReadonlyArray<{ readonly number: number; readonly head: string }>, branch: string | undefined): ReadonlyArray<string> => {
  const paths = new Set<string>()
  for (const each of watched) {
    paths.add(`repos/${repo}/pulls/${each.number}`)
    paths.add(`repos/${repo}/commits/${each.head}/check-runs?per_page=100`)
    paths.add(`repos/${repo}/commits/${each.head}/status`)
  }
  if (branch !== undefined) {
    paths.add(`repos/${repo}/commits/${branch}/check-runs?per_page=100`)
    paths.add(`repos/${repo}/commits/${branch}/status`)
  }
  return [...paths]
}

export const layer = (settings: Settings) =>
  Layer.effect(
    Pulls,
    Effect.gen(function* () {
      const github = yield* GitHub
      const store = yield* WatchStore
      const courier = yield* Courier
      const directories = yield* SessionDirectories
      /** When each repository was last read in full, and its default branch's name, by this server. */
      const lastRead = yield* Ref.make(new Map<string, number>())
      const branches = yield* Ref.make(new Map<string, string>())
      const poked = yield* Ref.make(new Set<string>())

      /** The failing jobs' logs of `checks` worth reading, each a JobFailure. */
      const failuresOf = (repo: string, report: Pick<Report, "checks">) =>
        Effect.forEach(
          logsToRead(report.checks),
          (check) =>
            github.jobLog(repo, check.jobId ?? 0).pipe(
              Effect.map((log) => jobFailure(check.name, log)),
              Effect.catch((error) => Effect.succeed(unread(check.name, error._tag === "GhMissing" ? "gh is not on PATH" : error.message))),
            ),
          { concurrency: 3 },
        )

      /** Records that `sessionID`'s family used the tool on `repo`. */
      const use = (sessionID: string, repo: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const root = yield* courier.rootOf(sessionID).pipe(Effect.orElseSucceed(() => sessionID))
          const record = (yield* store.repos).find((each) => each.repo === repo) ?? { repo, users: {} }
          yield* store.putRepo(used(record, root, now))
        })

      /** The requests the input names; none named is the session's branch's request. */
      const targets = (sessionID: string, input: PrInput) =>
        Effect.gen(function* () {
          const directory = yield* directories.directoryOf(sessionID)
          const here = yield* github.here(directory)
          if (input.prs === undefined || input.prs.length === 0) {
            if (here.repo === undefined) return yield* new BadInput({ reason: "the session is in no GitHub checkout: name the requests in prs" })
            if (here.number === undefined) return yield* new BadInput({ reason: `the session's branch has no open pull request in ${here.repo}: name the requests in prs` })
            return [{ repo: here.repo, number: here.number }]
          }
          const refs: Array<PrRef> = []
          for (const target of input.prs) {
            const ref = refOf(target, here.repo)
            if (ref instanceof BadInput) return yield* ref
            if (!refs.some((each) => key(each) === key(ref))) refs.push(ref)
          }
          return refs
        })

      /** The reports of `refs`, one GraphQL read per repository, in the order asked; a number that does not exist is named. */
      const reports = (refs: ReadonlyArray<PrRef>) =>
        Effect.gen(function* () {
          const repos = [...new Set(refs.map((ref) => ref.repo))]
          const reads = yield* Effect.forEach(
            repos,
            (repo) =>
              github
                .read(
                  repo,
                  refs.filter((ref) => ref.repo === repo).map((ref) => ref.number),
                )
                .pipe(Effect.map((read) => [repo, read] as const)),
            { concurrency: 4 },
          )
          const byRepo = new Map(reads)
          return refs.map((ref) => ({ ref, report: byRepo.get(ref.repo)?.reports.find((each) => each.number === ref.number) }))
        })

      const missing = (ref: PrRef) => `${refText(ref)}: no such pull request`

      const status = (sessionID: string, input: PrInput) =>
        Effect.gen(function* () {
          const found = yield* reports(yield* targets(sessionID, input))
          const blocks = yield* Effect.forEach(found, ({ ref, report }) =>
            report === undefined ? Effect.succeed(missing(ref)) : failuresOf(ref.repo, report).pipe(Effect.map((failures) => reportText(report, failures))),
          )
          yield* Effect.forEach(new Set(found.map(({ ref }) => ref.repo)), (repo) => use(sessionID, repo))
          return blocks.join("\n\n")
        })

      const watchOf = (sessionID: string, ref: PrRef) =>
        store.watches.pipe(Effect.map((watches) => watches.find((watch) => watch.sessionID === sessionID && key(watch) === key(ref))))

      const watch = (sessionID: string, input: PrInput) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const until = input.until ?? "green"
          const found = yield* reports(yield* targets(sessionID, input))
          const lines: Array<string> = []
          for (const { ref, report } of found) {
            if (report === undefined) {
              lines.push(missing(ref))
              continue
            }
            const read = summaryOf(report)
            const command = Start.make({ sessionID, repo: ref.repo, number: ref.number, until, ...(input.note === undefined ? {} : { note: input.note }), read })
            const decided = yield* PrWatch.decide(yield* watchOf(sessionID, ref), command, now).pipe(Effect.result)
            if (decided._tag === "Failure") {
              lines.push(`${refText(ref)}: not watched: ${decided.failure.reason}.`)
              continue
            }
            for (const event of decided.success) if (event._tag === "Watched") yield* store.put(event.watch)
            lines.push(`Watching ${refText(ref)} ${report.title} until ${until}: checks ${read.verdict}${read.failing.length > 0 ? ` (${read.failing.join(", ")})` : ""}.`)
          }
          yield* Effect.forEach(new Set(found.map(({ ref }) => ref.repo)), (repo) => use(sessionID, repo))
          if (lines.some((line) => line.startsWith("Watching")))
            lines.push("A notice comes into this session when it fires; end your turn or do other work, and do not poll.")
          return lines.join("\n")
        })

      const unwatch = (sessionID: string, input: PrInput) =>
        Effect.gen(function* () {
          const mine = (yield* store.watches).filter((each) => each.sessionID === sessionID)
          const named = input.prs === undefined || input.prs.length === 0 ? mine : yield* targets(sessionID, input)
          const stopped: Array<string> = []
          for (const ref of named) {
            const current = mine.find((each) => key(each) === key(ref))
            // Stop never refuses.
            const events = yield* PrWatch.decide(current, Stop.make({}), 0).pipe(Effect.orDie)
            if (events.length === 0) continue
            yield* store.remove(sessionID, ref)
            stopped.push(refText(ref))
          }
          return stopped.length === 0 ? "No watch to stop." : `Stopped watching ${stopped.join(", ")}.`
        })

      const list = (sessionID: string) =>
        store.watches.pipe(
          Effect.map((watches) => {
            const mine = watches.filter((each) => each.sessionID === sessionID)
            return mine.length === 0 ? "No watches." : mine.map(watchLine).join("\n")
          }),
        )

      const create = (sessionID: string, input: PrInput) =>
        Effect.gen(function* () {
          if (input.title === undefined || input.title.trim().length === 0) return yield* new BadInput({ reason: "create needs a title" })
          const directory = yield* directories.directoryOf(sessionID)
          const here = yield* github.here(directory)
          if (here.repo === undefined) return yield* new BadInput({ reason: "the session is in no GitHub checkout" })
          if (here.number !== undefined) return yield* new BadInput({ reason: `the branch already has ${here.repo}#${here.number}` })
          const reviewers = reviewersFor(here.repo, input.reviewers, settings.reviewers)
          const url = yield* github.create(directory, {
            title: input.title,
            body: input.body ?? "",
            ...(input.base === undefined ? {} : { base: input.base }),
            draft: input.draft ?? false,
            reviewers,
          })
          yield* use(sessionID, repoOfUrl(url) ?? here.repo)
          return [`Opened ${url}`, `review requested from: ${reviewers.length === 0 ? "no one" : reviewers.join(", ")}`].join("\n")
        })

      // ── The watcher ──

      const deliver = (sessionID: string, notice: { readonly title: string; readonly text: string }) =>
        courier.deliver(sessionID, notice).pipe(Effect.ignore)

      /** Hands a read of the request to its watch and says what it notices. */
      const observe = (watch: Watch, report: Report) =>
        Effect.gen(function* () {
          // Observe never refuses.
          const events = yield* PrWatch.decide(watch, Observe.make({ read: summaryOf(report) }), 0).pipe(Effect.orDie)
          for (const event of events) {
            if (event._tag === "Seen") yield* store.put({ ...watch, last: event.last })
            if (event._tag !== "Noticed") continue
            const failing = event.last.verdict === "fail" && event.lines.some((line) => line.startsWith("checks"))
            const detail = failing ? [...failingLines(report.checks, yield* failuresOf(watch.repo, report))].join("\n") : undefined
            if (event.ended) yield* store.remove(watch.sessionID, watch)
            else yield* store.put({ ...watch, last: event.last })
            yield* deliver(watch.sessionID, { title: noticeTitle(watch, event), text: noticeText(watch, event, detail) })
          }
        })

      /** Hands a read of the default branch to DefaultBranch and tells the repository's recent users of a turn. */
      const observeBranch = (record: RepoRecord, read: BranchRead, now: number) =>
        Effect.gen(function* () {
          const events = yield* DefaultBranch.decide(record.branch, { _tag: "ObserveBranch", read }, now)
          let next = pruned(record, now)
          for (const event of events) {
            next = { ...next, branch: event.state }
            if (event._tag === "BranchSeen") continue
            const detail = event._tag === "TurnedRed" ? [...failingLines(read.checks, yield* failuresOf(record.repo, read))].join("\n") : undefined
            const notice = branchNotice(record.repo, read, event, detail)
            yield* Effect.forEach(recipients(record, now), (sessionID) => deliver(sessionID, notice), { discard: true })
          }
          yield* store.putRepo(next)
        })

      /** One repository's pass: probe, and read it on a change, a poke or a due refresh. */
      const visit = (repo: string, watches: ReadonlyArray<Watch>, record: RepoRecord | undefined, follow: boolean, now: number) =>
        Effect.gen(function* () {
          const last = (yield* Ref.get(lastRead)).get(repo)
          const wasPoked = (yield* Ref.get(poked)).has(repo)
          const branch = (yield* Ref.get(branches)).get(repo)
          const due = wasPoked || last === undefined || now - last >= settings.refreshMs
          const changed =
            due ||
            (yield* github.changed(
              probePaths(
                repo,
                watches.map((watch) => ({ number: watch.number, head: watch.last.head })),
                follow ? branch : undefined,
              ),
            ))
          if (!changed) return
          const numbers = [...new Set(watches.map((watch) => watch.number))]
          const read = yield* github.read(repo, numbers)
          yield* Ref.update(lastRead, (map) => new Map(map).set(repo, now))
          yield* Ref.update(branches, (map) => new Map(map).set(repo, read.branch.name))
          yield* Ref.update(poked, (set) => new Set([...set].filter((each) => each !== repo)))
          for (const watch of watches) {
            const report = read.reports.find((each) => each.number === watch.number)
            if (report !== undefined) yield* observe(watch, report)
          }
          if (follow) yield* observeBranch(record ?? { repo, users: {} }, read.branch, now)
        })

      const tick = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const watches = yield* store.watches
        const records = yield* store.repos
        const repos = new Set([...watches.map((watch) => watch.repo), ...settings.follow, ...records.map((record) => record.repo)])
        yield* Effect.forEach(
          repos,
          (repo) => {
            const record = records.find((each) => each.repo === repo)
            const follow = record === undefined ? settings.follow.includes(repo) : followed(record, now, settings.follow.includes(repo))
            const mine = watches.filter((watch) => watch.repo === repo)
            if (!follow && mine.length === 0) return Effect.void
            return visit(repo, mine, record, follow, now).pipe(Effect.ignore)
          },
          { concurrency: 4, discard: true },
        )
      })

      return Pulls.of({
        run: Effect.fn("Pulls.run")(function* (sessionID: string, input: PrInput) {
          switch (input.action) {
            case "status":
              return yield* status(sessionID, input)
            case "watch":
              return yield* watch(sessionID, input)
            case "unwatch":
              return yield* unwatch(sessionID, input)
            case "list":
              return yield* list(sessionID)
            case "create":
              return yield* create(sessionID, input)
          }
        }),
        tick: tick.pipe(Effect.withSpan("Pulls.tick")),
        poke: (repo) => Ref.update(poked, (set) => new Set(set).add(repo)),
      })
    }),
  )

