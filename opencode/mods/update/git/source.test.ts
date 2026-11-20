import { describe, expect, test } from "bun:test"
import { argv, env as hostEnv, file, spawnSync, write } from "bun"
import { Effect, Exit, Option } from "effect"
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
  }).pipe(Effect.provide(SourceLive.layer({ root, mode, bun: BUN, fork: "/nonexistent/loop-probe-x", env: GIT_ENV, bin: Option.none() })), Effect.exit)

/** The Mac's commands script run from the checkout at `root` as it stands, with no move. */
const macCommands = (root: string, env: Record<string, string>) =>
  Effect.gen(function* () {
    return yield* (yield* Source).commands
  }).pipe(Effect.provide(SourceLive.layer({ root, mode: "ff", bun: BUN, fork: "/nonexistent/loop-probe-x", env, bin: Option.some(SourceLive.MAC_BIN) })), Effect.exit)

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
    "W1: on the workbox a move installs the target's workbox/bin over a stale copy and runs apply-agent-settings; a removed script stays; a commit without the script moves too",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, a } = yield* scratch
          const repo = (path: string) => Effect.promise(() => file(new URL(`../../../../${path}`, import.meta.url)).text())
          const settings = yield* repo("workbox/bin/apply-agent-settings")
          // The target: the real install script and apply-agent-settings; the scripts it calls in the
          // checkout do nothing here, so no step touches this host's Claude or herdr.
          yield* files(root, [
            ["opencode/package.json", EMPTY_PACKAGE],
            ["workbox/install-bin.sh", yield* repo("workbox/install-bin.sh")],
            ["workbox/bin/apply-agent-settings", settings],
            ["claude/mods/fx-ui/install.sh", "#!/bin/sh\nexit 0\n"],
            ["claude/install-herdr-hook.sh", "#!/bin/sh\nexit 0\n"],
          ])
          sh(root, ["chmod", "755", "workbox/install-bin.sh", "workbox/bin/apply-agent-settings", "claude/mods/fx-ui/install.sh", "claude/install-herdr-hook.sh"])
          sh(root, ["git", "add", "-A"])
          sh(root, ["git", "commit", "-qm", "C"])
          const c = sh(root, ["git", "rev-parse", "HEAD"]).out
          sh(root, ["git", "reset", "-q", "--hard", a])
          // A fake home as the workbox has it: bootstrap's older apply-agent-settings, a script since
          // removed from workbox/bin, herdr, the synced settings, the dotfiles where the scripts look.
          const home = sh(".", ["mktemp", "-d", "-t", "update-source-home"]).out
          const stubs = `${home}/stubs`
          yield* files(home, [
            [".local/bin/apply-agent-settings", "#!/bin/sh\nexit 0\n"],
            [".local/bin/gone-script", "#!/bin/sh\nexit 0\n"],
            [".local/bin/herdr", "#!/bin/sh\nexit 0\n"],
            [".config/bite-workbox/settings-source/claude/settings.local.json", "{}"],
            [".config/bite-workbox/settings-source/claude/statusline-git.sh", "#!/bin/sh\n"],
            ["stubs/sudo", "#!/bin/sh\nexit 0\n"],
          ])
          sh(home, ["chmod", "755", ".local/bin/apply-agent-settings", ".local/bin/gone-script", ".local/bin/herdr", "stubs/sudo"])
          sh(home, ["mkdir", "-p", "Developer/personal"])
          sh(home, ["ln", "-s", root, "Developer/personal/dotfiles"])
          const env = { ...GIT_ENV, HOME: home, PATH: `${stubs}:${hostEnv.PATH ?? ""}` }
          const advanceTo = (target: string) =>
            Effect.gen(function* () {
              return yield* (yield* Source).advance(target)
            }).pipe(Effect.provide(SourceLive.layer({ root, mode: "reset", bun: BUN, fork: "/nonexistent/loop-probe-x", env, bin: Option.some(SourceLive.WORKBOX_BIN) })), Effect.exit)
          const moved = yield* advanceTo(c)
          expect(Exit.match(moved, { onSuccess: () => "installed", onFailure: String })).toBe("installed")
          expect(yield* Effect.promise(() => file(`${home}/.local/bin/apply-agent-settings`).text())).toBe(settings)
          expect(sh(home, ["readlink", ".local/bin/codex-bridge"]).out).toBe(`${home}/Developer/personal/dotfiles/claude/mods/codex/bridge/bridge.ts`)
          expect(yield* Effect.promise(() => file(`${home}/.local/bin/gone-script`).exists())).toBe(true)
          // A commit older than the install script (a rollback's) moves with nothing to install.
          expect(Exit.isSuccess(yield* advanceTo(a))).toBe(true)
          expect(sh(root, ["git", "rev-parse", "HEAD"]).out).toBe(a)
          spawnSync(["rm", "-rf", root, home])
        }),
      ),
    60_000,
  )

  for (const mode of ["ff", "reset"] as const) {
    test(
      `U1 (${mode}): an untracked copy of a file the target adds is the target's own and goes; an untracked file with other content refuses the move as CheckoutStuck, naming it, and nothing moves`,
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const { root, a } = yield* scratch
            const NOTE = "# The note the target adds\n"
            yield* files(root, [
              ["opencode/package.json", EMPTY_PACKAGE],
              ["docs/research/note.md", NOTE],
            ])
            sh(root, ["git", "add", "-A"])
            sh(root, ["git", "commit", "-qm", "C"])
            const c = sh(root, ["git", "rev-parse", "HEAD"]).out
            sh(root, ["git", "reset", "-q", "--hard", a])
            // The copy that came ahead of the commit, by hand or by Syncthing, byte for byte.
            yield* files(root, [["docs/research/note.md", NOTE]])
            expect(Exit.isSuccess(yield* advance(root, mode, c))).toBe(true)
            expect(sh(root, ["git", "rev-parse", "HEAD"]).out).toBe(c)
            expect(sh(root, ["git", "status", "--porcelain"]).out).toBe("")
            sh(root, ["git", "reset", "-q", "--hard", a])
            // Another file at that path: the owner's, so it stays, and the move waits for him.
            const OTHER = "# My own draft\n"
            yield* files(root, [["docs/research/note.md", OTHER]])
            const stuck = yield* advance(root, mode, c)
            if (mode === "reset") {
              // A reset follows the commit whatever the tree holds: the commit's file wins, as it always has there.
              expect(Exit.isSuccess(stuck)).toBe(true)
            } else {
              const error = Exit.findErrorOption(stuck)
              expect(Option.map(error, (each) => each._tag)).toEqual(Option.some("CheckoutStuck"))
              expect(Option.exists(error, (each) => each.message.includes("untracked files the target tracks with other content: docs/research/note.md"))).toBe(true)
              expect(sh(root, ["git", "rev-parse", "HEAD"]).out).toBe(a)
              expect(yield* Effect.promise(() => file(`${root}/docs/research/note.md`).text())).toBe(OTHER)
            }
            spawnSync(["rm", "-rf", root])
          }),
        ),
      60_000,
    )

    test(
      `U2 (${mode}): an untracked copy at a non-ASCII path, which git quotes without -z, is read as it is on disk: the target's own goes and the move goes through`,
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const { root, a } = yield* scratch
            const PATH = "docs/research/café — 説明.md"
            const NOTE = "# The note the target adds\n"
            yield* files(root, [
              ["opencode/package.json", EMPTY_PACKAGE],
              [PATH, NOTE],
            ])
            sh(root, ["git", "add", "-A"])
            sh(root, ["git", "commit", "-qm", "C"])
            const c = sh(root, ["git", "rev-parse", "HEAD"]).out
            sh(root, ["git", "reset", "-q", "--hard", a])
            yield* files(root, [[PATH, NOTE]])
            expect(Exit.isSuccess(yield* advance(root, mode, c))).toBe(true)
            expect(sh(root, ["git", "rev-parse", "HEAD"]).out).toBe(c)
            expect(sh(root, ["git", "status", "--porcelain"]).out).toBe("")
            expect(yield* Effect.promise(() => file(`${root}/${PATH}`).text())).toBe(NOTE)
            spawnSync(["rm", "-rf", root])
          }),
        ),
      60_000,
    )
  }

  test("M1: each host runs its own commands script: the workbox's on Linux, the Mac's on macOS, none elsewhere", () => {
    expect(SourceLive.binScript("linux")).toEqual(Option.some(SourceLive.WORKBOX_BIN))
    expect(SourceLive.binScript("darwin")).toEqual(Option.some(SourceLive.MAC_BIN))
    expect(SourceLive.binScript("win32")).toEqual(Option.none())
  })

  test(
    "M2: on the Mac a move links install.sh's commands into ~/.local/bin over a stale link, twice alike; a link no longer made stays; a commit without the script moves too",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, a } = yield* scratch
          const script = yield* Effect.promise(() => file(new URL("../../../../local-bin.sh", import.meta.url)).text())
          yield* files(root, [
            ["opencode/package.json", EMPTY_PACKAGE],
            ["local-bin.sh", script],
          ])
          sh(root, ["git", "add", "-A"])
          sh(root, ["git", "commit", "-qm", "C"])
          const c = sh(root, ["git", "rev-parse", "HEAD"]).out
          sh(root, ["git", "reset", "-q", "--hard", a])
          // The Mac before: install.sh ran before rex-show existed, a link to a since-moved file, and one
          // the script no longer makes.
          const home = sh(".", ["mktemp", "-d", "-t", "update-source-home"]).out
          sh(home, ["mkdir", "-p", ".local/bin"])
          sh(home, ["ln", "-s", "/nonexistent/loop-probe-x/hours", ".local/bin/hours"])
          sh(home, ["ln", "-s", "/nonexistent/loop-probe-x/gone", ".local/bin/gone"])
          const env = { ...GIT_ENV, HOME: home }
          const advanceTo = (target: string) =>
            Effect.gen(function* () {
              return yield* (yield* Source).advance(target)
            }).pipe(Effect.provide(SourceLive.layer({ root, mode: "ff", bun: BUN, fork: "/nonexistent/loop-probe-x", env, bin: Option.some(SourceLive.MAC_BIN) })), Effect.exit)
          const links = () =>
            ["hours", "codex-bridge", "rex-show", "gone"].map((name) => `${name} -> ${sh(home, ["readlink", `.local/bin/${name}`]).out}`)
          const expected = [
            `hours -> ${root}/skills/track-work-hours/scripts/hours`,
            `codex-bridge -> ${root}/claude/mods/codex/bridge/bridge.ts`,
            `rex-show -> ${root}/opencode/cmd/rex/show.ts`,
            "gone -> /nonexistent/loop-probe-x/gone",
          ]
          const moved = yield* advanceTo(c)
          expect(Exit.match(moved, { onSuccess: () => "installed", onFailure: String })).toBe("installed")
          expect(links()).toEqual(expected)
          expect(Exit.isSuccess(yield* advanceTo(c))).toBe(true)
          expect(links()).toEqual(expected)
          // A commit older than the script (a rollback's) moves with nothing to link.
          expect(Exit.isSuccess(yield* advanceTo(a))).toBe(true)
          expect(sh(root, ["git", "rev-parse", "HEAD"]).out).toBe(a)
          spawnSync(["rm", "-rf", root, home])
        }),
      ),
    60_000,
  )

  test(
    "a tree build's handoff runs the host's commands with no move: rex-show, part of the plugins, links through current.plugins once the installed build has a tree, the checkout's before",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, a } = yield* scratch
          const script = yield* Effect.promise(() => file(new URL("../../../../local-bin.sh", import.meta.url)).text())
          yield* files(root, [["local-bin.sh", script]])
          const home = sh(".", ["mktemp", "-d", "-t", "update-source-home"]).out
          const env = { ...GIT_ENV, HOME: home }
          const commands = macCommands(root, env)
          const rexShow = () => sh(home, ["readlink", ".local/bin/rex-show"]).out
          expect(Exit.isSuccess(yield* commands)).toBe(true)
          expect(rexShow()).toBe(`${root}/opencode/cmd/rex/show.ts`)
          // The installed build's tree, as the record write links it.
          const share = `${home}/.local/share/opencode-prime`
          yield* files(share, [["opencode-2.3.0-prime.aaaaaaaa.bbbbbbbb.tree.plugins/opencode/cmd/rex/show.ts", "// rex-show\n"]])
          sh(share, ["ln", "-s", "opencode-2.3.0-prime.aaaaaaaa.bbbbbbbb.tree.plugins", "current.plugins"])
          expect(Exit.isSuccess(yield* commands)).toBe(true)
          expect(rexShow()).toBe(`${share}/current.plugins/opencode/cmd/rex/show.ts`)
          expect(sh(home, ["readlink", ".local/bin/hours"]).out).toBe(`${root}/skills/track-work-hours/scripts/hours`)
          // No move: the checkout stays on its commit, with the script as it stands, uncommitted.
          expect(sh(root, ["git", "rev-parse", "HEAD"]).out).toBe(a)
          spawnSync(["rm", "-rf", root, home])
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
            }).pipe(Effect.provide(SourceLive.layer({ root: checkoutRoot, mode: "ff", bun: BUN, fork, env, bin: Option.none() })), Effect.exit)
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
