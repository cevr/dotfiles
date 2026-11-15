// The default branch of a checkout, read by git: its name and head, its first-parent merges, and ancestry. Every
// read is a git command at the call, local refs as they are; one that fails reads as none.
import { readableStreamToText, spawn } from "bun"
import { Effect, Layer, Option } from "effect"
import { MainLine } from "../service.ts"
import type { Merge } from "../tools.ts"

/** A finished git command: its exit code and its output, trimmed; none when it does not start. */
const run = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<Option.Option<{ readonly code: number; readonly text: string }>> =>
  Effect.try(() => spawn(["git", "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })).pipe(
    Effect.flatMap((child) => Effect.all({ code: Effect.tryPromise(() => child.exited), text: Effect.tryPromise(() => readableStreamToText(child.stdout)) }, { concurrency: 2 })),
    Effect.map(({ code, text }) => Option.some({ code, text: text.trim() })),
    Effect.orElseSucceed(() => Option.none()),
  )

/** A git command's output when it exits 0. */
const git = (cwd: string, args: ReadonlyArray<string>) => run(cwd, args).pipe(Effect.map((ran) => Option.map(Option.filter(ran, (each) => each.code === 0), (each) => each.text)))

const FULL = /^[0-9a-f]{40}$/

/** The full commit `rev` names in `cwd`. */
const commitAt = (cwd: string, rev: string) => git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).pipe(Effect.map(Option.filter((sha) => FULL.test(sha))))

/** The default branch: origin's (`origin/HEAD`'s target), else `main`, else `master`, by name and ref. */
const defaultBranch = Effect.fn("MainLine.defaultBranch")(function* (cwd: string) {
  const origin = yield* git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
  if (Option.isSome(origin) && Option.isSome(yield* commitAt(cwd, origin.value)))
    return Option.some({ branch: origin.value.replace(/^refs\/remotes\/origin\//, ""), ref: origin.value })
  for (const branch of ["main", "master"]) {
    if (Option.isSome(yield* commitAt(cwd, `refs/heads/${branch}`))) return Option.some({ branch, ref: `refs/heads/${branch}` })
  }
  return Option.none<{ readonly branch: string; readonly ref: string }>()
})

export const layer = Layer.succeed(
  MainLine,
  MainLine.of({
    tip: Effect.fn("MainLine.tip")(function* (checkout: string, at: Option.Option<string>) {
      const found = yield* defaultBranch(checkout)
      if (Option.isNone(found)) return Option.none()
      const head = yield* commitAt(checkout, Option.getOrElse(at, () => found.value.ref))
      return Option.map(head, (sha) => ({ branch: found.value.branch, head: sha }))
    }),
    merges: Effect.fn("MainLine.merges")(function* (checkout: string, head: string, base: Option.Option<string>, limit: number) {
      const range = Option.match(base, { onNone: () => head, onSome: (from) => `${from}..${head}` })
      const listed = yield* git(checkout, ["log", "--first-parent", "--merges", `--max-count=${limit}`, "--format=%H %P%x09%s", range, "--"])
      return Option.getOrElse(listed, () => "")
        .split("\n")
        .filter((line) => line !== "")
        .flatMap((line): ReadonlyArray<Merge> => {
          const [shas = "", subject = ""] = line.split("\t")
          const [sha = "", parent = ""] = shas.split(" ")
          return Option.toArray(Option.liftPredicate({ sha, parent, subject }, () => FULL.test(sha)))
        })
    }),
    holds: Effect.fn("MainLine.holds")(function* (checkout: string, commit: string, head: string) {
      const ran = yield* run(checkout, ["merge-base", "--is-ancestor", commit, head])
      return Option.exists(ran, (each) => each.code === 0)
    }),
    commitOf: (checkout, rev) => commitAt(checkout, rev),
  }),
)
