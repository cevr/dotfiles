// @reads all
// @reads-reason subprocess reads at mods/update/git/source.test.ts: spawnSync(["rm", "-rf", root, home])
import { describe, expect, test } from "bun:test"
import { env as hostEnv, file, spawnSync, write } from "bun"
import { Effect, Exit, Option } from "effect"
import { gitInit } from "../../../tests/git-repo.ts"
import { matchingInput } from "../../../tests/read-path.ts"
import { Source } from "../service.ts"
import * as SourceLive from "./source.ts"
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

const sh = (cwd: string, command: ReadonlyArray<string>) => {
  const ran = spawnSync([...command], { cwd, env: GIT_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  return { code: ran.exitCode, out: ran.stdout.toString().trim() }
}

const files = (root: string, entries: ReadonlyArray<readonly [string, string]>) =>
  Effect.forEach(entries, ([path, text]) => Effect.promise(() => write(`${root}/${path}`, text, { createPath: true })), { discard: true })

/** A scratch dotfiles checkout with one commit, A, holding the Mac's commands script as the repo has it. */
const scratch = Effect.gen(function* () {
  const root = sh(".", ["mktemp", "-d", "-t", "update-source"]).out
  gitInit(root, ["-q", "-b", "main"], GIT_ENV)
  const script = yield* Effect.promise(() => file(new URL("../../../../local-bin.sh", import.meta.url)).text())
  yield* files(root, [["local-bin.sh", script]])
  sh(root, ["git", "add", "-A"])
  sh(root, ["git", "commit", "-qm", "A"])
  return { root, a: sh(root, ["git", "rev-parse", "HEAD"]).out }
})

/** The Mac's commands script run from the checkout at `root` as it stands. */
const macCommands = (root: string, env: Record<string, string>) =>
  Effect.gen(function* () {
    return yield* (yield* Source).commands
  }).pipe(Effect.provide(SourceLive.layer({ root, env, bin: Option.some(SourceLive.MAC_BIN), tree: "/nonexistent/loop-probe-x/current.plugins" })), Effect.exit)

describe("the host's commands, over the checkout as it stands", () => {
  test("M1: each host runs its own commands script: the workbox's on Linux, the Mac's on macOS, none elsewhere", () => {
    expect(SourceLive.binScript("linux")).toEqual(Option.some(SourceLive.WORKBOX_BIN))
    expect(SourceLive.binScript("darwin")).toEqual(Option.some(SourceLive.MAC_BIN))
    expect(SourceLive.binScript("win32")).toEqual(Option.none())
  })

  test(
    "on the Mac the commands link into ~/.local/bin over a stale link, twice alike; a link no longer made stays; the checkout does not move",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, a } = yield* scratch
          const home = sh(".", ["mktemp", "-d", "-t", "update-source-home"]).out
          sh(home, ["mkdir", "-p", ".local/bin"])
          sh(home, ["ln", "-s", "/nonexistent/loop-probe-x/hours", ".local/bin/hours"])
          sh(home, ["ln", "-s", "/nonexistent/loop-probe-x/gone", ".local/bin/gone"])
          const commands = macCommands(root, { ...GIT_ENV, HOME: home })
          const links = () =>
            ["hours", "codex-bridge", "gone"].map((name) => `${name} -> ${sh(home, ["readlink", `.local/bin/${name}`]).out}`)
          const expected = [
            `hours -> ${root}/skills/track-work-hours/scripts/hours`,
            `codex-bridge -> ${root}/claude/mods/codex/bridge/bridge.ts`,
            "gone -> /nonexistent/loop-probe-x/gone",
          ]
          expect(Exit.match(yield* commands, { onSuccess: () => "linked", onFailure: String })).toBe("linked")
          expect(links()).toEqual(expected)
          expect(Exit.isSuccess(yield* commands)).toBe(true)
          expect(links()).toEqual(expected)
          expect(sh(root, ["git", "rev-parse", "HEAD"]).out).toBe(a)
          expect(sh(root, ["git", "status", "--porcelain"]).out).toBe("")
          spawnSync(["rm", "-rf", root, home])
        }),
      ),
    hangGuard("installer"),
  )

  /** The host's commands scripts as the repo has them, each run under `sh` from its own place. */
  const SCRIPTS = [
    { host: "the Mac", script: matchingInput("../local-bin.sh") },
    { host: "the workbox", script: matchingInput("../workbox/install-bin.sh") },
  ] as const
  const TREE_SHOW = "opencode-2.3.0-prime.aaaaaaaa.bbbbbbbb.tree.plugins/opencode/cmd/rex/show.ts"
  // This direct link test does not use the fleet's --apply dispatch.
  const identityScript = matchingInput("../workbox/host-identity.sh")
  const identity = sh(".", ["sh", "-c", '. "$1"; workbox_host_identity', "test", identityScript]).out

  for (const { host, script } of SCRIPTS)
    test(`on ${host}, rex-show links through current.plugins alone: into the tree when it holds the file; with none, no link is made and one that is there stays`, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const run = (home: string) => spawnSync(["sh", script], {
            cwd: home,
            env: { ...GIT_ENV, HOME: home, PATH: hostEnv.PATH ?? "", WORKBOX_EXPECT_MACHINE_ID: identity },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }).exitCode
          const rexShow = (home: string) => sh(home, ["readlink", ".local/bin/rex-show"]).out
          // With the installed build's tree.
          const treed = sh(".", ["mktemp", "-d", "-t", "update-bin-home"]).out
          const share = `${treed}/.local/share/opencode-prime`
          yield* files(share, [[TREE_SHOW, "// rex-show\n"]])
          sh(share, ["ln", "-s", "opencode-2.3.0-prime.aaaaaaaa.bbbbbbbb.tree.plugins", "current.plugins"])
          expect(run(treed)).toBe(0)
          expect(rexShow(treed)).toBe(`${share}/current.plugins/opencode/cmd/rex/show.ts`)
          // With none: no link made.
          const bare = sh(".", ["mktemp", "-d", "-t", "update-bin-home"]).out
          expect(run(bare)).toBe(0)
          expect(sh(bare, ["test", "-L", ".local/bin/rex-show"]).code).not.toBe(0)
          // With none, and a link already there: it stays as it was.
          sh(bare, ["ln", "-s", "/nonexistent/loop-probe-x/show.ts", ".local/bin/rex-show"])
          expect(run(bare)).toBe(0)
          expect(rexShow(bare)).toBe("/nonexistent/loop-probe-x/show.ts")
          spawnSync(["rm", "-rf", treed, bare])
        }),
      ), hangGuard("installer"))

  /**
   * A scratch live checkout and an installed tree, each with its own `workbox/install-bin.sh` that writes
   * where it ran into `ran` under HOME: the checkout's is the stale one a lagging checkout holds.
   */
  const marker = (from: string) => `#!/bin/sh\nprintf '%s %s\\n' ${from} "$*" >>"$HOME/ran"\n`
  const placesOfWorkbox = (treeFiles: ReadonlyArray<readonly [string, string]>) =>
    Effect.gen(function* () {
      const dir = sh(".", ["mktemp", "-d", "-t", "update-source-workbox"]).out
      yield* files(`${dir}/checkout`, [["workbox/install-bin.sh", marker("checkout")]])
      yield* files(`${dir}/tree`, treeFiles)
      sh(dir, ["mkdir", "-p", "home"])
      return { dir, checkout: `${dir}/checkout`, tree: `${dir}/tree`, home: `${dir}/home` }
    })

  const workboxCommands = (places: { readonly checkout: string; readonly tree: string; readonly home: string }) =>
    Effect.gen(function* () {
      return yield* (yield* Source).commands
    }).pipe(
      Effect.provide(SourceLive.layer({ root: places.checkout, tree: places.tree, env: { ...GIT_ENV, HOME: places.home, PATH: hostEnv.PATH ?? "" }, bin: Option.some(SourceLive.WORKBOX_BIN) })),
      Effect.exit,
    )

  test("on the workbox the commands come from the installed tree, never from the live checkout as it stands", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const places = yield* placesOfWorkbox([["workbox/install-bin.sh", marker("tree")]])
        expect(Exit.isSuccess(yield* workboxCommands(places))).toBe(true)
        expect(sh(places.home, ["cat", "ran"]).out).toBe("tree --apply")
        spawnSync(["rm", "-rf", places.dir])
      }),
    ), hangGuard("installer"))

  test("a commands script that refuses (a file it will not install, a ~/.zshenv of the owner's) fails the commands with what it said, which the handoff logs", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const said = "install-bin: refused /t/workbox/zshenv: zsh -n fails"
        const places = yield* placesOfWorkbox([["workbox/install-bin.sh", `#!/bin/sh\nprintf '%s\\n' '${said}' >&2\nexit 1\n`]])
        const failure = Exit.findErrorOption(yield* workboxCommands(places))
        expect(Option.map(failure, (failed) => failed.message)).toEqual(Option.some(said))
        spawnSync(["rm", "-rf", places.dir])
      }),
    ), hangGuard("installer"))

  test("an installed tree with no workbox/ (a build from before it held one) fails the commands loudly, naming the tree, and runs the checkout's neither", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const places = yield* placesOfWorkbox([["opencode/package.json", "{}\n"]])
        const failure = Exit.findErrorOption(yield* workboxCommands(places))
        expect(Option.map(failure, (failed) => failed.message)).toEqual(Option.some(`${places.tree}/workbox/install-bin.sh is not in the installed tree`))
        expect(sh(places.home, ["test", "-e", "ran"]).code).not.toBe(0)
        spawnSync(["rm", "-rf", places.dir])
      }),
    ), hangGuard("installer"))

  test("a host with no script runs nothing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Source).commands
      }).pipe(Effect.provide(SourceLive.layer({ root: "/nonexistent/loop-probe-x", env: { PATH: hostEnv.PATH ?? "" }, bin: Option.none(), tree: "/nonexistent/loop-probe-x/current.plugins" })), Effect.exit, Effect.map((exit) => expect(Exit.isSuccess(exit)).toBe(true))),
    ))
})
