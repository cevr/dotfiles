// Real git checkouts in a scratch directory, read through git: a branch one
// commit ahead of its upstream and one behind with every kind of change, an
// unborn branch, a directory in no checkout and one that is gone. git runs
// with no global or system config, so the user's own settings change nothing.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { gitInit } from "../../../tests/git-repo.ts"
import { checkoutsLaws } from "../laws.ts"
import * as GitCheckouts from "./checkouts.ts"

const scratch = Effect.acquireRelease(
  Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "git-checkouts-")))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const envOf = (dir: string) => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CEILING_DIRECTORIES: dir,
  GIT_AUTHOR_NAME: "Law",
  GIT_AUTHOR_EMAIL: "law@example.com",
  GIT_COMMITTER_NAME: "Law",
  GIT_COMMITTER_EMAIL: "law@example.com",
})

const git = (env: Record<string, string | undefined>, cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.sync(() => Bun.spawnSync(["git", ...args], { cwd, env, stdout: "ignore", stderr: "pipe" })).pipe(
    Effect.flatMap((run) =>
      run.exitCode === 0 ? Effect.void : Effect.die(new Error(`git ${args.join(" ")} exited ${run.exitCode}: ${run.stderr.toString()}`)),
    ),
  )

checkoutsLaws(
  "git's Checkouts",
  Effect.gen(function* () {
    const dir = yield* scratch
    const env = envOf(dir)
    const repository = join(dir, "repository")
    const remote = join(dir, "remote.git")
    const unborn = join(dir, "unborn")
    const outside = join(dir, "outside")
    for (const each of [repository, unborn, outside]) mkdirSync(each)
    const at = (...args: ReadonlyArray<string>) => git(env, repository, ...args)

    gitInit(remote, ["-q", "--bare", "-b", "main"], env)
    gitInit(repository, ["-q", "-b", "main"], env)
    writeFileSync(join(repository, "a.txt"), "one\n")
    writeFileSync(join(repository, "old.txt"), "same\nlines\n")
    yield* at("add", ".")
    yield* at("commit", "-q", "-m", "base")
    writeFileSync(join(repository, "upstream.txt"), "theirs\n")
    yield* at("add", ".")
    yield* at("commit", "-q", "-m", "upstream only")
    yield* at("remote", "add", "origin", remote)
    yield* at("push", "-q", "origin", "main")
    yield* at("checkout", "-q", "-b", "feature", "main~1")
    yield* at("branch", "-q", "--set-upstream-to=origin/main")
    writeFileSync(join(repository, "feature.txt"), "ours\n")
    yield* at("add", ".")
    yield* at("commit", "-q", "-m", "feature only")

    writeFileSync(join(repository, "a.txt"), "uno\n")
    yield* at("mv", "old.txt", "moved.txt")
    writeFileSync(join(repository, "staged.txt"), "1\n2\n3\n")
    yield* at("add", "staged.txt")
    writeFileSync(join(repository, "new.txt"), "first\nsecond")
    writeFileSync(join(repository, "logo.bin"), new Uint8Array([0x89, 0x50, 0x00, 0x01, 0x00]))
    const nested = join(repository, "nested")
    mkdirSync(nested)

    gitInit(unborn, ["-q", "-b", "main"], env)
    writeFileSync(join(unborn, "first.txt"), "only line\n")
    yield* git(env, unborn, "add", "first.txt")

    return {
      layer: GitCheckouts.layer(env),
      repository,
      nested,
      unborn,
      outside,
      gone: join(dir, "gone"),
      write: Effect.sync(() => writeFileSync(join(repository, "later.txt"), "later\n")),
      spoil: Effect.sync(() => writeFileSync(join(repository, ".git/index"), "not an index")),
    }
  }),
)
