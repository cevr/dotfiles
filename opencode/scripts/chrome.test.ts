// scripts/chrome.ts against a stand-in browser (a shell script that writes the DevTools port file Chrome writes and
// records its arguments): the argument list keeps both keychain flags last whatever the caller adds, refusing every
// spelling that would replace or drop one; the browsers are found in their order on a planted cache; a launch prints
// the endpoint and leaves a process group that `stop` ends, removing its folder; `stop` refuses a pid it did not
// start. No real Chrome runs here.
import * as BunServices from "@effect/platform-bun/BunServices"
import { spawn, spawnSync } from "bun"
import { Effect, FileSystem, Option, Path, Result, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { browsersIn, chromeArgs, DEFAULTS, KEYCHAIN_FLAGS, launch, start, stop } from "./chrome.ts"

const PROFILE = "/run/chrome-x/profile"

/** A browser that writes its DevTools port file, records its arguments beside its profile, and waits to be ended. */
const FAKE = [
  "#!/bin/sh",
  'for a in "$@"; do case "$a" in --user-data-dir=*) p="${a#--user-data-dir=}";; esac; done',
  'mkdir -p "$p"',
  "printf '%s\\n' \"$@\" > \"$p/../args.txt\"",
  "printf '4242\\n/devtools/browser/fake\\n' > \"$p/DevToolsActivePort\"",
  "sleep 30 & wait",
  "",
].join("\n")

/** A browser that ends before it opens a port. */
const BROKEN = "#!/bin/sh\necho 'cannot open display' >&2\nexit 3\n"

/** A child's whole output, as text. */
const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** Whether `pid` still runs. */
const alive = (pid: number) => spawnSync(["ps", "-o", "pid=", "-p", String(pid)]).exitCode === 0

const plant = (dir: string, name: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(`${dir}/${name}`, text)
    yield* fs.chmod(`${dir}/${name}`, 0o755)
    return { path: `${dir}/${name}`, shell: false }
  })

describe("the argument list", () => {
  it.effect("is headless, the caller's flags, the launcher's switches, then both keychain flags and a blank page", () =>
    Effect.sync(() => {
      const options = { ...DEFAULTS, flags: "--window-size=800,600 --lang=fr".split(" "), port: 9333, resolverRules: Option.some("MAP * 127.0.0.1"), proxy: Option.some("http://127.0.0.1:8080") }
      expect(chromeArgs(options, PROFILE)).toEqual(
        Result.succeed([
          "--headless",
          "--no-first-run",
          "--no-default-browser-check",
          "--host-resolver-rules=MAP * 127.0.0.1",
          "--proxy-server=http://127.0.0.1:8080",
          "--window-size=800,600",
          "--lang=fr",
          `--user-data-dir=${PROFILE}`,
          "--remote-debugging-port=9333",
          "--use-mock-keychain",
          "--password-store=basic",
          "about:blank",
        ]),
      )
    }),
  )

  it.effect("cannot lose a keychain flag: every flag that would replace or drop one, or set a switch the launcher owns, is refused", () =>
    Effect.sync(() => {
      // One flag a line (a list literal of them would be the very list the repository's lint refuses).
      const refused = `--use-mock-keychain=false
--password-store=gnome-libsecret
-password-store=kwallet5
---password-store=basic
--
--user-data-dir=/Users/owner/Library/Application Support/Google/Chrome
--headless=old
--remote-debugging-pipe
--remote-debugging-address=0.0.0.0`.split("\n")
      for (const flag of refused) {
        const args = chromeArgs({ ...DEFAULTS, flags: ["--lang=fr", flag] }, PROFILE)
        expect([flag, Result.isFailure(args)]).toEqual([flag, true])
        expect(Result.match(args, { onFailure: (reason) => reason, onSuccess: () => "" })).toContain(flag)
      }
      // A page or a switch that only looks like one is the caller's, and the keychain flags still close the list.
      for (const flag of ["https://example.com/--headless", "--enable-logging=stderr", "--no-sandbox"]) {
        const args = Result.getOrElse(chromeArgs({ ...DEFAULTS, flags: [flag] }, PROFILE), () => [])
        expect(args.slice(-3)).toEqual([...KEYCHAIN_FLAGS, "about:blank"])
      }
    }),
  )
})

describe("the browsers", () => {
  it.scopedLive.layer(BunServices.layer)("are Playwright's Chrome for Testing newest first, then agent-browser's, then the headless shell; --shell puts the shell first", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-browsers-" })
      const testing = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      const programs = [
        `pw/chromium-1248/chrome-mac-arm64/${testing}`,
        "pw/chromium-1255/chrome-linux64/chrome",
        `ab/chrome-149.0.7827.55/${testing}`,
        "pw/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell",
        "pw/ffmpeg-1013/ffmpeg-mac",
      ] as const
      for (const program of programs) {
        yield* fs.makeDirectory(`${root}/${program}`.replace(/\/[^/]+$/, ""), { recursive: true })
        yield* fs.writeFileString(`${root}/${program}`, "")
      }
      const places = { playwright: `${root}/pw`, agentBrowser: `${root}/ab` }
      const found = (yield* browsersIn(places, "testing")).map((each) => [each.path.slice(root.length + 1), each.shell])
      expect(found).toEqual([
        [programs[1], false],
        [programs[0], false],
        [programs[2], false],
        [programs[3], true],
      ])
      expect((yield* browsersIn(places, "shell")).map((each) => each.path.slice(root.length + 1))[0]).toBe(programs[3])
      expect(yield* browsersIn({ playwright: `${root}/none`, agentBrowser: `${root}/none` }, "testing")).toEqual([])
    }),
  )
})

