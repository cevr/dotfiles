import { tagObject, type Target, targetOfTag, VERIFIED_REF } from "@dotfiles/opencode-update/target"
import { file, readableStreamToText, spawn, write } from "bun"
import { Array as Arr, Clock, Effect, Layer, Option, Semaphore } from "effect"
import { Fleet } from "../service.ts"

/** The checkouts daily installs from: the dotfiles and the OpenCode fork. */
export interface Checkouts {
  readonly dotfiles: string
  readonly fork: string
}

/** Who the tag names as its tagger. */
const TAGGER = { name: "orchestrate", email: "orchestrate@dotfiles.invalid" }

/** The commits a batch file names as the heads it was verified at; a repository it does not name is none. */
export interface Heads {
  readonly dotfiles: Option.Option<string>
  readonly fork: Option.Option<string>
}

/** A commit name, short or full: hex of 7 to 40 characters with a digit in it, so no English word reads as one. */
const COMMIT = /^(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}$/

/** Where a repository's part of a batch file's header starts: its name at a line's or a sentence's start. */
const PART = /(?:^|\n|[.;]\s+)(?:-\s+)?(Dotfiles|Fork)\b/g

/**
 * The head a part of a batch file's header names: the commit after `head`, else the first commit
 * not after `base` (`Fork unchanged (prime-look 13a380890b)`, `Dotfiles: 0eb81d14 (no dotfiles
 * change)`). None when it names no commit (`head origin/main`).
 */
