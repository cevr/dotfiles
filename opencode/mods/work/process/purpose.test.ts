// @reads all
// @reads-reason subprocess reads at mods/work/process/command.ts: try: () => Bun.spawn([...argv], { cwd, env: { ...base, ...extra }, stdin: "ignore", stdout: "pi
// A lane's mark over real Git, in a scratch repository: `markBranch` sets it on the branch checked out, `madeOnOf`
// reads it back through a merge of main, a rebase onto main, a rebase stopped on a conflict (detached), a switch to
// another branch; a copy of the lane carries the mark with the lane's path, and never reads it as its own.
import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { gitInit, withProcessEnv } from "../../../tests/git-repo.ts"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { scratch } from "../../../tests/scratch.ts"
import { commands } from "./command.ts"
import { madeOnIn, madeOnOf, markBranch } from "./purpose.ts"

const ENV = {
  GIT_AUTHOR_NAME: "Mark Test",
  GIT_AUTHOR_EMAIL: "mark@example.invalid",
  GIT_COMMITTER_NAME: "Mark Test",
  GIT_COMMITTER_EMAIL: "mark@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
}

const { run, spawn } = commands(ENV)
const git = (path: string, ...args: ReadonlyArray<string>) => run(["git", "-C", path, ...args], path)
const runner = { git, spawn }
const sh = (path: string, ...args: ReadonlyArray<string>) => git(path, ...args).pipe(Effect.orDie)
const write = (path: string, text: string) => run(["sh", "-c", 'printf "%s\\n" "$1" > "$2"', "write", text, path], "/").pipe(Effect.orDie)
const madeOn = (path: string) => madeOnOf(runner, path).pipe(Effect.orDie)

effectTest(
  "a lane's mark is kept through a merge of main, a rebase, a rebase stopped on a conflict and a switch; a copy never reads its source's",
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.sync(() => scratch("lane-mark-")),
        (made) => Effect.sync(() => made[Symbol.dispose]()),
      )
      const lane = `${dir.path}/lane`
      gitInit(lane, ["-q", "-b", "main"], withProcessEnv(ENV))
      yield* write(`${lane}/notes.txt`, "base")
      yield* sh(lane, "add", "notes.txt")
      yield* sh(lane, "commit", "-q", "-m", "base")
      yield* sh(lane, "switch", "-q", "-c", "feat/ui.input")
      expect(yield* madeOn(lane)).toEqual(Option.none())
      yield* markBranch(runner, lane)
      expect(yield* madeOn(lane)).toEqual(Option.some("feat/ui.input"))
      yield* write(`${lane}/lane.txt`, "lane")
      yield* sh(lane, "add", "lane.txt")
      yield* sh(lane, "commit", "-q", "-m", "lane")
      // main moves on; the lane merges it, then rebases onto it.
      yield* sh(lane, "switch", "-q", "main")
      yield* write(`${lane}/main.txt`, "main")
      yield* sh(lane, "add", "main.txt")
      yield* sh(lane, "commit", "-q", "-m", "main")
      yield* sh(lane, "switch", "-q", "feat/ui.input")
      yield* sh(lane, "merge", "-q", "--no-edit", "main")
      expect(yield* madeOn(lane)).toEqual(Option.some("feat/ui.input"))
      yield* sh(lane, "reset", "-q", "--hard", "HEAD~1")
      yield* sh(lane, "rebase", "-q", "main")
      expect([(yield* sh(lane, "branch", "--show-current")).trim(), yield* madeOn(lane)]).toEqual(["feat/ui.input", Option.some("feat/ui.input")])
      // A rebase stopped on a conflict leaves the lane detached; the mark still names its branch.
      yield* write(`${lane}/notes.txt`, "lane's notes")
      yield* sh(lane, "commit", "-q", "-am", "lane notes")
      yield* sh(lane, "switch", "-q", "main")
      yield* write(`${lane}/notes.txt`, "main's notes")
      yield* sh(lane, "commit", "-q", "-am", "main notes")
      yield* sh(lane, "switch", "-q", "feat/ui.input")
      expect((yield* spawn(["git", "-C", lane, "rebase", "-q", "main"], lane)).code).not.toBe(0)
      expect([(yield* sh(lane, "branch", "--show-current")).trim(), yield* madeOn(lane)]).toEqual(["", Option.some("feat/ui.input")])
      expect(yield* Effect.flip(markBranch(runner, lane))).toMatchObject({ message: expect.stringContaining("is detached") })
      yield* sh(lane, "rebase", "--abort")
      // Switched to another branch, it is still marked as made on its own.
      yield* sh(lane, "switch", "-q", "-c", "wf10/ui-hover-areas")
      expect(yield* madeOn(lane)).toEqual(Option.some("feat/ui.input"))
      // A workspace copied from the lane (as work copies one, Git config and all) carries the mark, which names the
      // lane's path: never read as the copy's.
      const child = `${dir.path}/child`
      yield* run(["cp", "-R", lane, child], dir.path).pipe(Effect.orDie)
      expect(yield* sh(child, "config", "branch.feat/ui.input.orchestrate-lane")).toBe(`${lane}\n`)
      expect(yield* madeOn(child)).toEqual(Option.none())
    }),
  ),
  30_000,
)

test("madeOnIn reads the branch whose mark names the path, a branch with dots and slashes whole", () => {
  const lines = ["branch.feat/a.orchestrate-lane /x/other", "branch.wf10/ui.input.orchestrate-lane /x/lane", ""].join("\n")
  expect(madeOnIn(lines, "/x/lane")).toEqual(Option.some("wf10/ui.input"))
  expect(madeOnIn(lines, "/x/none")).toEqual(Option.none())
  expect(madeOnIn("", "/x/lane")).toEqual(Option.none())
})