describe("a launch", () => {
  it.scopedLive.layer(BunServices.layer)("prints the endpoint, runs in the caller's run directory, and stop ends its group and removes its folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-launch-" })
      const binary = yield* plant(dir, "fake-chrome", FAKE)
      const launched = yield* start({ ...DEFAULTS, flags: ["--lang=fr"] }, Option.some(`${dir}/run`), binary)
      expect(launched.endpoint).toBe("ws://127.0.0.1:4242/devtools/browser/fake")
      expect(launched.folder.startsWith(`${dir}/run/chrome-`)).toBe(true)
      const args = (yield* fs.readFileString(`${launched.folder}/args.txt`)).trim().split("\n")
      expect(args.slice(-3)).toEqual([...KEYCHAIN_FLAGS, "about:blank"])
      expect(args).toContain(`--user-data-dir=${launched.folder}/profile`)
      expect(alive(launched.pid)).toBe(true)
      expect(yield* stop(launched.pid)).toBe(launched.folder)
      expect(alive(launched.pid)).toBe(false)
      expect(yield* fs.exists(launched.folder)).toBe(false)
    }),
  )

  it.scopedLive.layer(BunServices.layer)("in a scope, ends with the scope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-scoped-" })
      const binary = yield* plant(dir, "fake-chrome", FAKE)
      const launched = yield* Effect.scoped(launch(DEFAULTS, Option.some(dir), binary))
      expect(alive(launched.pid)).toBe(false)
      expect(yield* fs.exists(launched.folder)).toBe(false)
    }),
  )

  it.scopedLive.layer(BunServices.layer)("fails at once, removing its folder, when the browser ends before it opens a port; a refused flag starts nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-broken-" })
      const broken = yield* plant(dir, "broken-chrome", BROKEN)
      const failed = yield* Effect.flip(start(DEFAULTS, Option.some(`${dir}/run`), broken))
      expect(failed.message).toContain("opened no DevTools port")
      expect(failed.message).toContain("cannot open display")
      expect(yield* fs.readDirectory(`${dir}/run`)).toEqual([])
      const fake = yield* plant(dir, "fake-chrome", FAKE)
      const refused = yield* Effect.flip(start({ ...DEFAULTS, flags: ["--password-store=gnome-libsecret"] }, Option.some(`${dir}/run`), fake))
      expect(refused.message).toContain("--password-store=gnome-libsecret")
      expect(yield* fs.readDirectory(`${dir}/run`)).toEqual([])
    }),
  )

  it.scopedLive.layer(BunServices.layer)("stop refuses a process it did not start and leaves it running", () =>
    Effect.gen(function* () {
      const other = spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      const refused = yield* Effect.flip(stop(other.pid))
      expect(refused.message).toContain("is not a Chrome scripts/chrome.ts started")
      expect(alive(other.pid)).toBe(true)
      other.kill()
    }),
  )
})

describe("the command line", () => {
  it.scopedLive.layer(BunServices.layer)("launch with no flag finds the newest Chrome for Testing, prints its endpoint, and stop ends it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-cli-" })
      yield* fs.makeDirectory(`${dir}/pw/chromium-1255/chrome-linux64`, { recursive: true })
      yield* plant(`${dir}/pw/chromium-1255/chrome-linux64`, "chrome", FAKE)
      const path = yield* Path.Path
      const script = yield* path.fromFileUrl(new URL("./chrome.ts", import.meta.url))
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const cli = (args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make("bun", [script, ...args], { env: { PLAYWRIGHT_BROWSERS_PATH: `${dir}/pw`, HOME: dir }, extendEnv: true, stdin: "ignore", forceKillAfter: "2 seconds" }),
          )
          const [stdout, stderr] = yield* Effect.all([text(child.stdout), text(child.stderr)], { concurrency: 2 })
          return { code: Number(yield* child.exitCode), stdout, stderr }
        }).pipe(Effect.scoped)
      const launched = yield* cli(["launch", "--dir", `${dir}/run`])
      expect([launched.code, launched.stderr]).toEqual([0, ""])
      expect(launched.stdout).toContain('"endpoint":"ws://127.0.0.1:4242/devtools/browser/fake"')
      const pid = Number(/"pid":(\d+)/.exec(launched.stdout)?.[1])
      expect(alive(pid)).toBe(true)
      expect((yield* cli(["stop", String(pid)])).code).toBe(0)
      expect(alive(pid)).toBe(false)
    }),
  )
})
