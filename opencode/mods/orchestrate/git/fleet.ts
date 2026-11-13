import { tagObject, type Target, targetOfTag, VERIFIED_REF } from "@dotfiles/opencode-update/target"
import { file, readableStreamToText, spawn } from "bun"
import { Array as Arr, Clock, Effect, Layer, Option, Result, Semaphore } from "effect"
import { type Commits, FleetOutcome } from "../fleet.ts"
import { Fleet } from "../service.ts"

/** The checkouts daily installs from: the dotfiles and the OpenCode fork. */
export interface Checkouts {
  readonly dotfiles: string
  readonly fork: string
}

/** Who the tag names as its tagger. */
const TAGGER = { name: "orchestrate", email: "orchestrate@dotfiles.invalid" }

/** The form of the one machine line a batch file names its verified heads with, as a refusal quotes it. */
export const HEADS_FORM = "`Heads: dotfiles=<40-hex sha> fork=<40-hex sha>`"

/** The heads line, exactly: both full commit names, lowercase, in this order, nothing else on the line. */
const HEADS_LINE = /^Heads: dotfiles=([0-9a-f]{40}) fork=([0-9a-f]{40})$/

/** A line that means to be the heads line: it starts with `Heads:` in any case, after any indent, bullet, quote or backtick. */
const HEADS_START = /^\W*heads:/i

/**
 * The heads a batch file names: its one line `Heads: dotfiles=<sha> fork=<sha>`, both full
 * commit names, which the orchestrator writes after resolving them. No prose is read. A file with
 * no such line, two or more, or one not exactly in that form (a short or uppercase hash, a missing
 * repository, extra words) fails with why, and the publish refuses rather than guess.
 */
export const headsOf = (text: string): Result.Result<Commits, string> => {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => HEADS_START.test(line))
  const line = Arr.head(lines)
  if (Option.isNone(line)) return Result.fail(`has no heads line; write one, exactly ${HEADS_FORM}`)
  if (lines.length > 1) return Result.fail(`has ${lines.length} heads lines; write one, exactly ${HEADS_FORM}`)
  const match = Option.fromNullishOr(HEADS_LINE.exec(line.value))
  if (Option.isNone(match)) return Result.fail(`has a malformed heads line (<${line.value.slice(0, 160)}>); write it exactly ${HEADS_FORM}, both full commit names`)
  return Result.succeed({ dotfiles: match.value[1], fork: match.value[2] })
}

/** Whether `target` names the commits `current` names: recording them again moves nothing. */
export const sameAs = (target: Commits, current: Option.Option<Commits>): boolean => Option.exists(current, (each) => each.dotfiles === target.dotfiles && each.fork === target.fork)

/** The batch file beside a verifier's report: `<run dir>/<batch>.md`, the orchestrator's brief of the batch. */
export const batchFileOf = (report: string, batch: string): string => `${report.slice(0, report.lastIndexOf("/") + 1)}${batch}.md`

/** A finished git command: its exit code and its output, trimmed. */
interface Ran {
  readonly code: number
  readonly text: string
}

/** One command of `program` (git) in `cwd`, `input` on its stdin (empty for most); none when it does not start. */
const run = (program: string, cwd: string, args: ReadonlyArray<string>, input = ""): Effect.Effect<Option.Option<Ran>> =>
  Effect.try(() => {
    const child = spawn([program, "-C", cwd, ...args], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    child.stdin.write(input)
    child.stdin.end()
    return child
  }).pipe(
    Effect.flatMap((child) =>
      Effect.all({ code: Effect.tryPromise(() => child.exited), text: Effect.tryPromise(() => readableStreamToText(child.stdout)) }, { concurrency: 2 }),
    ),
    Effect.map(({ code, text }) => Option.some({ code, text: text.trim() })),
    Effect.orElseSucceed(() => Option.none<Ran>()),
  )

/** One git command in `cwd`: its output, trimmed; none when it fails. */
const git = (program: string, cwd: string, args: ReadonlyArray<string>, input = ""): Effect.Effect<Option.Option<string>> =>
  run(program, cwd, args, input).pipe(Effect.map((ran) => Option.map(Option.filter(ran, (each) => each.code === 0), (each) => each.text)))

/** A full commit name read in `cwd`. */
const commitAt = (program: string, cwd: string, revision: string) => git(program, cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])

