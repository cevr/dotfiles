// RepoRoots over a scratch directory this test makes and removes: a
// repository, a directory in it, a plain directory, a missing path, and a
// directory with no permissions, whose `.git` cannot be looked for.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { repoRootsLaws } from "../laws.ts"
import { RepoRoots } from "../service.ts"
import * as FilesystemRepoRoots from "./repo-roots.ts"

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "guard-repo-roots-"))),
  (dir) =>
    Effect.sync(() => {
      if (existsSync(join(dir, "locked"))) chmodSync(join(dir, "locked"), 0o755)
      rmSync(dir, { recursive: true, force: true })
    }),
)

const bench = () =>
  Effect.gen(function* () {
    const dir = yield* scratch
    mkdirSync(join(dir, "repo/.git"), { recursive: true })
    mkdirSync(join(dir, "repo/src"))
    mkdirSync(join(dir, "plain"))
    mkdirSync(join(dir, "locked/inner"), { recursive: true })
    chmodSync(join(dir, "locked"), 0o000)
    // Root reads through any mode, so it cannot set up an unreadable path.
    const unreadable = process.getuid?.() === 0 ? {} : { unreadable: join(dir, "locked/inner") }
    return {
      layer: FilesystemRepoRoots.layer,
      repo: join(dir, "repo"),
      inside: join(dir, "repo/src"),
      plain: join(dir, "plain"),
      missing: join(dir, "nowhere"),
      ...unreadable,
    }
  })

repoRootsLaws("the filesystem's RepoRoots", bench)

describe("the filesystem's RepoRoots", () => {
  test("a worktree's `.git` file makes a root, and a path under a file is none", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* scratch
          mkdirSync(join(dir, "worktree"))
          writeFileSync(join(dir, "worktree/.git"), "gitdir: /elsewhere/.git/worktrees/w\n")
          writeFileSync(join(dir, "notes.txt"), "hi")
          const roots = yield* RepoRoots
          expect(yield* roots.isRoot(join(dir, "worktree"))).toBe(true)
          expect(yield* roots.isRoot(join(dir, "notes.txt"))).toBe(false)
        }).pipe(Effect.provide(FilesystemRepoRoots.layer)),
      ),
    ))
})
