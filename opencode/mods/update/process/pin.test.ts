import { describe, expect, test } from "bun:test"
import { argv, spawnSync, write } from "bun"
import { gitInit } from "../../../tests/git-repo.ts"
import { Builder, UpdateFailed } from "../service.ts"
import * as Builders from "./builder.ts"
import { settingsFor } from "./install.ts"
import { Effect, Exit, Option } from "effect"
import { buildName, buildVersion } from "../builds.ts"
import { dailyBuild, type ForkBuild, stageFork, suffixOf, versionOf } from "./pin.ts"

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
  gitInit(fork, ["-q", "-b", "prime-look"], GIT_ENV)
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

/** The dotfiles commit every stage here names. */
const DOTFILES = "d0f11e5a1b2c3d4e5f60718293a4b5c6d7e8f901"
const D8 = DOTFILES.slice(0, 8)

const pin = (paths: { readonly fork: string; readonly tree: string }, commit: string) => ({ ...paths, commit, dotfiles: DOTFILES, withTree: false, bun: BUN, env: GIT_ENV })

describe("the version names the build's fork commit and dotfiles commit", () => {
  const hex = (seed: number) => Array.from({ length: 40 }, (_, at) => "0123456789abcdef"[(seed * 7 + at * 13 + ((seed * at) % 11)) % 16]).join("")
  const BASES = ["2.2.7", "10.0.12", "2.3.0-beta.1", "1.0.0-rc.2.x"]

  test("acceptance: versionOf(base, fork, dotfiles) round-trips through suffixOf and the build's file name (buildVersion)", () => {
    for (const base of BASES)
      for (let seed = 0; seed < 50; seed++) {
        const [fork, dotfiles] = [hex(seed), hex(seed + 1000)]
        const version = versionOf(base, fork, dotfiles)
        expect(version).toBe(`${base}-prime.${fork.slice(0, 8)}.${dotfiles.slice(0, 8)}`)
        expect(suffixOf(version)).toEqual(Option.some(`${fork.slice(0, 8)}.${dotfiles.slice(0, 8)}`))
        expect(suffixOf(`opencode v${version}\n`)).toEqual(suffixOf(version))
        expect(buildVersion(buildName(version))).toEqual(Option.some(version))
      }
  })

  test("a dotfiles-only update is another version; the same pair is the same version", () => {
    const fork = hex(1)
    expect(versionOf("2.2.7", fork, hex(2))).not.toBe(versionOf("2.2.7", fork, hex(3)))
    expect(versionOf("2.2.7", fork, hex(2))).toBe(versionOf("2.2.7", fork, hex(2)))
  })

  test("a tree build of the same commits is another version, at another path: it ends in .tree, which the suffix and the build grammar keep", () => {
    const [fork, dotfiles] = [hex(1), hex(2)]
    const tree = versionOf("2.2.7", fork, dotfiles, true)
    expect(tree).toBe(`${versionOf("2.2.7", fork, dotfiles)}.tree`)
    expect(buildName(tree)).not.toBe(buildName(versionOf("2.2.7", fork, dotfiles)))
    expect(buildVersion(buildName(tree))).toEqual(Option.some(tree))
    expect(suffixOf(`opencode v${tree}\n`)).toEqual(Option.some(`${fork.slice(0, 8)}.${dotfiles.slice(0, 8)}.tree`))
    // A binary built without its mark is not the tree build the stage asked for.
    expect(suffixOf(versionOf("2.2.7", fork, dotfiles))).not.toEqual(suffixOf(tree))
  })

  test("an old-format version (fork half alone) still reads: its suffix is the fork's eight, and its file is a build", () => {
    expect(suffixOf("opencode v2.2.5-prime.d22f11a9")).toEqual(Option.some("d22f11a9"))
    expect(buildVersion("opencode-2.2.5-prime.d22f11a9")).toEqual(Option.some("2.2.5-prime.d22f11a9"))
    expect(suffixOf("opencode vlocal")).toEqual(Option.none())
  })
})

/** The version the live builder names for the fork commit `fork` and this file's dotfiles commit. */
const builtVersion = (settings: Parameters<typeof Builders.layer>[0], fork: string) =>
  Builder.use((builder) => builder.version({ fork, dotfiles: DOTFILES, batch: "b" })).pipe(Effect.provide(Builders.layer(settings, GIT_ENV)))

describe("the updater's builder names a tree build", () => {
  test(
    "Builder.version reads the target's fork version at its commit and names the tree build: it ends in .tree, and is not the version of a plain build of the same commits",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, target } = yield* scratch
          const settings = settingsFor({ host: "test", home: root, state: `${root}/state`, checkout: `${root}/dotfiles`, fork, bun: BUN, resident: `${root}/resident`, launcher: `${root}/bin/opencode` })
          const version = yield* builtVersion(settings, target)
          expect(version).toBe(versionOf("2.2.7", target, DOTFILES, true))
          expect(version.endsWith(".tree")).toBe(true)
          expect(version).not.toBe(versionOf("2.2.7", target, DOTFILES))
          spawnSync(["rm", "-rf", root])
        }),
      ),
    60_000,
  )
})

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
          expect(staged.version).toBe(`2.2.7-prime.${target.slice(0, 8)}.${D8}`)
          expect(suffixOf(staged.reported)).toEqual(Option.some(`${target.slice(0, 8)}.${D8}`))
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
    "a binary whose version names another commit, of the fork or of the dotfiles, or the fork's alone, fails the stage, saying so",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, tree, target, ahead } = yield* scratch
          const wrong = [`2.2.7-prime.${ahead.slice(0, 8)}.${D8}`, `2.2.7-prime.${target.slice(0, 8)}.0badc0de`, `2.2.7-prime.${target.slice(0, 8)}`]
          for (const says of wrong) {
            const exit = yield* stageFork(pin({ fork, tree }, target), fakeBuild(root, says).build).pipe(Effect.exit)
            expect(exit).toEqual(
              Exit.fail(
                new UpdateFailed({
                  step: "check the build's version",
                  message: `${root}/bin/opencode reports opencode v${says}, not the fork commit ${target.slice(0, 8)} and dotfiles commit ${D8} it was built from: nothing staged`,
                }),
              ),
            )
          }
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
          const options = { fork, tree, dotfiles: DOTFILES, withTree: false, bun: BUN, build, log: (line: string) => lines.push(line) }
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
          const exit = yield* dailyBuild({ fork, tree, dotfiles: DOTFILES, withTree: false, bun: BUN, build, log: () => {}, commit: [target] }).pipe(Effect.flip)
          expect(exit.message).toStartWith("check the build's version: ")
          spawnSync(["rm", "-rf", root])
        }),
      ),
    60_000,
  )

  test(
    "a dotfiles commit that is no commit (empty, short, not hex) builds nothing",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, tree } = yield* scratch
          const { build, seen } = fakeBuild(root)
          for (const dotfiles of ["", "d0f11e5", "HEAD~1-not-a-sha"]) {
            const exit = yield* dailyBuild({ fork, tree, dotfiles, withTree: false, bun: BUN, build, log: () => {}, commit: [] }).pipe(Effect.flip)
            expect(exit.message).toStartWith("name the build: ")
          }
          expect(seen).toEqual([])
          spawnSync(["rm", "-rf", root])
        }),
      ),
    60_000,
  )
})