/** Whether one of origin's branches, as `cwd` last fetched them, holds `commit`. */
const onOrigin = (program: string, cwd: string, commit: string) =>
  git(program, cwd, ["branch", "--remotes", "--contains", commit]).pipe(Effect.map((text) => Option.exists(text, (each) => /^\s*origin\//m.test(each))))

/** Whether `commit` is `current` or descends from it, in `cwd`: the fleet only moves forward. */
const descends = (program: string, cwd: string, current: string, commit: string) =>
  run(program, cwd, ["merge-base", "--is-ancestor", current, commit]).pipe(Effect.map((ran) => Option.exists(ran, (each) => each.code === 0)))

/** How many times a record pushes when the verified ref moves under it: once, and once more after reading it again. */
const PUSHES = 2

/**
 * Publishes `wanted` over the verified ref as this checkout reads it, leased: the push names the
 * tag it read (`--force-with-lease=<ref>:<tag>`, empty when there is none), so a target another
 * host published since is never overwritten. A push the lease refuses reads the ref again and runs
 * the checks again (the same commits, forward only) before it pushes once more.
 */
const publish = (program: string, checkouts: Checkouts, wanted: Target, pushes: number): Effect.Effect<FleetOutcome> =>
  Effect.gen(function* () {
    yield* git(program, checkouts.dotfiles, ["fetch", "--quiet", "origin", `+${VERIFIED_REF}:${VERIFIED_REF}`])
    const lease = Option.getOrElse(yield* git(program, checkouts.dotfiles, ["rev-parse", "--verify", "--quiet", VERIFIED_REF]), () => "")
    const current = Option.flatMap(yield* git(program, checkouts.dotfiles, ["cat-file", "tag", VERIFIED_REF]), targetOfTag)
    if (sameAs(wanted, current)) return FleetOutcome.Unchanged({ target: wanted })
    if (Option.isSome(current)) {
      const was = current.value
      const forward = yield* Effect.all([descends(program, checkouts.dotfiles, was.dotfiles, wanted.dotfiles), descends(program, checkouts.fork, was.fork, wanted.fork)])
      if (!forward.every(Boolean))
        return FleetOutcome.Refused({
          reason: `dotfiles ${wanted.dotfiles.slice(0, 10)} and fork ${wanted.fork.slice(0, 10)} do not both descend from the current target (dotfiles ${was.dotfiles.slice(0, 10)}, fork ${was.fork.slice(0, 10)}, ${was.batch}): a batch behind it never moves the fleet back`,
        })
    }
    const at = (yield* Clock.currentTimeMillis) / 1000
    const tag = yield* git(program, checkouts.dotfiles, ["hash-object", "-t", "tag", "-w", "--stdin"], tagObject(wanted, { ...TAGGER, at }))
    if (Option.isNone(tag)) return FleetOutcome.Refused({ reason: "git refused the tag object" })
    const named = Option.flatMap(yield* git(program, checkouts.dotfiles, ["cat-file", "tag", tag.value]), targetOfTag)
    if (!Option.exists(named, (each) => sameAs(wanted, Option.some(each)) && each.batch === wanted.batch))
      return FleetOutcome.Refused({ reason: `the tag object git stored (${tag.value.slice(0, 10)}) does not name dotfiles ${wanted.dotfiles.slice(0, 10)}, fork ${wanted.fork.slice(0, 10)} (${wanted.batch}): nothing pushed` })
    const done = yield* git(program, checkouts.dotfiles, ["push", "--quiet", `--force-with-lease=${VERIFIED_REF}:${lease}`, "origin", `${tag.value}:${VERIFIED_REF}`])
    if (Option.isSome(done)) {
      yield* git(program, checkouts.dotfiles, ["update-ref", VERIFIED_REF, tag.value])
      return FleetOutcome.Recorded({ target: wanted })
    }
    if (pushes > 1) return yield* publish(program, checkouts, wanted, pushes - 1)
    return FleetOutcome.Refused({
      reason: `pushing ${VERIFIED_REF} was refused ${PUSHES} times: another host published a target while this one recorded, or origin refused the push`,
    })
  })

/** The target the batch file beside `report` names, recorded on the dotfiles origin as `VERIFIED_REF`, through the dotfiles checkout. */
const recordTarget = Effect.fn("Fleet.recordTarget")(function* (program: string, checkouts: Checkouts, report: string, batch: string) {
  const path = batchFileOf(report, batch)
  const text = yield* Effect.tryPromise(() => file(path).text()).pipe(Effect.map(Option.some), Effect.orElseSucceed(() => Option.none<string>()))
  if (Option.isNone(text)) return FleetOutcome.Refused({ reason: `the batch file ${path} does not read` })
  const named = headsOf(text.value)
  if (Result.isFailure(named)) return FleetOutcome.Refused({ reason: `the batch file ${path} ${named.failure}` })
  const heads = named.success
  yield* Effect.all([git(program, checkouts.dotfiles, ["fetch", "--quiet", "origin"]), git(program, checkouts.fork, ["fetch", "--quiet", "origin"])], { concurrency: 2 })
  const full = yield* Effect.all({ dotfiles: commitAt(program, checkouts.dotfiles, heads.dotfiles), fork: commitAt(program, checkouts.fork, heads.fork) })
  if (Option.isNone(full.dotfiles) || Option.isNone(full.fork))
    return FleetOutcome.Refused({ reason: `the batch file names a head the checkouts do not know (dotfiles ${heads.dotfiles}, fork ${heads.fork})` })
  const wanted: Target = { dotfiles: full.dotfiles.value, fork: full.fork.value, batch }
  const pushed = yield* Effect.all([onOrigin(program, checkouts.dotfiles, wanted.dotfiles), onOrigin(program, checkouts.fork, wanted.fork)])
  if (!pushed.every(Boolean)) return FleetOutcome.Refused({ reason: `origin lacks dotfiles ${wanted.dotfiles.slice(0, 10)} or fork ${wanted.fork.slice(0, 10)}` })
  return yield* publish(program, checkouts, wanted, PUSHES)
})

/** Records the target one accepted batch names, and answers the outcome; `program` is the git it runs (a test's may stand in another host). */
export const recordOnce = (checkouts: Checkouts, report: string, batch: string, program = "git"): Effect.Effect<FleetOutcome> =>
  recordTarget(program, checkouts, report, batch).pipe(Effect.orElseSucceed(() => FleetOutcome.Refused({ reason: "recording the verified target failed" })))

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
