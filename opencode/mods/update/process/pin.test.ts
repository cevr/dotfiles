// @reads all
// @reads-reason subprocess reads at mods/update/process/pin.test.ts: spawnSync(["rm", "-rf", root])
import { describe, expect, test } from "bun:test"
import { argv, env, spawnSync, write } from "bun"
import { gitInit } from "../../../tests/git-repo.ts"
import { Builder, UpdateFailed } from "../service.ts"
import * as Builders from "./builder.ts"
import { settingsFor } from "./install.ts"
import { Array as Arr, Effect, Exit, Match, Option } from "effect"
import { buildName, buildVersion } from "../builds.ts"
import { dailyBuild, FLOOR_STEP, type ForkBuild, PLATFORM_FLOOR, requireFloor, stageFork, suffixOf, versionOf } from "./pin.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"

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

/** A stage's pin: `floor` is the scratch fork's own floor, its first commit unless a test names another. */
const pin = (paths: { readonly fork: string; readonly tree: string; readonly floor: string }, commit: string) => ({ ...paths, commit, dotfiles: DOTFILES, bun: BUN, env: GIT_ENV })

describe("the version names the build's fork commit and dotfiles commit", () => {
  const hex = (seed: number) => Array.from({ length: 40 }, (_, at) => "0123456789abcdef"[(seed * 7 + at * 13 + ((seed * at) % 11)) % 16]).join("")
  const BASES = ["2.2.7", "10.0.12", "2.3.0-beta.1", "1.0.0-rc.2.x"]

  test("acceptance: versionOf(base, fork, dotfiles) round-trips through suffixOf and the build's file name (buildVersion)", () => {
    for (const base of BASES)
      for (let seed = 0; seed < 50; seed++) {
        const [fork, dotfiles] = [hex(seed), hex(seed + 1000)]
        const version = versionOf(base, fork, dotfiles)
        expect(version).toBe(`${base}-prime.${fork.slice(0, 8)}.${dotfiles.slice(0, 8)}.tree`)
        expect(suffixOf(version)).toEqual(Option.some(`${fork.slice(0, 8)}.${dotfiles.slice(0, 8)}.tree`))
        expect(suffixOf(`opencode v${version}\n`)).toEqual(suffixOf(version))
        expect(buildVersion(buildName(version))).toEqual(Option.some(version))
      }
  })

  test("a dotfiles-only update is another version; the same pair is the same version", () => {
    const fork = hex(1)
    expect(versionOf("2.2.7", fork, hex(2))).not.toBe(versionOf("2.2.7", fork, hex(3)))
    expect(versionOf("2.2.7", fork, hex(2))).toBe(versionOf("2.2.7", fork, hex(2)))
  })

  test("every build is a tree build: of the same commits as an older build without the mark, it is another version, at another path", () => {
    const [fork, dotfiles] = [hex(1), hex(2)]
    const tree = versionOf("2.2.7", fork, dotfiles)
    const older = `2.2.7-prime.${fork.slice(0, 8)}.${dotfiles.slice(0, 8)}`
    expect(tree).toBe(`${older}.tree`)
    expect(buildName(tree)).not.toBe(buildName(older))
    expect(buildVersion(buildName(older))).toEqual(Option.some(older))
    // A binary built without its mark is not the tree build the stage asked for.
    expect(suffixOf(older)).not.toEqual(suffixOf(tree))
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
          expect(version).toBe(versionOf("2.2.7", target, DOTFILES))
          expect(version.endsWith(".tree")).toBe(true)
          spawnSync(["rm", "-rf", root])
        }),
      ),
    hangGuard("process-fixture"),
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
          const staged = yield* stageFork(pin({ fork, tree, floor: target }, target), build)
          expect(staged.commit).toBe(target)
          expect(staged.version).toBe(`2.2.7-prime.${target.slice(0, 8)}.${D8}.tree`)
          expect(suffixOf(staged.reported)).toEqual(Option.some(`${target.slice(0, 8)}.${D8}.tree`))
          expect(seen).toEqual([{ dir: tree, head: target, src: "target" }])
          expect(sh(fork, ["git", "rev-parse", "HEAD"])).toBe(ahead)
          expect(sh(fork, ["git", "branch", "--show-current"])).toBe("prime-look")
          expect(sh(fork, ["cat", "src.txt"])).toBe("work in progress")
          spawnSync(["rm", "-rf", root])
        }),
      ),
    hangGuard("process-fixture"),
  )

  test(
    "the next stage moves the same tree to its target, whatever the last build left in it",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, tree, target, ahead } = yield* scratch
          const { build, seen } = fakeBuild(root)
          yield* stageFork(pin({ fork, tree, floor: target }, target), build)
          yield* files(tree, [["src.txt", "left by the last build\n"]])
          const staged = yield* stageFork(pin({ fork, tree, floor: target }, ahead), build)
          expect(staged.commit).toBe(ahead)
          expect(seen.at(-1)).toEqual({ dir: tree, head: ahead, src: "upstream merge" })
          spawnSync(["rm", "-rf", root])
        }),
      ),
    hangGuard("process-fixture"),
  )

  test(
    "a binary whose version names another commit, of the fork or of the dotfiles, or the fork's alone, or lacks the tree mark, fails the stage, saying so",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, tree, target, ahead } = yield* scratch
          const wrong = [`2.2.7-prime.${ahead.slice(0, 8)}.${D8}`, `2.2.7-prime.${target.slice(0, 8)}.0badc0de`, `2.2.7-prime.${target.slice(0, 8)}`, `2.2.7-prime.${target.slice(0, 8)}.${D8}`]
          for (const says of wrong) {
            const exit = yield* stageFork(pin({ fork, tree, floor: target }, target), fakeBuild(root, says).build).pipe(Effect.exit)
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
    hangGuard("process-fixture"),
  )

  test(
    "a target the fork checkout lacks fails the stage before any build",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, tree, target } = yield* scratch
          const { build, seen } = fakeBuild(root)
          const exit = yield* stageFork(pin({ fork, tree, floor: target }, "0123456789abcdef0123456789abcdef01234567"), build).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(seen).toEqual([])
          spawnSync(["rm", "-rf", root])
        }),
      ),
    hangGuard("process-fixture"),
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
          const options = { fork, tree, floor: target, dotfiles: DOTFILES, bun: BUN, build, log: (line: string) => lines.push(line) }
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
    hangGuard("process-fixture"),
  )

  test(
    "a failure names its step in its message, for daily's output and the stage log",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, tree, target, ahead } = yield* scratch
          const { build } = fakeBuild(root, `2.2.7-prime.${ahead.slice(0, 8)}`)
          const exit = yield* dailyBuild({ fork, tree, floor: target, dotfiles: DOTFILES, bun: BUN, build, log: () => {}, commit: [target] }).pipe(Effect.flip)
          expect(exit.message).toStartWith("check the build's version: ")
          spawnSync(["rm", "-rf", root])
        }),
      ),
    hangGuard("process-fixture"),
  )

  test(
    "a dotfiles commit that is no commit (empty, short, not hex) builds nothing",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, fork, tree, target } = yield* scratch
          const { build, seen } = fakeBuild(root)
          for (const dotfiles of ["", "d0f11e5", "HEAD~1-not-a-sha"]) {
            const exit = yield* dailyBuild({ fork, tree, floor: target, dotfiles, bun: BUN, build, log: () => {}, commit: [] }).pipe(Effect.flip)
            expect(exit.message).toStartWith("name the build: ")
          }
          expect(seen).toEqual([])
          spawnSync(["rm", "-rf", root])
        }),
      ),
    hangGuard("process-fixture"),
  )
})

