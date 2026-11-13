import { describe, expect, test } from "bun:test"
import { argv, file, spawnSync, write } from "bun"
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
/** A package whose workspaces are its `mods/*`, as the dotfiles' opencode/ is. */
const WORKSPACES_PACKAGE = `{ "name": "scratch", "private": true, "workspaces": ["mods/*"] }`

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

  for (const mode of ["ff", "reset"] as const) {
    test(
      `R1 (${mode}): moving back past a commit that added a workspace package installs the older commit, frozen, with no trace of that package`,
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const root = sh(".", ["mktemp", "-d", "-t", "update-source"]).out
            gitInit(root, ["-q", "-b", "main"], GIT_ENV)
            yield* files(root, [
              [".gitignore", "node_modules\n"],
              ["opencode/package.json", WORKSPACES_PACKAGE],
              ["opencode/scripts/link-fork.ts", ""],
              ["opencode/mods/old/package.json", `{ "name": "old", "private": true }`],
            ])
            expect(sh(`${root}/opencode`, [BUN, "install"]).code).toBe(0)
            sh(root, ["git", "add", "-A"])
            sh(root, ["git", "commit", "-qm", "good"])
            const good = sh(root, ["git", "rev-parse", "HEAD"]).out
            // The newer commit adds a workspace package (as d2796409 added cmd/stall), installed there.
            yield* files(root, [["opencode/mods/added/package.json", `{ "name": "added", "private": true }`]])
            expect(sh(`${root}/opencode`, [BUN, "install"]).code).toBe(0)
            sh(root, ["git", "add", "-A"])
            sh(root, ["git", "commit", "-qm", "newer"])
            const exit = yield* advance(root, mode, good)
            expect(Exit.isSuccess(exit)).toBe(true)
            expect(sh(root, ["git", "rev-parse", "HEAD"]).out).toBe(good)
            expect(yield* Effect.promise(() => file(`${root}/opencode/mods/added/package.json`).exists())).toBe(false)
            expect(sh(root, ["git", "status", "--porcelain"]).out).toBe("")
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

  test(
    "a target whose sim-tui links the fork's protocol installs, and the next one too: the fork's modules stay as they were",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const root = sh(".", ["mktemp", "-d", "-t", "update-source"]).out
          const fork = `${root}/fork`
          // The fork: its TUI package installed (the plugin API in its @opencode scope, Solid, Effect), its protocol
          // package and the TUI's test folder, which sim-tui links besides the modules.
          yield* files(fork, [
            ["packages/tui/package.json", "{}"],
            ["packages/tui/node_modules/@opencode/plugin/package.json", "{}"],
            ["packages/tui/node_modules/solid-js/package.json", "{}"],
            ["packages/tui/node_modules/effect/package.json", "{}"],
            ["packages/protocol/package.json", "{}"],
            ["packages/tui/test/preload.ts", ""],
          ])
          const forkModules = () => sh(fork, ["find", "packages/tui/node_modules", "-print"]).out
          const before = forkModules()
          const checkoutRoot = `${root}/dotfiles`
          gitInit(checkoutRoot, ["-q", "-b", "main"], GIT_ENV)
          yield* files(checkoutRoot, [
            [".gitignore", "node_modules\n"],
            ["opencode/package.json", WORKSPACES_PACKAGE],
            ["opencode/scripts/link-fork.ts", yield* Effect.promise(() => file(new URL("../../../scripts/link-fork.ts", import.meta.url)).text())],
            ["opencode/scripts/fork.ts", yield* Effect.promise(() => file(new URL("../../../scripts/fork.ts", import.meta.url)).text())],
            ["opencode/sim-tui/package.json", `{ "name": "sim-tui", "private": true }`],
          ])
          expect(sh(`${checkoutRoot}/opencode`, [BUN, "install"]).code).toBe(0)
          sh(checkoutRoot, ["git", "add", "-A"])
          sh(checkoutRoot, ["git", "commit", "-qm", "A"])
          const commit = (name: string) => {
            spawnSync(["touch", `${checkoutRoot}/${name}`])
            sh(checkoutRoot, ["git", "add", "-A"])
            sh(checkoutRoot, ["git", "commit", "-qm", name])
            return sh(checkoutRoot, ["git", "rev-parse", "HEAD"]).out
          }
          const b = commit("b")
          const c = commit("c")
          sh(checkoutRoot, ["git", "reset", "-q", "--hard", "HEAD~2"])
          const env = { ...GIT_ENV, OPENCODE_FORK_ANCHORS: `${root}/anchors` }
          const advanceTo = (target: string) =>
            Effect.gen(function* () {
              return yield* (yield* Source).advance(target)
            }).pipe(Effect.provide(SourceLive.layer({ root: checkoutRoot, mode: "ff", bun: BUN, fork, env })), Effect.exit)
          expect(Exit.isSuccess(yield* advanceTo(b))).toBe(true)
          expect(forkModules()).toBe(before)
          // The next install's link-fork checks the fork first: a link written into it would fail it there.
          const next = yield* advanceTo(c)
          expect(Exit.match(next, { onSuccess: () => "installed", onFailure: String })).toBe("installed")
          expect(sh(checkoutRoot, ["git", "rev-parse", "HEAD"]).out).toBe(c)
          expect(forkModules()).toBe(before)
          expect(sh(checkoutRoot, ["realpath", "opencode/sim-tui/node_modules/@opencode/protocol"]).out).toBe(sh(fork, ["realpath", "packages/protocol"]).out)
          spawnSync(["rm", "-rf", root])
        }),
      ),
    60_000,
  )
})