const headOfPart = (part: string): Option.Option<string> => {
  const words = part.split(/[\s,;:.()`]+/)
  const named = words.filter((each, at) => COMMIT.test(each) && words[at - 1] === "head")
  const unnamed = words.filter((each, at) => COMMIT.test(each) && words[at - 1] !== "base")
  return Arr.head([...named, ...unnamed])
}

/**
 * The heads a batch file names, as the orchestrator writes its header: `Dotfiles: base X, head Y`,
 * `Fork prime-look: base X, head Y`, `Fork (…): base X, head Y`, `Fork unchanged (13a380890b)`.
 * Each repository's part runs to the next part; the first part that names a commit wins.
 */
export const headsOf = (text: string): Heads => {
  const starts = Arr.fromIterable(text.matchAll(PART)).map((match) => ({ name: match[1], at: match.index + match[0].length - match[1].length }))
  const parts = starts.map((start, at) => ({ name: start.name, text: text.slice(start.at, Option.getOrElse(Option.map(Option.fromNullishOr(starts[at + 1]), (next) => next.at), () => text.length)).split("\n")[0] }))
  const first = (name: string) => Arr.head(parts.filter((part) => part.name === name).flatMap((part) => Option.toArray(headOfPart(part.text))))
  return { dotfiles: first("Dotfiles"), fork: first("Fork") }
}

/**
 * The target an accepted batch verified: the heads its batch file names, each resolved to its full
 * commit, and for a repository it does not name the current target's commit (the batch verified it
 * as it stood). None when a repository has neither: never a checkout's HEAD, which may stand
 * anywhere when the verdict comes.
 */
export const targetOf = (input: { readonly heads: Heads; readonly current: Option.Option<Target>; readonly batch: string }): Option.Option<Target> =>
  Option.all({
    dotfiles: Option.orElse(input.heads.dotfiles, () => Option.map(input.current, (target) => target.dotfiles)),
    fork: Option.orElse(input.heads.fork, () => Option.map(input.current, (target) => target.fork)),
  }).pipe(Option.map((commits) => ({ ...commits, batch: input.batch })))

/** Whether `target` names other commits than `current`: recording the same ones again moves nothing. */
export const moves = (target: Target, current: Option.Option<Target>): boolean =>
  !Option.exists(current, (each) => each.dotfiles === target.dotfiles && each.fork === target.fork)

/** The batch file beside a verifier's report: `<run dir>/<batch>.md`, the orchestrator's brief of the batch. */
export const batchFileOf = (report: string, batch: string): string => `${report.slice(0, report.lastIndexOf("/") + 1)}${batch}.md`

/** One git command in `cwd`: its output, trimmed; none when it fails. */
const git = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<Option.Option<string>> =>
  Effect.try(() => spawn(["git", "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })).pipe(
    Effect.flatMap((child) =>
      Effect.all({ code: Effect.tryPromise(() => child.exited), text: Effect.tryPromise(() => readableStreamToText(child.stdout)) }, { concurrency: 2 }),
    ),
    Effect.map(({ code, text }) => Option.filter(Option.some(text.trim()), () => code === 0)),
    Effect.orElseSucceed(() => Option.none<string>()),
  )

/** A full commit name read in `cwd`. */
const commitAt = (cwd: string, revision: string) => git(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])

/** A head the batch file named, as the full commit `cwd` knows; none when it named none. Some none when `cwd` knows no such commit. */
const resolved = (cwd: string, head: Option.Option<string>) =>
  Option.match(head, { onNone: () => Effect.succeed(Option.none<Option.Option<string>>()), onSome: (short) => commitAt(cwd, short).pipe(Effect.map(Option.some)) })

/** Whether one of origin's branches, as `cwd` last fetched them, holds `commit`. */
const onOrigin = (cwd: string, commit: string) =>
  git(cwd, ["branch", "--remotes", "--contains", commit]).pipe(Effect.map((text) => Option.exists(text, (each) => /^\s*origin\//m.test(each))))

/** Records the target the batch file beside `report` names on the dotfiles origin as `VERIFIED_REF`, through the dotfiles checkout. */
const recordTarget = Effect.fn("Fleet.recordTarget")(function* (checkouts: Checkouts, report: string, batch: string) {
  const path = batchFileOf(report, batch)
  const text = yield* Effect.tryPromise(() => file(path).text()).pipe(Effect.map(Option.some), Effect.orElseSucceed(() => Option.none<string>()))
  if (Option.isNone(text)) return `the batch file ${path} does not read: nothing recorded`
  const named = headsOf(text.value)
  if (Option.isNone(named.dotfiles) && Option.isNone(named.fork)) return `the batch file ${path} names no head: nothing recorded`
  yield* Effect.all([git(checkouts.dotfiles, ["fetch", "--quiet", "origin"]), git(checkouts.fork, ["fetch", "--quiet", "origin"])], { concurrency: 2 })
  yield* git(checkouts.dotfiles, ["fetch", "--quiet", "origin", `+${VERIFIED_REF}:${VERIFIED_REF}`])
  const current = Option.flatMap(yield* git(checkouts.dotfiles, ["cat-file", "tag", VERIFIED_REF]), targetOfTag)
  const full = yield* Effect.all({ dotfiles: resolved(checkouts.dotfiles, named.dotfiles), fork: resolved(checkouts.fork, named.fork) })
  const unknown = [Option.exists(full.dotfiles, Option.isNone), Option.exists(full.fork, Option.isNone)]
  if (unknown.some(Boolean)) return `the batch file names a head the checkouts do not know (dotfiles ${Option.getOrElse(named.dotfiles, () => "-")}, fork ${Option.getOrElse(named.fork, () => "-")}): nothing recorded`
  const target = targetOf({ heads: { dotfiles: Option.flatten(full.dotfiles), fork: Option.flatten(full.fork) }, current, batch })
  if (Option.isNone(target)) return `the batch file names one repository's head only (dotfiles ${Option.getOrElse(named.dotfiles, () => "-")}, fork ${Option.getOrElse(named.fork, () => "-")}) and no target is recorded yet for the other: nothing recorded`
  const wanted = target.value
  if (!moves(wanted, current)) return `the target is already dotfiles ${wanted.dotfiles.slice(0, 10)}, fork ${wanted.fork.slice(0, 10)}`
  const pushed = yield* Effect.all([onOrigin(checkouts.dotfiles, wanted.dotfiles), onOrigin(checkouts.fork, wanted.fork)])
  if (!pushed.every(Boolean)) return `origin lacks dotfiles ${wanted.dotfiles.slice(0, 10)} or fork ${wanted.fork.slice(0, 10)}: nothing recorded`
  const gitDir = yield* git(checkouts.dotfiles, ["rev-parse", "--absolute-git-dir"])
  if (Option.isNone(gitDir)) return "the dotfiles checkout has no git directory"
  const tagFile = `${gitDir.value}/fleet-verified.tag`
  const at = (yield* Clock.currentTimeMillis) / 1000
  yield* Effect.tryPromise(() => write(tagFile, tagObject(wanted, { ...TAGGER, at })))
  const tag = yield* git(checkouts.dotfiles, ["hash-object", "-t", "tag", "-w", tagFile])
  if (Option.isNone(tag)) return "git refused the tag object"
  const done = yield* git(checkouts.dotfiles, ["push", "--quiet", "origin", `+${tag.value}:${VERIFIED_REF}`])
  if (Option.isNone(done)) return `pushing ${VERIFIED_REF} was refused`
  yield* git(checkouts.dotfiles, ["update-ref", VERIFIED_REF, tag.value])
  return `recorded the verified target: dotfiles ${wanted.dotfiles.slice(0, 10)}, fork ${wanted.fork.slice(0, 10)} (${batch})`
})

/**
 * Fleet over git: the dotfiles and fork checkouts daily wrote into the plugin's options. Without
 * them (a test, a host outside the owner's) nothing is recorded. The fetches and the push run
 * apart from the hand-back that asked, one record at a time; every outcome is one log line.
 */
export const layer = (checkouts: Option.Option<Checkouts>) =>
  Layer.effect(
    Fleet,
    Effect.gen(function* () {
      const one = yield* Semaphore.make(1)
      const record = Effect.fn("Fleet.record")(function* (input: { readonly report: Option.Option<string>; readonly batch: string }) {
        if (Option.isNone(checkouts)) return
        if (Option.isNone(input.report)) return yield* Effect.logInfo(`fleet: ${input.batch} was accepted with no report named, so no batch file: nothing recorded`)
        const outcome = yield* recordTarget(checkouts.value, input.report.value, input.batch).pipe(Effect.orElseSucceed(() => "recording the verified target failed"))
        yield* Effect.logInfo(`fleet: ${outcome}`)
      })
      return Fleet.of({ record: (input) => record(input).pipe(one.withPermits(1), Effect.forkDetach, Effect.asVoid) })
    }),
  )

/** Records the target one accepted batch names, and answers the log line, for a test over real git. */
export const recordOnce = (checkouts: Checkouts, report: string, batch: string): Effect.Effect<string> =>
  recordTarget(checkouts, report, batch).pipe(Effect.orElseSucceed(() => "recording the verified target failed"))