/** A 40-hex commit no scratch repository holds. */
const ABSENT = "0123456789abcdef0123456789abcdef01234567"
const ABSENT_FLOOR = "fedcba9876543210fedcba9876543210fedcba98"

/**
 * A scratch fork whose history has every relation a target can have to its floor: `base`, then `pre`
 * (an ancestor of the floor), the `floor`, `after` and `later` on prime-look (its HEAD), and
 * `divergent`, a branch off `pre` that never meets the floor.
 */
const history = Effect.gen(function* () {
  const root = sh(".", ["mktemp", "-d", "-t", "update-floor"])
  const fork = `${root}/fork`
  gitInit(fork, ["-q", "-b", "prime-look"], GIT_ENV)
  yield* files(fork, [
    [".gitignore", "node_modules\n"],
    ["package.json", `{ "name": "fork", "private": true, "dependencies": {} }`],
    ["packages/cli/package.json", `{ "name": "cli", "version": "2.3.0" }`],
    ["src.txt", "base\n"],
  ])
  expect(spawnSync([BUN, "install"], { cwd: fork, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0)
  sh(fork, ["git", "add", "-A"])
  sh(fork, ["git", "commit", "-qm", "base"])
  const commit = (label: string) =>
    files(fork, [["src.txt", `${label}\n`]]).pipe(
      Effect.map(() => {
        sh(fork, ["git", "commit", "-qam", label])
        return sh(fork, ["git", "rev-parse", "HEAD"])
      }),
    )
  const base = sh(fork, ["git", "rev-parse", "HEAD"])
  const pre = yield* commit("pre")
  const floor = yield* commit("floor")
  const after = yield* commit("after")
  const later = yield* commit("later")
  sh(fork, ["git", "checkout", "-q", "-b", "divergent", pre])
  const divergent = yield* commit("divergent")
  sh(fork, ["git", "checkout", "-q", "prime-look"])
  return { root, fork, base, pre, floor, after, later, divergent }
})

const dirExists = (path: string) => spawnSync(["test", "-e", path]).exitCode === 0

describe("the stage builds only a fork that has the platform floor in its history", () => {
  test("the floor is the fork commit that brings the plugin platform, in full", () => {
    expect(PLATFORM_FLOOR).toMatch(/^[0-9a-f]{40}$/)
    expect(PLATFORM_FLOOR.startsWith("c1e978ca")).toBe(true)
  })

  test(
    "acceptance: over every relation, checkout and floor generated together, the guard passes exactly when the target descends from the floor, answering it in full, and otherwise fails at its step naming the required and the actual commit",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const h = yield* history
          // The simple predicate: what each target names, and whether that has the floor in its history, by construction.
          const targets: ReadonlyArray<{ readonly relation: string; readonly name: string; readonly is: Option.Option<string>; readonly descends: boolean }> = [
            { relation: "self", name: h.floor, is: Option.some(h.floor), descends: true },
            { relation: "self, abbreviated", name: h.floor.slice(0, 12), is: Option.some(h.floor), descends: true },
            { relation: "descendant", name: h.after, is: Option.some(h.after), descends: true },
            { relation: "descendant, the checkout's HEAD", name: "HEAD", is: Option.some(h.later), descends: true },
            { relation: "pre-floor", name: h.pre, is: Option.some(h.pre), descends: false },
            { relation: "pre-floor root", name: h.base, is: Option.some(h.base), descends: false },
            { relation: "divergent", name: h.divergent, is: Option.some(h.divergent), descends: false },
            { relation: "missing", name: ABSENT, is: Option.none(), descends: false },
            { relation: "invalid", name: "not-a-commit", is: Option.none(), descends: false },
            { relation: "empty", name: "", is: Option.none(), descends: false },
          ]
          const checkouts = [
            { name: "the fork", cwd: h.fork, works: true },
            { name: "no repository", cwd: h.root, works: false },
            { name: "no directory (git error)", cwd: `${h.root}/absent`, works: false },
          ]
          const floors = [
            { name: "the floor", floor: h.floor, held: true },
            { name: "a floor the checkout lacks", floor: ABSENT_FLOOR, held: false },
          ]
          let passed = 0
          let refused = 0
          for (const target of targets)
            for (const checkout of checkouts)
              for (const floor of floors) {
                const exit = yield* requireFloor({ cwd: checkout.cwd, env: GIT_ENV }, floor.floor, target.name).pipe(Effect.exit)
                const compatible = checkout.works && floor.held && target.descends
                const label = `${target.relation} in ${checkout.name} against ${floor.name}`
                if (compatible) {
                  passed++
                  expect([label, exit]).toEqual([label, Exit.succeed(Option.getOrThrow(target.is))])
                  continue
                }
                refused++
                expect([label, Exit.isFailure(exit)]).toEqual([label, true])
                const failure = yield* Effect.flip(requireFloor({ cwd: checkout.cwd, env: GIT_ENV }, floor.floor, target.name))
                expect([label, failure.step]).toEqual([label, FLOOR_STEP])
                expect([label, failure.message.includes(floor.floor)]).toEqual([label, true])
                // The actual commit: in full once it resolves, else as the target named it.
                const actual = Option.getOrElse(Option.filter(target.is, () => checkout.works), () => target.name)
                expect([label, failure.message.includes(`the target's fork ${actual} `)]).toEqual([label, true])
                expect(failure.message.endsWith("nothing built or staged")).toBe(true)
              }
          expect([passed, refused]).toEqual([4, targets.length * checkouts.length * floors.length - 4])
          spawnSync(["rm", "-rf", h.root])
        }),
      ),
    hangGuard("process-fixture"),
  )

  test(
    "the ancestry step's every exit class: 0 answers the commit, 1 is 'does not have it', and 128, a signal or a git that cannot start refuse as unchecked, each at the step naming both commits",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const h = yield* history
          const bin = `${h.root}/bin`
          const log = `${h.root}/git.log`
          const git = Option.getOrThrow(Option.fromNullishOr(Bun.which("git")))
          // A git first and alone on PATH: `merge-base` exits as PIN_MERGE_BASE says (or kills itself); with `gone`, the floor's
          // rev-parse takes this git away after it answers, so the ancestry step cannot start one. Every other call is the real git's.
          const wrapper = [
            "#!/bin/sh",
            `printf '%s\\n' "$1" >> "${log}"`,
            `if [ "$1" = merge-base ]; then case "$PIN_MERGE_BASE" in signal) kill -KILL $$ ;; gone) ;; *) exit "$PIN_MERGE_BASE" ;; esac; fi`,
            `if [ "$PIN_MERGE_BASE" = gone ] && [ "$1" = rev-parse ] && [ "$4" = "$PIN_FLOOR^{commit}" ]; then /bin/rm -f "$0"; fi`,
            `exec "${git}" "$@"`,
          ].join("\n")
          const classes = [
            // The real answer turned over each way: exit 0 on a pre-floor commit passes it (the guard reads git's verdict), exit 1 on a descendant refuses it.
            { exit: "0", target: h.pre, verdict: Option.some(h.pre), why: "", ran: true },
            { exit: "1", target: h.after, verdict: Option.none<string>(), why: "does not have it", ran: true },
            { exit: "128", target: h.after, verdict: Option.none<string>(), why: "could not be checked (exit 128)", ran: true },
            { exit: "signal", target: h.after, verdict: Option.none<string>(), why: "could not be checked (exit 137)", ran: true },
            { exit: "gone", target: h.after, verdict: Option.none<string>(), why: "could not be checked (", ran: false },
          ]
          for (const each of classes) {
            yield* files(h.root, [
              ["bin/git", `${wrapper}\n`],
              ["git.log", ""],
            ])
            sh(h.root, ["chmod", "755", `${bin}/git`])
            const at = { cwd: h.fork, env: { ...GIT_ENV, PATH: bin, PIN_MERGE_BASE: each.exit, PIN_FLOOR: h.floor } }
            const exit = yield* requireFloor(at, h.floor, each.target).pipe(Effect.exit)
            const calls = sh(h.root, ["cat", log]).split("\n")
            expect([each.exit, calls.includes("merge-base")]).toEqual([each.exit, each.ran])
            if (Option.isSome(each.verdict)) {
              expect([each.exit, exit]).toEqual([each.exit, Exit.succeed(each.verdict.value)])
              continue
            }
            expect([each.exit, Exit.isFailure(exit)]).toEqual([each.exit, true])
            const failure = yield* Effect.flip(Effect.suspend(() => exit))
            expect([each.exit, failure.step]).toEqual([each.exit, FLOOR_STEP])
            expect([each.exit, failure.message]).toEqual([each.exit, expect.stringContaining(`the fork must have ${h.floor} `)])
            expect([each.exit, failure.message]).toEqual([each.exit, expect.stringContaining(`the target's fork ${each.target} ${each.why}`)])
            expect(failure.message.endsWith("nothing built or staged")).toBe(true)
          }
          expect(dirExists(`${bin}/git`)).toBe(false)
          spawnSync(["rm", "-rf", h.root])
        }),
      ),
    hangGuard("process-fixture"),
  )

  test(
    "a refused stage moves no build tree, makes none, installs nothing and builds nothing; daily's build of the checkout as it stands is held to the floor too",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const h = yield* history
          const tree = `${h.root}/fork-build`
          const { build, seen } = fakeBuild(h.root)
          const at = (commit: string, floor = h.floor) => pin({ fork: h.fork, tree, floor }, commit)
          // A refusal with no build tree yet makes none.
          const first = yield* stageFork(at(h.pre), build).pipe(Effect.flip)
          expect(first.step).toBe(FLOOR_STEP)
          expect(dirExists(tree)).toBe(false)
          // A descendant builds and leaves the tree at it, installed.
          expect((yield* stageFork(at(h.after), build)).commit).toBe(h.after)
          const worktrees = sh(h.fork, ["git", "worktree", "list", "--porcelain"])
          const installed = sh(tree, ["ls", "-a"])
          for (const [commit, floor] of [
            [h.pre, h.floor],
            [h.base, h.floor],
            [h.divergent, h.floor],
            [ABSENT, h.floor],
            [h.later, ABSENT_FLOOR],
          ] as const) {
            const refusal = yield* stageFork(at(commit, floor), build).pipe(Effect.flip)
            expect([commit, refusal.step]).toEqual([commit, FLOOR_STEP])
            expect(sh(tree, ["git", "rev-parse", "HEAD"])).toBe(h.after)
            expect(sh(tree, ["ls", "-a"])).toBe(installed)
            expect(sh(h.fork, ["git", "worktree", "list", "--porcelain"])).toBe(worktrees)
          }
          expect(seen.map((each) => each.head)).toEqual([h.after])
          // daily's build with no target: the checkout's HEAD (later) builds against the floor, not against one it lacks.
          const lines: Array<string> = []
          const options = { fork: h.fork, tree, dotfiles: DOTFILES, bun: BUN, build, log: (line: string) => lines.push(line), commit: [] }
          const held = yield* dailyBuild({ ...options, floor: ABSENT_FLOOR }).pipe(Effect.flip)
          expect(held.message).toStartWith(`${FLOOR_STEP}: the fork must have ${ABSENT_FLOOR}`)
          expect(seen.length).toBe(1)
          expect((yield* dailyBuild({ ...options, floor: h.floor })).commit).toBe(h.later)
          spawnSync(["rm", "-rf", h.root])
        }),
      ),
    hangGuard("process-fixture"),
  )
})

