// verify:doctor's `fork-branch` check (scripts/verify.ts `forkLag`) on real scratch repositories: a fork worktree
// detached behind its `prime-look` branch, or behind origin's, is reported; one at or past them, or with no such
// branch, passes. Batch 2026-11-16cv ran every check on a worktree one merge behind the branch it claimed.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { gitInit, withProcessEnv } from "../tests/git-repo.ts"
import { forkLag } from "./verify.ts"

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" }

/** Git in `repo`: its output, trimmed. */
const git = (repo: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const said = yield* spawner.string(ChildProcess.make("git", ["-C", repo, ...args], { env: IDENTITY, extendEnv: true, stdin: "ignore", forceKillAfter: "1 second" }))
    return said.trim()
  })

/** A fork: `prime-look` two commits long, the worktree detached at the first; origin's branch where `origin` says. */
const forkAt = (dir: string) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => gitInit(dir, ["-q", "-b", "prime-look"], withProcessEnv(IDENTITY)))
    yield* git(dir, "commit", "-q", "--allow-empty", "-m", "base")
    const base = yield* git(dir, "rev-parse", "HEAD")
    yield* git(dir, "commit", "-q", "--allow-empty", "-m", "upstream merge")
    const tip = yield* git(dir, "rev-parse", "HEAD")
    yield* git(dir, "checkout", "-q", "--detach", base)
    return { base, tip }
  })

/** What the check says: passed, or its failure's words. */
const said = (fork: string) =>
  forkLag(fork).pipe(
    Effect.map((detail) => ({ ok: true, detail })),
    Effect.catch((error) => Effect.succeed({ ok: false, detail: error.message })),
  )

describe("verify:doctor's fork-branch check", () => {
  it.live.layer(BunServices.layer)("a worktree behind prime-look or origin's is reported; at or past them, or with neither, it passes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "verify-fork-" })
      const { base, tip } = yield* forkAt(dir)

      const behind = yield* said(dir)
      expect(behind.ok).toBe(false)
      expect(behind.detail).toContain(`the fork's worktree ${base.slice(0, 10)} is 1 commit(s) behind prime-look`)

      yield* git(dir, "checkout", "-q", "--detach", tip)
      expect(yield* said(dir)).toEqual({ ok: true, detail: `${tip.slice(0, 10)}, at or past prime-look` })

      // origin's branch ahead of the local one: behind it is reported too.
      yield* git(dir, "commit", "-q", "--allow-empty", "-m", "on origin")
      yield* git(dir, "update-ref", "refs/remotes/origin/prime-look", "HEAD")
      yield* git(dir, "checkout", "-q", "--detach", tip)
      expect((yield* said(dir)).detail).toContain("1 commit(s) behind origin/prime-look")

      // A checkout with no prime-look branch at all is not compared.
      yield* git(dir, "branch", "-q", "-m", "prime-look", "other")
      yield* git(dir, "update-ref", "-d", "refs/remotes/origin/prime-look")
      expect((yield* said(dir)).ok).toBe(true)
    }).pipe(Effect.scoped),
  )
})
