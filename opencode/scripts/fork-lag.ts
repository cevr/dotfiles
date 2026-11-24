import { Array as Arr, Data, Effect } from "effect"

const BRANCH = "prime-look"

class ForkBehind extends Data.TaggedError("ForkBehind")<{ readonly message: string }> {}

/** Compare the fork checkout with its local and origin branches, ignoring absent refs. */
export const forkLagWith = <E, R>(read: (step: string, args: ReadonlyArray<string>) => Effect.Effect<string, E, R>) => Effect.gen(function* () {
  const refs = [
    { ref: BRANCH, full: `refs/heads/${BRANCH}` },
    { ref: `origin/${BRANCH}`, full: `refs/remotes/origin/${BRANCH}` },
  ]
  const counted = yield* Effect.forEach(
    refs,
    ({ ref, full }) => read("fork", ["rev-list", "--count", `HEAD..${full}`]).pipe(
      Effect.map((behind) => ({ ref, behind: Number(behind) })),
      Effect.option,
    ),
    { concurrency: 2 },
  )
  const lagging = Arr.getSomes(counted).filter((each) => each.behind > 0)
  const head = (yield* read("head", ["rev-parse", "HEAD"])).slice(0, 10)
  if (lagging.length === 0) return `${head}, at or past ${BRANCH}`
  const count = lagging.map((each) => `${each.behind} commit(s) behind ${each.ref}`).join(" and ")
  return yield* new ForkBehind({ message: `the fork's worktree ${head} is ${count}: check out ${BRANCH} at its head, so the checks run on it` })
})