/** A seeded generator, so a failing history replays (mulberry32). */
const seeded = (seed: number) => {
  let state = seed >>> 0
  return (below: number) => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return (((mixed ^ (mixed >>> 14)) >>> 0) % below) | 0
  }
}

/** The fork half of a pair, by its relation to the floor (`history`), and a commit the checkout lacks. */
type Fork = "pre" | "floor" | "after" | "divergent" | "missing"
const FORKS: ReadonlyArray<Fork> = ["pre", "floor", "after", "divergent", "missing"]
/** The simple predicate: a fork has the platform when it descends from the floor. */
const platform = (fork: Fork) => fork === "floor" || fork === "after"

/**
 * The dotfiles half: an old tree (before this unit) has no guard and needs no platform; the floor tree
 * (this unit) has the guard and needs none; a consumer tree has the guard and needs the platform.
 */
type Tree = "old" | "floor" | "consumer"
const TREES: ReadonlyArray<Tree> = ["old", "floor", "consumer"]
const TREE_RULES = {
  old: { guarded: false, needs: false },
  floor: { guarded: true, needs: false },
  consumer: { guarded: true, needs: true },
} satisfies { readonly [tree in Tree]: { readonly guarded: boolean; readonly needs: boolean } }

interface Build {
  readonly tree: Tree
  readonly fork: Fork
}
const compatible = (build: Build) => !TREE_RULES[build.tree].needs || platform(build.fork)
const OLD_PAIR: Build = { tree: "old", fork: "pre" }

