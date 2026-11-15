// The default branch read by git in scratch repositories, against the memory line the simulated tests use: the same
// history answers the same tip, merges and ancestry in both. Then git's fallbacks (origin, main, master, none) and the
// batch file's Heads line as the fleet's reader takes it.
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { env } from "node:process"
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Result } from "effect"
import { gitInit } from "../../../tests/git-repo.ts"
import { scratch } from "../../../tests/scratch.ts"
import * as MemoryMainLine from "../memory/main-line.ts"
import { MainLine } from "../service.ts"
import { mainBatchText } from "../tools.ts"
import { headsOf } from "./fleet.ts"
import * as GitMainLine from "./main-line.ts"

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" }

/** Git in `repo`: its output, trimmed. */
const git = (repo: string, args: ReadonlyArray<string>) =>
  execFileSync("git", ["-C", repo, ...args], { input: "", env: { ...env, ...IDENTITY }, stdio: ["pipe", "pipe", "ignore"] }).toString().trim()

/** The lines the memory adapter answers, by checkout: each repository a test makes is put here as git holds it. */
const LINES = new Map<string, MemoryMainLine.Branch>()

/** A repository named `name` in `root` on `branch`: a root commit, then each of `merges` as a --no-ff merge of one branch commit. */
const repository = (root: string, name: string, branch: string, merges: number) => {
  const repo = join(root, name)
  mkdirSync(repo)
  gitInit(repo, ["-q", "-b", branch])
  const tree = git(repo, ["mktree"])
  const commit = (parents: ReadonlyArray<string>, message: string) => git(repo, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message])
  const first = commit([], "root")
  const line: Array<MemoryMainLine.Entry> = [{ sha: first, subject: "root", merged: [] }]
  const tips: Array<string> = []
  const at = { head: first }
  for (let n = 0; n < merges; n += 1) {
    const tip = commit([at.head], `tip ${n}`)
    tips.push(tip)
    at.head = commit([at.head, tip], `Merge branch 'feat/u${n}'`)
    line.push({ sha: at.head, subject: `Merge branch 'feat/u${n}'`, merged: [tip] })
  }
  git(repo, ["update-ref", `refs/heads/${branch}`, at.head])
  LINES.set(repo, { branch, line })
  return { repo, line, tips, head: at.head }
}

const shaAt = (line: ReadonlyArray<MemoryMainLine.Entry>, index: number) => line[index]?.sha ?? ""

/** A test's program over the MainLine a layer builds, in a scratch dir that lives until it ends. */
const run = <A,>(layer: Layer.Layer<MainLine>, body: (main: MainLine["Service"], root: string) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(Effect.sync(() => scratch("main-line-")), (dir) => Effect.sync(() => dir[Symbol.dispose]()))
        return yield* body(Context.get(yield* Layer.build(layer), MainLine), root.path)
      }),
    ),
  )

const ADAPTERS: ReadonlyArray<readonly [string, Layer.Layer<MainLine>]> = [
  ["git", GitMainLine.layer],
  ["memory", MemoryMainLine.layer((checkout) => Option.fromUndefinedOr(LINES.get(checkout)))],
]

for (const [name, adapter] of ADAPTERS)
  describe(`MainLine (${name})`, () => {
    test("one history answers git's tip, merges and ancestry", () =>
      run(adapter, (main, root) =>
        Effect.gen(function* () {
          const { repo, line, tips, head } = repository(root, "same", "main", 7)
          const answers = yield* Effect.all({
            tip: main.tip(repo, Option.none()),
            at: main.tip(repo, Option.some(shaAt(line, 3))),
            all: main.merges(repo, head, Option.none(), 100),
            six: main.merges(repo, head, Option.none(), 6),
            since: main.merges(repo, head, Option.some(shaAt(line, 4)), 100),
            holdsTip: main.holds(repo, tips[2] ?? "", head),
            holdsLater: main.holds(repo, tips[5] ?? "", shaAt(line, 3)),
            commit: main.commitOf(repo, head),
          })
          expect(answers.tip).toEqual(Option.some({ branch: "main", head }))
          expect(answers.at).toEqual(Option.some({ branch: "main", head: shaAt(line, 3) }))
          expect(answers.all.map((merge) => merge.sha)).toEqual(line.slice(1).map((entry) => entry.sha).toReversed())
          expect(answers.all.map((merge) => merge.parent)).toEqual(line.slice(0, -1).map((entry) => entry.sha).toReversed())
          expect(answers.all[0]?.subject).toBe("Merge branch 'feat/u6'")
          expect(answers.six).toHaveLength(6)
          expect(answers.since.map((merge) => merge.sha)).toEqual(line.slice(5).map((entry) => entry.sha).toReversed())
          expect([answers.holdsTip, answers.holdsLater]).toEqual([true, false])
          expect(answers.commit).toEqual(Option.some(head))
        }),
      ))
  })

describe("MainLine (git only)", () => {
  test("the default branch is origin's, else main, else master; none outside a repository or with neither", () =>
    run(GitMainLine.layer, (main, root) =>
      Effect.gen(function* () {
        const master = repository(root, "master", "master", 1)
        expect(yield* main.tip(master.repo, Option.none())).toEqual(Option.some({ branch: "master", head: master.head }))
        const trunk = repository(root, "trunk", "trunk", 1)
        expect(yield* main.tip(trunk.repo, Option.none())).toEqual(Option.none())
        // origin's default branch, as the checkout last fetched it, wins over a local main that moved on.
        const both = repository(root, "origin", "main", 3)
        const behind = shaAt(both.line, 1)
        git(both.repo, ["update-ref", "refs/remotes/origin/main", behind])
        git(both.repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
        expect(yield* main.tip(both.repo, Option.none())).toEqual(Option.some({ branch: "main", head: behind }))
        expect(yield* main.tip(both.repo, Option.some("f".repeat(40)))).toEqual(Option.none())
        const plain = join(root, "plain")
        mkdirSync(plain)
        expect(yield* Effect.all([main.tip(plain, Option.none()), main.merges(plain, "HEAD", Option.none(), 5), main.holds(plain, "a", "b")])).toEqual([Option.none(), [], false])
      }),
    ))

  test("a batch file's Heads line, from commits git resolved, is the one line the fleet's reader takes", () =>
    run(GitMainLine.layer, (main, root) =>
      Effect.gen(function* () {
        const { repo, head, line } = repository(root, "heads", "main", 2)
        const heads = Option.all(yield* Effect.all({ dotfiles: main.commitOf(repo, head), fork: main.commitOf(repo, "HEAD~0") }))
        const text = mainBatchText({ name: `main-${head.slice(0, 7)}`, base: shaAt(line, 0), head, last: Option.none(), merges: [], units: [], heads })
        expect(Option.isSome(heads)).toBe(true)
        expect(headsOf(text)).toEqual(Option.match(heads, { onNone: () => Result.fail("none"), onSome: (found) => Result.succeed(found) }))
      }),
    ))
})
