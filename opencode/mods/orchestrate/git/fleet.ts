import { tagObject, type Target, targetOfTag, VERIFIED_REF } from "@dotfiles/opencode-update/target"
import { readableStreamToText, spawn, write } from "bun"
import { Clock, Effect, Layer, Option, Semaphore } from "effect"
import { Fleet } from "../service.ts"

/** The checkouts daily installs from: the dotfiles and the OpenCode fork. */
export interface Checkouts {
  readonly dotfiles: string
  readonly fork: string
}

/** Who the tag names as its tagger. */
const TAGGER = { name: "orchestrate", email: "orchestrate@dotfiles.invalid" }

/**
 * A remote's URL as the repository it names, so an ssh and an https URL of one repository match:
 * `git@github.com:cevr/dotfiles.git` and `https://github.com/cevr/dotfiles` are both
 * `github.com/cevr/dotfiles`. A local path stays as it is.
 */
export const repositoryOf = (url: string): string =>
  url
    .trim()
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/i, "")
    .replace(/^[^@/]+@([^:/]+):/, "$1/")
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "")
    .toLowerCase()

/** Which repository a verifier's checkout is of, by its origin's URL: the dotfiles, the fork or neither. */
export type Repository = "dotfiles" | "fork" | "neither"

/** The repository whose origin `here` names, the dotfiles' and the fork's origins being these. */
export const repositoryAt = (here: Option.Option<string>, origins: { readonly dotfiles: Option.Option<string>; readonly fork: Option.Option<string> }): Repository => {
  const same = (other: Option.Option<string>) => Option.isSome(here) && Option.isSome(other) && repositoryOf(here.value) === repositoryOf(other.value)
  if (same(origins.dotfiles)) return "dotfiles"
  if (same(origins.fork)) return "fork"
  return "neither"
}

/**
 * The target an accepted batch verified in a checkout of `repository` at commit `head`: that
 * commit for its repository, and for the other the commit it was verified with. The fork's is its
 * checkout's commit (the build daily installs); the dotfiles' is the current target's, else origin's
 * main, since a fork batch verified the dotfiles as they stood.
 */
export const targetOf = (input: {
  readonly repository: Exclude<Repository, "neither">
  readonly head: string
  readonly batch: string
  readonly fork: string
  readonly current: Option.Option<Target>
  readonly main: string
}): Target => {
  if (input.repository === "dotfiles") return { dotfiles: input.head, fork: input.fork, batch: input.batch }
  const dotfiles = Option.getOrElse(Option.map(input.current, (target) => target.dotfiles), () => input.main)
  return { dotfiles, fork: input.head, batch: input.batch }
}

/** Whether `target` names other commits than `current`: recording the same ones again moves nothing. */
export const moves = (target: Target, current: Option.Option<Target>): boolean =>
  !Option.exists(current, (each) => each.dotfiles === target.dotfiles && each.fork === target.fork)

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

/** Whether one of origin's branches, as `cwd` last fetched them, holds `commit`. */
const onOrigin = (cwd: string, commit: string) =>
  git(cwd, ["branch", "--remotes", "--contains", commit]).pipe(Effect.map((text) => Option.exists(text, (each) => /^\s*origin\//m.test(each))))

/** Records the verified target on the dotfiles origin as `VERIFIED_REF`, through the dotfiles checkout. */
const recordTarget = Effect.fn("Fleet.recordTarget")(function* (checkouts: Checkouts, directory: string, batch: string) {
  const origins = yield* Effect.all(
    { here: git(directory, ["remote", "get-url", "origin"]), dotfiles: git(checkouts.dotfiles, ["remote", "get-url", "origin"]), fork: git(checkouts.fork, ["remote", "get-url", "origin"]) },
    { concurrency: 3 },
  )
  const repository = repositoryAt(origins.here, origins)
  if (repository === "neither") return `the verifier's checkout ${directory} is of neither the dotfiles nor the fork`
  yield* Effect.all([git(checkouts.dotfiles, ["fetch", "--quiet", "origin"]), git(checkouts.fork, ["fetch", "--quiet", "origin"])], { concurrency: 2 })
  yield* git(checkouts.dotfiles, ["fetch", "--quiet", "origin", `+${VERIFIED_REF}:${VERIFIED_REF}`])
  const current = Option.flatMap(yield* git(checkouts.dotfiles, ["cat-file", "tag", VERIFIED_REF]), targetOfTag)
  const read = yield* Effect.all({
    head: commitAt(directory, "HEAD"),
    fork: commitAt(checkouts.fork, "HEAD"),
    main: commitAt(checkouts.dotfiles, "refs/remotes/origin/main"),
  })
  if (Option.isNone(read.head) || Option.isNone(read.fork) || Option.isNone(read.main)) return "a commit did not read"
  const target = targetOf({ repository, head: read.head.value, batch, fork: read.fork.value, current, main: read.main.value })
  if (!moves(target, current)) return `the target is already dotfiles ${target.dotfiles.slice(0, 10)}, fork ${target.fork.slice(0, 10)}`
  const pushed = yield* Effect.all([onOrigin(checkouts.dotfiles, target.dotfiles), onOrigin(checkouts.fork, target.fork)])
  if (!pushed.every(Boolean)) return `origin lacks dotfiles ${target.dotfiles.slice(0, 10)} or fork ${target.fork.slice(0, 10)}: nothing recorded`
  const gitDir = yield* git(checkouts.dotfiles, ["rev-parse", "--absolute-git-dir"])
  if (Option.isNone(gitDir)) return "the dotfiles checkout has no git directory"
  const path = `${gitDir.value}/fleet-verified.tag`
  const at = (yield* Clock.currentTimeMillis) / 1000
  yield* Effect.tryPromise(() => write(path, tagObject(target, { ...TAGGER, at })))
  const tag = yield* git(checkouts.dotfiles, ["hash-object", "-t", "tag", "-w", path])
  if (Option.isNone(tag)) return "git refused the tag object"
  const done = yield* git(checkouts.dotfiles, ["push", "--quiet", "origin", `+${tag.value}:${VERIFIED_REF}`])
  if (Option.isNone(done)) return `pushing ${VERIFIED_REF} was refused`
  yield* git(checkouts.dotfiles, ["update-ref", VERIFIED_REF, tag.value])
  return `recorded the verified target: dotfiles ${target.dotfiles.slice(0, 10)}, fork ${target.fork.slice(0, 10)} (${batch})`
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
      const record = Effect.fn("Fleet.record")(function* (input: { readonly directory: Option.Option<string>; readonly batch: string }) {
        if (Option.isNone(checkouts) || Option.isNone(input.directory)) return
        const outcome = yield* recordTarget(checkouts.value, input.directory.value, input.batch).pipe(Effect.orElseSucceed(() => "recording the verified target failed"))
        yield* Effect.logInfo(`fleet: ${outcome}`)
      })
      return Fleet.of({ record: (input) => record(input).pipe(one.withPermits(1), Effect.forkDetach, Effect.asVoid) })
    }),
  )