/** One host's slots, as the record and the launcher hold them. */
interface Slots {
  readonly current: Build
  readonly prior: Build
  readonly staged: Option.Option<Build>
  readonly launcher: string
  readonly writes: number
}
const launcherOf = (build: Build) => `t:${build.tree}/${build.fork}`

/** What the histories saw, so each kind of step is known to have happened. */
interface Tally {
  oldRestaged: number
  floorRefused: number
  rollbacks: number
}

/** The handoff: the staged build installed in the record, the launcher on it. */
const handoffOf = (slots: Slots): Slots =>
  Option.match(slots.staged, {
    onNone: () => slots,
    onSome: (build) => ({ current: build, prior: slots.current, staged: Option.none(), launcher: launcherOf(build), writes: slots.writes + 1 }),
  })

/** The rollback: a record write back to the prior build; nothing stages, so no guard runs. */
const rollbackOf = (slots: Slots): Slots => ({ ...slots, current: slots.prior, launcher: launcherOf(slots.prior), writes: slots.writes + 1 })

/** A stage (or the retry of a refused one): staged when the target tree's check admits it, else nothing changes. */
const stageOf = (slots: Slots, build: Build, admits: (build: Build) => boolean, tally: Tally): Slots => {
  if (!admits(build)) {
    if (build.tree === "floor" && !platform(build.fork)) tally.floorRefused++
    return slots
  }
  if (build.tree === "old" && !platform(build.fork)) tally.oldRestaged++
  return { ...slots, staged: Option.some(build) }
}

