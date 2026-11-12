import { describe, expect, test } from "bun:test"
import { argv, spawnSync, write } from "bun"
import { Effect, Exit } from "effect"
import { UpdateFailed } from "../service.ts"
import { dailyBuild, type ForkBuild, stageFork, suffixOf } from "./pin.ts"

/** Git with no config of the owner's: no signing, no hooks, a fixed identity. */
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
}

/** The Bun running this test. */
const BUN = argv[0]

const sh = (cwd: string, command: ReadonlyArray<string>) => spawnSync([...command], { cwd, env: GIT_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" }).stdout.toString().trim()

const files = (root: string, entries: ReadonlyArray<readonly [string, string]>) =>
  Effect.forEach(entries, ([path, text]) => Effect.promise(() => write(`${root}/${path}`, text, { createPath: true })), { discard: true })

/**
 * A scratch fork checkout as the incident had it: commit T, the verified target, then U, a later
 * commit (post-land's upstream merge), checked out on prime-look with an uncommitted change to a
 * tracked file. Its root installs with its lockfile; packages/cli names version 2.2.7.
 */
const scratch = Effect.gen(function* () {
  const root = sh(".", ["mktemp", "-d", "-t", "update-pin"])
  const fork = `${root}/fork`
  sh(root, ["git", "init", "-q", "-b", "prime-look", "fork"])
  yield* files(fork, [
    [".gitignore", "node_modules\n"],
    ["package.json", `{ "name": "fork", "private": true, "dependencies": {} }`],
    ["packages/cli/package.json", `{ "name": "cli", "version": "2.2.7" }`],
    ["src.txt", "target\n"],
  ])
  expect(spawnSync([BUN, "install"], { cwd: fork, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0)
  sh(fork, ["git", "add", "-A"])
  sh(fork, ["git", "commit", "-qm", "T"])
  const target = sh(fork, ["git", "rev-parse", "HEAD"])
  yield* files(fork, [["src.txt", "upstream merge\n"]])
  sh(fork, ["git", "commit", "-qam", "U"])
  const ahead = sh(fork, ["git", "rev-parse", "HEAD"])
  yield* files(fork, [["src.txt", "work in progress\n"]])
  return { root, fork, tree: `${root}/fork-build`, target, ahead }
})

/**
 * A build that stands in for the fork's release build: it reads the commit and `src.txt` of the
 * directory it was given, and writes a binary that says `opencode v<version>`, or `v<says>` when set.
 */
const fakeBuild = (root: string, says?: string) => {
  const seen: Array<{ readonly dir: string; readonly head: string; readonly src: string }> = []
  const build: ForkBuild = {
    build: (dir, version) =>
      Effect.gen(function* () {
        seen.push({ dir, head: sh(dir, ["git", "rev-parse", "HEAD"]), src: sh(dir, ["cat", "src.txt"]) })
        const binary = `${root}/bin/opencode`
        yield* files(root, [["bin/opencode", `#!/bin/sh\necho "opencode v${says ?? version}"\n`]])
        sh(root, ["chmod", "755", binary])
        return binary
      }),
    report: (binary) => Effect.sync(() => sh("/", [binary, "--version"])),
  }
  return { build, seen }
}

const pin = (paths: { readonly fork: string; readonly tree: string }, commit: string) => ({ ...paths, commit, bun: BUN, env: GIT_ENV })

describe("the stage builds exactly the target's fork commit", () => {
  test(
    "acceptance: with the fork checkout's HEAD past the target and a tracked file changed, the stage builds the target in its own tree, the binary names the target, and the checkout is left as it was",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, tree, target, ahead } = yield* scratch
          const { build, seen } = fakeBuild(root)
          const staged = yield* stageFork(pin({ fork, tree }, target), build)
          expect(staged.commit).toBe(target)
          expect(staged.version).toBe(`2.2.7-prime.${target.slice(0, 8)}`)
          expect(suffixOf(staged.reported)).toEqual(suffixOf(`-prime.${target.slice(0, 8)}`))
          expect(seen).toEqual([{ dir: tree, head: target, src: "target" }])
          expect(sh(fork, ["git", "rev-parse", "HEAD"])).toBe(ahead)
          expect(sh(fork, ["git", "branch", "--show-current"])).toBe("prime-look")
          expect(sh(fork, ["cat", "src.txt"])).toBe("work in progress")
          spawnSync(["rm", "-rf", root])
        }),
      ),
    60_000,
  )

  test(
    "the next stage moves the same tree to its target, whatever the last build left in it",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, tree, target, ahead } = yield* scratch
          const { build, seen } = fakeBuild(root)
          yield* stageFork(pin({ fork, tree }, target), build)
          yield* files(tree, [["src.txt", "left by the last build\n"]])
          const staged = yield* stageFork(pin({ fork, tree }, ahead), build)
          expect(staged.commit).toBe(ahead)
          expect(seen.at(-1)).toEqual({ dir: tree, head: ahead, src: "upstream merge" })
          spawnSync(["rm", "-rf", root])
        }),
      ),
    60_000,
  )

  test(
    "a binary whose version names another commit fails the stage, saying so",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, tree, target, ahead } = yield* scratch
          const { build } = fakeBuild(root, `2.2.7-prime.${ahead.slice(0, 8)}`)
          const exit = yield* stageFork(pin({ fork, tree }, target), build).pipe(Effect.exit)
          expect(exit).toEqual(
            Exit.fail(new UpdateFailed({ step: "check the build's version", message: `${root}/bin/opencode reports opencode v2.2.7-prime.${ahead.slice(0, 8)}, not the fork commit ${target.slice(0, 8)} it was built from: nothing staged` })),
          )
          spawnSync(["rm", "-rf", root])
        }),
      ),
    60_000,
  )

  test(
    "a target the fork checkout lacks fails the stage before any build",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, tree } = yield* scratch
          const { build, seen } = fakeBuild(root)
          const exit = yield* stageFork(pin({ fork, tree }, "0123456789abcdef0123456789abcdef01234567"), build).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(seen).toEqual([])
          spawnSync(["rm", "-rf", root])
        }),
      ),
    60_000,
  )
})

describe("daily's build", () => {
  test(
    "with --fork-target it builds the target in the tree; with none, the checkout as it stands; the record's commit is the one built",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, tree, target, ahead } = yield* scratch
          const { build, seen } = fakeBuild(root)
          const lines: Array<string> = []
          const options = { fork, tree, bun: BUN, build, log: (line: string) => lines.push(line) }
          expect((yield* dailyBuild({ ...options, commit: [target] })).commit).toBe(target)
          expect((yield* dailyBuild({ ...options, commit: [] })).commit).toBe(ahead)
          expect(seen.map((each) => [each.dir, each.head])).toEqual([
            [tree, target],
            [fork, ahead],
          ])
          expect(lines).toEqual([`building the target's fork ${target.slice(0, 10)} in ${tree}, pinned there`, `building ${fork} as it stands`])
          spawnSync(["rm", "-rf", root])
        }),
      ),
    60_000,
  )

  test(
    "a failure names its step in its message, for daily's output and the stage log",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, tree, target, ahead } = yield* scratch
          const { build } = fakeBuild(root, `2.2.7-prime.${ahead.slice(0, 8)}`)
          const exit = yield* dailyBuild({ fork, tree, bun: BUN, build, log: () => {}, commit: [target] }).pipe(Effect.flip)
          expect(exit.message).toStartWith("check the build's version: ")
          spawnSync(["rm", "-rf", root])
        }),
      ),
    60_000,
  )
})
