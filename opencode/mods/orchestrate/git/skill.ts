// The orchestrate skill as git sees it: the skill dir (`~/.claude/skills/
// orchestrate`, a link into the dotfiles checkout) resolved to the checkout,
// its version the newest commit that touched it, and the subjects of the
// commits between two versions. Any git failure is no answer.
import { realpath } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { Skill } from "../service.ts"

/** How long one git command may run. */
const TIMEOUT_MS = 10_000

/** At most this many subjects are read for an unrelated version. */
const NEWEST = 10

/** A git command's exit code and output in `cwd`; none when it cannot run. */
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise(async () => {
    const run = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(TIMEOUT_MS) })
    const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited])
    return { code, out }
  }).pipe(Effect.option)

const lines = (out: string) => out.split("\n").map((line) => line.trim()).filter((line) => line !== "")

/** The skill at `dir`, read through git in the checkout it resolves to. */
export const layer = (dir: string) => {
  const real = Effect.tryPromise(() => realpath(dir)).pipe(Effect.option)
  /** A git command in the skill's checkout, its output when it exits 0. */
  const run = (args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const cwd = yield* real
      if (cwd._tag === "None") return undefined
      const result = yield* git(cwd.value, args)
      return result._tag === "Some" && result.value.code === 0 ? result.value.out : undefined
    })
  /** Whether `ancestor` is an ancestor of `of`: git exits 0 for yes, 1 for no, else none. */
  const isAncestor = (ancestor: string, of: string) =>
    Effect.gen(function* () {
      const cwd = yield* real
      if (cwd._tag === "None") return undefined
      const result = yield* git(cwd.value, ["merge-base", "--is-ancestor", ancestor, of])
      if (result._tag === "None") return undefined
      return result.value.code === 0 ? true : result.value.code === 1 ? false : undefined
    })
  return Layer.succeed(Skill, {
    version: run(["log", "-1", "--format=%H", "--", "."]).pipe(
      Effect.map((out) => (out === undefined ? undefined : lines(out)[0])),
      Effect.withSpan("Skill.version"),
    ),
    relation: (seen, installed) =>
      Effect.gen(function* () {
        if (seen === installed) return { _tag: "Same" } as const
        const known = yield* run(["cat-file", "-e", `${seen}^{commit}`])
        if (known !== undefined) {
          const forward = yield* isAncestor(seen, installed)
          if (forward === undefined) return undefined
          if (forward) {
            const subjects = yield* run(["log", "--format=%s", `${seen}..${installed}`, "--", "."])
            if (subjects === undefined) return undefined
            const listed = lines(subjects)
            // A move that touched nothing in the skill reads as the same skill.
            return listed.length === 0 ? ({ _tag: "Same" } as const) : ({ _tag: "Newer", subjects: listed } as const)
          }
          if (yield* isAncestor(installed, seen)) return { _tag: "Older" } as const
        }
        const newest = yield* run(["log", `-${NEWEST}`, "--format=%s", installed, "--", "."])
        return newest === undefined ? undefined : ({ _tag: "Unrelated", subjects: lines(newest) } as const)
      }).pipe(Effect.withSpan("Skill.relation")),
  })
}
