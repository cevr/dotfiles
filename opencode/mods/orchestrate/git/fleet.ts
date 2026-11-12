import { tagObject, type Target, targetOfTag, VERIFIED_REF } from "@dotfiles/opencode-update/target"
import { file, readableStreamToText, spawn, write } from "bun"
import { Array as Arr, Clock, Effect, Layer, Option, Semaphore } from "effect"
import { type Commits, FleetOutcome } from "../fleet.ts"
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
 * What the batch file lacks to name a target: both heads, the dotfiles' and the fork's, as the
 * orchestrator writes them; empty when it names both. No kept commit stands in for a missing head:
 * the fork moves apart from batches (an upstream merge after a land), so the last recorded fork is
 * not the one a dotfiles-only batch was verified with.
 */
export const missingOf = (heads: Heads): ReadonlyArray<string> => [
  ...Option.match(heads.dotfiles, { onNone: () => ["the dotfiles head (`Dotfiles: base X, head Y`)"], onSome: () => [] }),
  ...Option.match(heads.fork, { onNone: () => ["the fork head (`Fork prime-look: base X, head Y` or `Fork unchanged (Y)`)"], onSome: () => [] }),
]

/** Whether `target` names the commits `current` names: recording them again moves nothing. */
export const sameAs = (target: Commits, current: Option.Option<Commits>): boolean => Option.exists(current, (each) => each.dotfiles === target.dotfiles && each.fork === target.fork)

/** The batch file beside a verifier's report: `<run dir>/<batch>.md`, the orchestrator's brief of the batch. */
export const batchFileOf = (report: string, batch: string): string => `${report.slice(0, report.lastIndexOf("/") + 1)}${batch}.md`

/** A finished git command: its exit code and its output, trimmed. */
interface Ran {
  readonly code: number
  readonly text: string
}