/** One seeded history of 16 steps over two hosts, each step's slots checked against the predicate. */
const runHistory = (seed: number, admits: (build: Build) => boolean, tally: Tally) => {
  const pick = seeded(seed)
  const hosts: Array<Slots> = [0, 1].map(() => ({ current: OLD_PAIR, prior: OLD_PAIR, staged: Option.none(), launcher: launcherOf(OLD_PAIR), writes: 0 }))
  let refusedLast = Option.none<Build>()
  for (let step = 0; step < 16; step++) {
    const at = pick(2)
    const before = Option.getOrThrow(Arr.get(hosts, at))
    const op = pick(4)
    const fresh: Build = { tree: Option.getOrThrow(Arr.get(TREES, pick(TREES.length))), fork: Option.getOrThrow(Arr.get(FORKS, pick(FORKS.length))) }
    const tried = Option.getOrElse(Option.filter(refusedLast, () => op === 3), () => fresh)
    const after = Match.value(op).pipe(
      Match.when(1, () => handoffOf(before)),
      Match.when(2, () => {
        tally.rollbacks++
        return rollbackOf(before)
      }),
      Match.orElse(() => stageOf(before, tried, admits, tally)),
    )
    if ((op === 0 || op === 3) && !admits(tried)) {
      refusedLast = Option.some(tried)
      // A refusal writes no record and moves no launcher.
      expect(after).toEqual(before)
    }
    hosts[at] = after
    const label = `seed ${seed} step ${step}`
    expect([label, compatible(after.current), compatible(after.prior), !Option.exists(after.staged, (build) => !compatible(build))]).toEqual([label, true, true, true])
  }
}

