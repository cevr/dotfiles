// claude/bin/chrome-mock-keychain against a stand-in browser (a shell script that records its arguments and waits):
// each argument list of Exact's 13 launches and of manna's launcher at the 7 old commits the 2026-11-22 bisect ran
// (copied text, fixtures/chrome-launch-args.json) reaches the browser unchanged with both keychain flags added, as `ps`
// reads its real argv under the same pid; a flag the caller passes is not added twice and a bare `--` keeps them before
// it; a DevTools pipe on fds 3 and 4 passes through; the newest Chrome for Testing is the default; and the shim refuses
// itself, the owner's Google Chrome.app, and a cache with no browser. No real Chrome runs here.
// @reads ../claude/bin/chrome-mock-keychain
import * as BunServices from "@effect/platform-bun/BunServices"
import { spawnSync } from "bun"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { matchingInput, scratchInput } from "../tests/read-path.ts"
import table from "./fixtures/chrome-launch-args.json" with { type: "json" }

/** The shim, from this file's URL (opencode/scripts). */
const shimPath = Effect.sync(() => matchingInput("../claude/bin/chrome-mock-keychain"))

/** The two flags it adds, one a line (a list literal holding them beside --headless is the list the repository's lint reads). */
const FLAGS = "--use-mock-keychain\n--password-store=basic".split("\n")

/** The headless flag, named so the lists below are not taken for a launch of their own. */
const HEADLESS = "--headless"

const LAUNCHES = Schema.decodeUnknownSync(Schema.Struct({ launches: Schema.Array(Schema.Struct({ source: Schema.String, args: Schema.Array(Schema.String) })) }))(table).launches

/** A browser that records its path and arguments one a line in $SHIM_TEST_OUT, says so on stdout, then waits on its stdin with a builtin, so ending it leaves no child. */
const FAKE = ["#!/bin/sh", "printf '%s\\n' \"$0\" \"$@\" > \"$SHIM_TEST_OUT\"", "echo ready", "IFS= read -r _", ""].join("\n")

/** A browser speaking over a DevTools pipe: it answers the line it reads on fd 3 on fd 4. */
const PIPE = ["#!/bin/sh", "IFS= read -r line <&3", "printf 'answer:%s\\n' \"$line\" >&4", ""].join("\n")

const plant = (path: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.replace(/\/[^/]+$/, ""), { recursive: true })
    yield* fs.writeFileString(path, text)
    yield* fs.chmod(path, 0o755)
    return path
  })

/** The argv `ps` reads of `pid`. */
const argvOf = (pid: number) => spawnSync(["ps", "-ww", "-o", "command=", "-p", String(pid)]).stdout.toString().trim()

const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** The shim run with `args` and `env` over this process's, in a scope that ends it. */
const through = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>>, options: Partial<ChildProcess.CommandOptions> = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* spawner.spawn(ChildProcess.make(yield* shimPath, args, { env, extendEnv: true, forceKillAfter: "2 seconds", ...options }))
  })

/** What the fake browser `child` recorded in `out`: its path, then its arguments; read once it says it is ready. */
const recorded = (child: ChildProcessSpawner.ChildProcessHandle, out: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead)
    return (yield* fs.readFileString(scratchInput(out))).trimEnd().split("\n")
  })