/** One git command in `cwd`; none when it does not start. */
const run = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<Option.Option<Ran>> =>
  Effect.try(() => spawn(["git", "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })).pipe(
    Effect.flatMap((child) =>
      Effect.all({ code: Effect.tryPromise(() => child.exited), text: Effect.tryPromise(() => readableStreamToText(child.stdout)) }, { concurrency: 2 }),
    ),
    Effect.map(({ code, text }) => Option.some({ code, text: text.trim() })),
    Effect.orElseSucceed(() => Option.none<Ran>()),
  )

/** One git command in `cwd`: its output, trimmed; none when it fails. */
const git = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<Option.Option<string>> =>
  run(cwd, args).pipe(Effect.map((ran) => Option.map(Option.filter(ran, (each) => each.code === 0), (each) => each.text)))

/** A full commit name read in `cwd`. */
const commitAt = (cwd: string, revision: string) => git(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])

/** Whether one of origin's branches, as `cwd` last fetched them, holds `commit`. */
const onOrigin = (cwd: string, commit: string) =>
  git(cwd, ["branch", "--remotes", "--contains", commit]).pipe(Effect.map((text) => Option.exists(text, (each) => /^\s*origin\//m.test(each))))

/** Whether `commit` is `current` or descends from it, in `cwd`: the fleet only moves forward. */
const descends = (cwd: string, current: string, commit: string) =>
  run(cwd, ["merge-base", "--is-ancestor", current, commit]).pipe(Effect.map((ran) => Option.exists(ran, (each) => each.code === 0)))

/** The target the batch file beside `report` names, recorded on the dotfiles origin as `VERIFIED_REF`, through the dotfiles checkout. */
const recordTarget = Effect.fn("Fleet.recordTarget")(function* (checkouts: Checkouts, report: string, batch: string) {
  const path = batchFileOf(report, batch)
  const text = yield* Effect.tryPromise(() => file(path).text()).pipe(Effect.map(Option.some), Effect.orElseSucceed(() => Option.none<string>()))
  if (Option.isNone(text)) return FleetOutcome.Refused({ reason: `the batch file ${path} does not read` })
  const named = headsOf(text.value)
  const both = Option.all({ dotfiles: named.dotfiles, fork: named.fork })
  if (Option.isNone(both)) return FleetOutcome.Refused({ reason: `the batch file ${path} lacks ${missingOf(named).join(" and ")}` })
  const short = both.value
  yield* Effect.all([git(checkouts.dotfiles, ["fetch", "--quiet", "origin"]), git(checkouts.fork, ["fetch", "--quiet", "origin"])], { concurrency: 2 })
  yield* git(checkouts.dotfiles, ["fetch", "--quiet", "origin", `+${VERIFIED_REF}:${VERIFIED_REF}`])
  const current = Option.flatMap(yield* git(checkouts.dotfiles, ["cat-file", "tag", VERIFIED_REF]), targetOfTag)
  const full = yield* Effect.all({ dotfiles: commitAt(checkouts.dotfiles, short.dotfiles), fork: commitAt(checkouts.fork, short.fork) })
  if (Option.isNone(full.dotfiles) || Option.isNone(full.fork))
    return FleetOutcome.Refused({ reason: `the batch file names a head the checkouts do not know (dotfiles ${short.dotfiles}, fork ${short.fork})` })
  const wanted: Target = { dotfiles: full.dotfiles.value, fork: full.fork.value, batch }
  if (sameAs(wanted, current)) return FleetOutcome.Unchanged({ target: wanted })
  const pushed = yield* Effect.all([onOrigin(checkouts.dotfiles, wanted.dotfiles), onOrigin(checkouts.fork, wanted.fork)])
  if (!pushed.every(Boolean)) return FleetOutcome.Refused({ reason: `origin lacks dotfiles ${wanted.dotfiles.slice(0, 10)} or fork ${wanted.fork.slice(0, 10)}` })
  if (Option.isSome(current)) {
    const was = current.value
    const forward = yield* Effect.all([descends(checkouts.dotfiles, was.dotfiles, wanted.dotfiles), descends(checkouts.fork, was.fork, wanted.fork)])
    if (!forward.every(Boolean))
      return FleetOutcome.Refused({
        reason: `dotfiles ${wanted.dotfiles.slice(0, 10)} and fork ${wanted.fork.slice(0, 10)} do not both descend from the current target (dotfiles ${was.dotfiles.slice(0, 10)}, fork ${was.fork.slice(0, 10)}, ${was.batch}): a batch behind it never moves the fleet back`,
      })
  }
  const gitDir = yield* git(checkouts.dotfiles, ["rev-parse", "--absolute-git-dir"])
  if (Option.isNone(gitDir)) return FleetOutcome.Refused({ reason: "the dotfiles checkout has no git directory" })
  const tagFile = `${gitDir.value}/fleet-verified.tag`
  const at = (yield* Clock.currentTimeMillis) / 1000
  yield* Effect.tryPromise(() => write(tagFile, tagObject(wanted, { ...TAGGER, at })))
  const tag = yield* git(checkouts.dotfiles, ["hash-object", "-t", "tag", "-w", tagFile])
  if (Option.isNone(tag)) return FleetOutcome.Refused({ reason: "git refused the tag object" })
  const done = yield* git(checkouts.dotfiles, ["push", "--quiet", "origin", `+${tag.value}:${VERIFIED_REF}`])
  if (Option.isNone(done)) return FleetOutcome.Refused({ reason: `pushing ${VERIFIED_REF} was refused` })
  yield* git(checkouts.dotfiles, ["update-ref", VERIFIED_REF, tag.value])
  return FleetOutcome.Recorded({ target: wanted })
})

/** Records the target one accepted batch names, and answers the outcome. */
export const recordOnce = (checkouts: Checkouts, report: string, batch: string): Effect.Effect<FleetOutcome> =>
  recordTarget(checkouts, report, batch).pipe(Effect.orElseSucceed(() => FleetOutcome.Refused({ reason: "recording the verified target failed" })))

/**
 * Fleet over git: the dotfiles and fork checkouts daily wrote into the plugin's options. Without
 * them (a test, a host outside the owner's) nothing is recorded and nothing said (`Off`). One
 * record at a time.
 */
export const layer = (checkouts: Option.Option<Checkouts>) =>
  Layer.effect(
    Fleet,
    Effect.gen(function* () {
      const one = yield* Semaphore.make(1)
      const record = Effect.fn("Fleet.record")(function* (input: { readonly report: Option.Option<string>; readonly batch: string }) {
        if (Option.isNone(checkouts)) return FleetOutcome.Off()
        if (Option.isNone(input.report)) return FleetOutcome.Refused({ reason: "the verifier named no report, so there is no batch file beside it" })
        return yield* recordOnce(checkouts.value, input.report.value, input.batch)
      })
      return Fleet.of({ record: (input) => record(input).pipe(one.withPermits(1)) })
    }),
  )