describe("stage, handoff, retry and rollback histories keep every build slot a compatible pair (mods/update/plugin-platform.qnt)", () => {
  test(
    "acceptance: with the real guard as each new tree's check and none in an old tree's, no generated history ever leaves an incompatible build current, prior or staged; a refusal writes no record and moves no launcher; an old pair always restages; a rollback runs no guard",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const h = yield* history
          // The real guard's verdict on each fork commit a target can name, against the simple predicate.
          const commits = { pre: h.pre, floor: h.floor, after: h.after, divergent: h.divergent, missing: ABSENT } satisfies { readonly [fork in Fork]: string }
          const verdicts = yield* Effect.forEach(FORKS, (fork) => requireFloor({ cwd: h.fork, env: GIT_ENV }, h.floor, commits[fork]).pipe(Effect.exit, Effect.map((exit) => [fork, Exit.isSuccess(exit)] as const)))
          const guard = new Map(verdicts)
          expect(verdicts).toEqual(FORKS.map((fork) => [fork, platform(fork)] as const))
          // Production's stage runs the target tree's own daily (`treeStageCommand`), so the guard that runs is the target tree's.
          const settings = settingsFor({ host: "t", home: h.root, state: `${h.root}/state`, checkout: `${h.root}/dotfiles`, fork: h.fork, bun: BUN, resident: `${h.root}/r`, launcher: `${h.root}/bin/opencode` })
          expect(Builders.treeStageCommand(settings, `${h.root}/share/t.plugins`, h.floor, DOTFILES)[1]).toBe(`${h.root}/share/t.plugins/opencode/scripts/daily.ts`)
          // Every tree's stage fails on a commit the checkout lacks; only a guarded tree's on a fork below the floor.
          const admits = (build: Build) => build.fork !== "missing" && (!TREE_RULES[build.tree].guarded || guard.get(build.fork) === true)
          const tally: Tally = { oldRestaged: 0, floorRefused: 0, rollbacks: 0 }
          for (let seed = 1; seed <= 200; seed++) runHistory(seed, admits, tally)
          expect(tally.oldRestaged).toBeGreaterThan(0)
          expect(tally.floorRefused).toBeGreaterThan(0)
          expect(tally.rollbacks).toBeGreaterThan(0)
          spawnSync(["rm", "-rf", h.root])
        }),
      ),
    hangGuard("process-fixture"),
  )
})

