// The git mod's handlers: find the session's directory, read the checkout
// there, ask `gh` for the branch's request, and say how to review a file.
// Git decides nothing, so it has no aggregate: each answer is a read, and
// what could not be read is said in the answer rather than failed.
//
// `gh` asks the network, so its answers are kept by what the request follows
// (the checkout's root, branch, upstream and ahead/behind counts,
// checkout.ts's pullRequestKey): asked again when that moves or the answer is
// older than PULL_REQUEST_TTL, so checks and review show their changes. A
// missing `gh` is not asked for again while the server runs; a failure is
// asked again after FAILURE_TTL.
import { Cache, Context, Duration, Effect, Exit, Layer, Option, Result } from "effect"
import { pullRequestKey, rootOfKey } from "./checkout.ts"
import type { CheckoutAnswer, PullRequestAnswer, ReviewAnswer } from "./git.ts"
import { reviewOf } from "./review.ts"
import { Checkouts, Programs, PullRequests, SessionDirectories } from "./service.ts"

/** How long a pull request's answer stands before `gh` is asked again for the same key. */
export const PULL_REQUEST_TTL = Duration.seconds(60)
/** How long a `gh` failure stands before it is asked again. */
export const FAILURE_TTL = Duration.seconds(30)

export class Git extends Context.Service<
  Git,
  {
    /** The checkout the session's directory is in, nothing outside one, or why it could not be read. */
    readonly checkout: (sessionID: string) => Effect.Effect<CheckoutAnswer>
    /** The pull request of the session's branch, or nothing; `note` says why `gh` could not answer. */
    readonly pullRequest: (sessionID: string) => Effect.Effect<PullRequestAnswer>
    /** The command that reviews `path` of the session's checkout. */
    readonly review: (sessionID: string, path: string) => Effect.Effect<ReviewAnswer>
  }
>()("dotfiles-opencode/git/Git") {}

export const layer = Layer.effect(
  Git,
  Effect.gen(function* () {
    const directories = yield* SessionDirectories
    const checkouts = yield* Checkouts
    const pullRequests = yield* PullRequests
    const programs = yield* Programs

    /** The session's checkout: none outside one; a failure says what could not be read. */
    const read = (sessionID: string) =>
      directories.directoryOf(sessionID).pipe(
        Effect.flatMap(checkouts.read),
        Effect.mapError((error) => error.message),
      )

    const requests = yield* Cache.makeWith((key: string) => pullRequests.read(rootOfKey(key)), {
      capacity: 64,
      timeToLive: (exit) =>
        Exit.isSuccess(exit)
          ? PULL_REQUEST_TTL
          : Exit.findErrorOption(exit).pipe(Option.exists((error) => error._tag === "GhMissing"))
            ? Duration.infinity
            : FAILURE_TTL,
    })

    return {
      checkout: Effect.fn("Git.checkout")(function* (sessionID: string) {
        return yield* read(sessionID).pipe(
          Effect.match({
            onFailure: (error): CheckoutAnswer => ({ error }),
            onSuccess: (checkout): CheckoutAnswer => Option.match(checkout, { onNone: () => ({}), onSome: (value) => ({ checkout: value }) }),
          }),
        )
      }),
      pullRequest: Effect.fn("Git.pullRequest")(function* (sessionID: string) {
        const checkout = yield* read(sessionID).pipe(Effect.option, Effect.map(Option.flatten))
        const key = Option.flatMap(checkout, (value) => Option.fromUndefinedOr(pullRequestKey(value)))
        if (Option.isNone(key)) return {}
        return yield* Cache.get(requests, key.value).pipe(
          Effect.match({
            onSuccess: (pr): PullRequestAnswer => Option.match(pr, { onNone: () => ({}), onSome: (value) => ({ pullRequest: value }) }),
            onFailure: (error): PullRequestAnswer => (error._tag === "GhMissing" ? {} : { note: error.message }),
          }),
        )
      }),
      review: Effect.fn("Git.review")(function* (sessionID: string, path: string) {
        const checkout = yield* read(sessionID).pipe(Effect.result)
        if (Result.isFailure(checkout)) return { note: checkout.failure }
        if (Option.isNone(checkout.success)) return { note: "Not a git checkout" }
        return reviewOf(checkout.success.value, path, yield* programs.found("hunk"))
      }),
    }
  }),
)
