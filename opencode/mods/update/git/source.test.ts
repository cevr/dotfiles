import { describe, expect, test } from "bun:test"
import { argv, spawnSync, write } from "bun"
import { Effect, Exit } from "effect"
import { gitInit } from "../../../tests/git-repo.ts"
import { Source } from "../service.ts"
import * as SourceLive from "./source.ts"

/** Git with no config of the owner's: no signing, no hooks, a fixed identity. */
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
}

/** A package with no dependencies, and one whose dependency its lockfile lacks. */
const EMPTY_PACKAGE = `{ "name": "scratch", "private": true, "dependencies": {} }`
const MISSING_PACKAGE = `{ "name": "scratch", "private": true, "dependencies": { "missing": "file:./does-not-exist" } }`

/** The Bun running this test. */
const BUN = argv[0]

const sh = (cwd: string, command: ReadonlyArray<string>) => {
  const ran = spawnSync([...command], { cwd, env: GIT_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  return { code: ran.exitCode, out: ran.stdout.toString().trim() }
}

const files = (root: string, entries: ReadonlyArray<readonly [string, string]>) =>
  Effect.forEach(entries, ([path, text]) => Effect.promise(() => write(`${root}/${path}`, text, { createPath: true })), { discard: true })

/**
 * A scratch dotfiles checkout: commit A whose `opencode/` installs with its lockfile, and commit B
 * whose package.json names a dependency the lockfile lacks, so `bun install --frozen-lockfile`
 * fails there. The checkout stands at A.
 */
const scratch = Effect.gen(function* () {
  const root = sh(".", ["mktemp", "-d", "-t", "update-source"]).out
  gitInit(root, ["-q", "-b", "main"], GIT_ENV)
  yield* files(root, [
    [".gitignore", "node_modules\n"],
    ["opencode/package.json", EMPTY_PACKAGE],
    ["opencode/scripts/link-fork.ts", ""],
  ])
  expect(sh(`${root}/opencode`, [BUN, "install"]).code).toBe(0)
  sh(root, ["git", "add", "-A"])
  sh(root, ["git", "commit", "-qm", "A"])
  const a = sh(root, ["git", "rev-parse", "HEAD"]).out
  yield* files(root, [["opencode/package.json", MISSING_PACKAGE]])
  sh(root, ["git", "commit", "-qam", "B"])
  const b = sh(root, ["git", "rev-parse", "HEAD"]).out
  sh(root, ["git", "reset", "-q", "--hard", a])
  return { root, a, b }
})

const advance = (root: string, mode: "ff" | "reset", commit: string) =>
  Effect.gen(function* () {
    return yield* (yield* Source).advance(commit)
  }).pipe(Effect.provide(SourceLive.layer({ root, mode, bun: BUN, fork: "/nonexistent/loop-probe-x", env: GIT_ENV })), Effect.exit)

describe("the advance step over real git and bun", () => {
  for (const mode of ["ff", "reset"] as const) {
    test(
      `M2 (${mode}): a commit whose frozen install fails moves the checkout back to the commit it was on, and the advance fails`,
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const { root, a, b } = yield* scratch
            const exit = yield* advance(root, mode, b)
            expect(Exit.isFailure(exit)).toBe(true)
            expect(sh(root, ["git", "rev-parse", "HEAD"]).out).toBe(a)
            expect(sh(root, ["git", "status", "--porcelain", "--untracked-files=no"]).out).toBe("")
            spawnSync(["rm", "-rf", root])
          }),
        ),
      60_000,
    )
  }

  test(
    "a commit that installs is where the checkout stays",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, a, b } = yield* scratch
          sh(root, ["git", "reset", "-q", "--hard", b])
          yield* files(root, [["opencode/package.json", EMPTY_PACKAGE]])
          sh(root, ["git", "commit", "-qam", "C"])
          const c = sh(root, ["git", "rev-parse", "HEAD"]).out
          sh(root, ["git", "reset", "-q", "--hard", a])
          expect(Exit.isSuccess(yield* advance(root, "ff", c))).toBe(true)
          expect(sh(root, ["git", "rev-parse", "HEAD"]).out).toBe(c)
          spawnSync(["rm", "-rf", root])
        }),
      ),
    60_000,
  )
})
