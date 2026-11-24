// @reads all
// @reads-reason nonliteral subprocess arguments at mods/orchestrate/git/main-line.test.ts: spawnSync(["git", "-C", repo, ...args], { env: ENV, stdin: "ignore", stdout: "pipe", stderr: "i
// The default branch read by git in scratch repositories this test makes with git plumbing and removes: the
// MainLine laws (laws.ts) over real git, as memory/main-line.test.ts runs them over the memory line.
import { env as processEnv, spawnSync, write } from "bun"
import { Effect } from "effect"
import { gitInit } from "../../../tests/git-repo.ts"
import { scratch } from "../../../tests/scratch.ts"
import { mainLineLaws } from "../laws.ts"
import * as GitMainLine from "./main-line.ts"

const ENV = {
  PATH: processEnv["PATH"] ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
}

/** Git in `repo`: its output, trimmed. */
const git = (repo: string, args: ReadonlyArray<string>) =>
  spawnSync(["git", "-C", repo, ...args], { env: ENV, stdin: "ignore", stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()

mainLineLaws(
  "git's MainLine over scratch repositories",
  Effect.gen(function* () {
    const held = yield* Effect.acquireRelease(
      Effect.sync(() => scratch("main-line-")),
      (dir) => Effect.sync(() => dir[Symbol.dispose]()),
    )
    return {
      layer: GitMainLine.layer,
      repository: (name: string, branch: string, merges: number) =>
        Effect.sync(() => {
          const checkout = `${held.path}/${name}`
          gitInit(checkout, ["-q", "-b", branch], ENV)
          const tree = git(checkout, ["mktree"])
          const commit = (parents: ReadonlyArray<string>, message: string) => git(checkout, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message])
          const line = [commit([], "root")]
          const tips: Array<string> = []
          for (let n = 0; n < merges; n += 1) {
            const head = line.at(-1) ?? ""
            const tip = commit([head], `tip ${n}`)
            tips.push(tip)
            line.push(commit([head, tip], `Merge branch 'feat/u${n}'`))
          }
          git(checkout, ["update-ref", `refs/heads/${branch}`, line.at(-1) ?? ""])
          return { checkout, line, tips }
        }),
      origin: (checkout: string, sha: string) =>
        Effect.sync(() => {
          git(checkout, ["update-ref", "refs/remotes/origin/main", sha])
          git(checkout, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
        }),
      plain: Effect.as(
        Effect.promise(() => write(`${held.path}/plain/.keep`, "", { createPath: true })),
        `${held.path}/plain`,
      ),
    }
  }),
)