describe("an argument list through the shim", () => {
  it.scopedLive.layer(BunServices.layer)("each of Exact's 13 and the 7 old manna commits' reaches the browser unchanged, both flags after it, in the argv ps reads under the shim's pid", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-shim-" })
      const fake = yield* plant(`${dir}/bin/fake-chrome`, FAKE)
      expect(LAUNCHES.length).toBe(20)
      for (const [at, launch] of LAUNCHES.entries()) {
        const out = `${dir}/args-${at}.txt`
        const args = launch.args.map((arg) => arg.replace(/=X$/, `=${dir}/profile-${at}`))
        const child = yield* through(args, { CHROME_KEYCHAIN_TARGET: fake, SHIM_TEST_OUT: out })
        const [program, ...received] = yield* recorded(child, out)
        expect([launch.source, program, received]).toEqual([launch.source, fake, [...args, ...FLAGS]])
        const argv = argvOf(child.pid)
        expect([launch.source, argv.includes(fake), FLAGS.every((flag) => argv.includes(flag))]).toEqual([launch.source, true, true])
        yield* child.kill()
      }
    }),
  )

  it.scopedLive.layer(BunServices.layer)("adds only the flag the caller lacks, and puts them before a bare --", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-shim-" })
      const fake = yield* plant(`${dir}/bin/fake-chrome`, FAKE)
      const run = (args: ReadonlyArray<string>, name: string) =>
        Effect.gen(function* () {
          const child = yield* through(args, { CHROME_KEYCHAIN_TARGET: fake, SHIM_TEST_OUT: `${dir}/${name}` })
          const received = (yield* recorded(child, `${dir}/${name}`)).slice(1)
          yield* child.kill()
          return received
        })
      expect(yield* run([HEADLESS, FLAGS[0] ?? ""], "one.txt")).toEqual([HEADLESS, ...FLAGS])
      expect(yield* run([HEADLESS, ...FLAGS], "both.txt")).toEqual([HEADLESS, ...FLAGS])
      expect(yield* run([HEADLESS, "--", "--not-a-switch"], "dashes.txt")).toEqual([HEADLESS, ...FLAGS, "--", "--not-a-switch"])
    }),
  )

  it.scopedLive.layer(BunServices.layer)("keeps a DevTools pipe: what the caller writes on fd 3 the browser reads, and its answer on fd 4 comes back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-shim-" })
      const browser = yield* plant(`${dir}/bin/pipe-chrome`, PIPE)
      const child = yield* through(`${HEADLESS}=new --remote-debugging-pipe`.split(" "), { CHROME_KEYCHAIN_TARGET: browser }, { stdin: "ignore", additionalFds: { fd3: { type: "input" }, fd4: { type: "output" } } })
      const asked = '{"id":1,"method":"Browser.getVersion"}\n'
      const [, answer] = yield* Effect.all([Stream.make(new TextEncoder().encode(asked)).pipe(Stream.run(child.getInputFd(3))), text(child.getOutputFd(4))], { concurrency: 2 })
      expect(answer).toBe(`answer:${asked}`)
      expect(Number(yield* child.exitCode)).toBe(0)
    }),
  )
})

describe("the browser it runs", () => {
  it.scopedLive.layer(BunServices.layer)("is the newest Chrome for Testing in Playwright's cache when none is named", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-shim-" })
      const app = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      const linux = "chrome-linux64/chrome"
      for (const version of ["1200", "1255", "1013"]) {
        yield* plant(`${dir}/pw/chromium-${version}/chrome-mac-arm64/${app}`, FAKE)
        yield* plant(`${dir}/pw/chromium-${version}/${linux}`, FAKE)
      }
      const out = `${dir}/args.txt`
      const child = yield* through([HEADLESS], { CHROME_KEYCHAIN_TARGET: "", PLAYWRIGHT_BROWSERS_PATH: `${dir}/pw`, HOME: dir, SHIM_TEST_OUT: out })
      const [program] = yield* recorded(child, out)
      expect([`${dir}/pw/chromium-1255/chrome-mac-arm64/${app}`, `${dir}/pw/chromium-1255/${linux}`]).toContain(program ?? "")
      yield* child.kill()
    }),
  )

  it.scopedLive.layer(BunServices.layer)("is never the shim itself, the owner's Google Chrome.app, or nothing: each refused before it runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-shim-" })
      const refused = (env: Readonly<Record<string, string>>) =>
        Effect.gen(function* () {
          const child = yield* through([HEADLESS], env, { stdin: "ignore" })
          const [said, code] = yield* Effect.all([text(child.stderr), child.exitCode], { concurrency: 2 })
          return [Number(code), said.trim()] as const
        })
      const self = yield* refused({ CHROME_KEYCHAIN_TARGET: yield* shimPath })
      expect(self[0]).toBe(126)
      expect(self[1]).toContain("refusing to exec itself")
      const owners = yield* refused({ CHROME_KEYCHAIN_TARGET: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" })
      expect(owners[0]).toBe(126)
      expect(owners[1]).toContain("refusing the owner's Google Chrome.app")
      const none = yield* refused({ CHROME_KEYCHAIN_TARGET: "", PLAYWRIGHT_BROWSERS_PATH: `${dir}/empty`, HOME: dir })
      expect(none[0]).toBe(127)
      expect(none[1]).toContain("set CHROME_KEYCHAIN_TARGET")
    }),
  )
})
// @reads-indirect ../claude/bin/**