describe("the real fork against the floor", () => {
  const dev = Option.fromNullishOr(env.OPENCODE_DEV)
  test.skipIf(Option.isNone(dev))("the installed fork b26585f6 is below the floor; where the checkout has the floor, it and its descendants pass", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const at = { cwd: Option.getOrElse(dev, () => "/nonexistent/loop-probe-x"), env: GIT_ENV }
        const refused = yield* requireFloor(at, PLATFORM_FLOOR, "b26585f6d31581bd78b3fe49d2d68b678a023dd4").pipe(Effect.flip)
        expect(refused.step).toBe(FLOOR_STEP)
        expect(refused.message).toContain(PLATFORM_FLOOR)
        const held = spawnSync(["git", "cat-file", "-e", `${PLATFORM_FLOOR}^{commit}`], { cwd: at.cwd, env: GIT_ENV }).exitCode === 0
        if (held) expect(yield* requireFloor(at, PLATFORM_FLOOR, PLATFORM_FLOOR)).toBe(PLATFORM_FLOOR)
        if (held) expect((yield* requireFloor(at, PLATFORM_FLOOR, `${PLATFORM_FLOOR}~1`).pipe(Effect.flip)).message).toContain("does not have it")
        // The fork unit's accepted head, e6782b3a, where the checkout has it.
        const accepted = "e6782b3af238afee6e16ebbcb3ae0d8700aeb1df"
        if (held && spawnSync(["git", "cat-file", "-e", `${accepted}^{commit}`], { cwd: at.cwd, env: GIT_ENV }).exitCode === 0) expect(yield* requireFloor(at, PLATFORM_FLOOR, accepted)).toBe(accepted)
      }),
    ),
  )
})
