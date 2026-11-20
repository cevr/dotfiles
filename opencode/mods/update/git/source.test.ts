import { describe, expect, test } from "bun:test"
import { env as hostEnv, file, spawnSync, write } from "bun"
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
  }).pipe(Effect.provide(SourceLive.layer({ root, env, bin: Option.some(SourceLive.MAC_BIN) })), Effect.exit)

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
            ["hours", "codex-bridge", "rex-show", "gone"].map((name) => `${name} -> ${sh(home, ["readlink", `.local/bin/${name}`]).out}`)
          const expected = [
            `hours -> ${root}/skills/track-work-hours/scripts/hours`,
            `codex-bridge -> ${root}/claude/mods/codex/bridge/bridge.ts`,
            `rex-show -> ${root}/opencode/cmd/rex/show.ts`,
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
    60_000,
  )

  test(
    "rex-show, part of the plugins, links through current.plugins once the installed build has a tree, the checkout's before",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { root, a } = yield* scratch
          const home = sh(".", ["mktemp", "-d", "-t", "update-source-home"]).out
          const commands = macCommands(root, { ...GIT_ENV, HOME: home })
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
          expect(sh(root, ["git", "rev-parse", "HEAD"]).out).toBe(a)
          spawnSync(["rm", "-rf", root, home])
        }),
      ),
    60_000,
  )

  test("a host with no script runs nothing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Source).commands
      }).pipe(Effect.provide(SourceLive.layer({ root: "/nonexistent/loop-probe-x", env: { PATH: hostEnv.PATH ?? "" }, bin: Option.none() })), Effect.exit, Effect.map((exit) => expect(Exit.isSuccess(exit)).toBe(true))),
    ))
})
