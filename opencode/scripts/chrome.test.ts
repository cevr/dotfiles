// scripts/chrome.ts against a stand-in browser (a Bun script that serves DevTools as Chrome does, writing the port file
// only for a port it chose, and records its arguments): the argument list keeps both keychain flags last whatever the caller adds, refusing every
// spelling that would replace or drop one; the browsers are found in their order on a planted cache; a launch prints
// the endpoint and leaves a process group that `stop` ends, removing its folder; `stop` refuses a pid it did not
// start. No real Chrome runs here.
import * as BunServices from "@effect/platform-bun/BunServices"
import { serve, spawn, spawnSync } from "bun"
import { Duration, Effect, FileSystem, Option, Path, Result, Schedule, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { FetchHttpClient, HttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { browsersIn, chromeArgs, DEFAULTS, holders, KEYCHAIN_FLAGS, launch, start, stop } from "./chrome.ts"

const PROFILE = "/run/chrome-x/profile"

/**
 * A browser that behaves as Chrome does with its DevTools port: it records its arguments beside its profile, serves
 * `/json/version` on loopback at the port it was given (any free one for 0), and writes `DevToolsActivePort` only
 * when it chose the port itself (Chrome writes no file for a fixed port); then waits to be ended.
 */
const FAKE = `#!/usr/bin/env bun
const args = process.argv.slice(2)
const value = (name) => args.find((arg) => arg.startsWith("--" + name + "="))?.slice(name.length + 3)
const profile = value("user-data-dir")
const asked = Number(value("remote-debugging-port") ?? "0")
require("node:fs").mkdirSync(profile, { recursive: true })
await Bun.write(profile + "/../args.txt", args.join("\\n") + "\\n")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: asked,
  fetch: (request) => new URL(request.url).pathname === "/json/version" ? Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:" + server.port + "/devtools/browser/fake" }) : new Response(null, { status: 404 }),
})
if (asked === 0) await Bun.write(profile + "/DevToolsActivePort", server.port + "\\n/devtools/browser/fake\\n")
setTimeout(() => process.exit(0), 30000)
`

/** A browser that writes a port file naming the port in $IMPOSTOR_PORT, where another process answers, and listens nowhere. */
const IMPOSTOR = `#!/usr/bin/env bun
const profile = process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16)
require("node:fs").mkdirSync(profile, { recursive: true })
await Bun.write(profile + "/DevToolsActivePort", process.env.IMPOSTOR_PORT + "\\n/devtools/browser/other\\n")
setTimeout(() => process.exit(0), 30000)
`

/** Another process's DevTools on loopback: what a browser already on a port answers. */
const other = () =>
  Effect.acquireRelease(
    Effect.sync(() => serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/other" }) })),
    (server) => Effect.promise(() => server.stop(true)),
  )

/** A free loopback port: one the system hands out, released again. */
const freePort = Effect.gen(function* () {
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = Number(server.port)
  yield* Effect.promise(() => server.stop(true))
  return port
})

/** Whether something answers `/json/version` at loopback `port`. */
const answers = (port: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return (yield* client.get(`http://127.0.0.1:${port}/json/version`)).status === 200
  }).pipe(Effect.provide(FetchHttpClient.layer))

/** The endpoint the stand-in serves at `port`. */
const fakeEndpoint = (port: number) => `ws://127.0.0.1:${port}/devtools/browser/fake`

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
      expect(launched.port).toBeGreaterThan(0)
      expect(launched.endpoint).toBe(fakeEndpoint(launched.port))
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

  it.scopedLive.layer(BunServices.layer)("on a fixed port, where Chrome writes no port file, is ready once its own browser answers there", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-fixed-" })
      const binary = yield* plant(dir, "fake-chrome", FAKE)
      const port = yield* freePort
      const launched = yield* start({ ...DEFAULTS, port }, Option.some(`${dir}/run`), binary)
      expect([launched.port, launched.endpoint]).toEqual([port, fakeEndpoint(port)])
      expect(yield* fs.exists(`${launched.folder}/profile/DevToolsActivePort`)).toBe(false)
      expect(yield* stop(launched.pid)).toBe(launched.folder)
      expect(alive(launched.pid)).toBe(false)
    }),
  )

  it.scopedLive.layer(BunServices.layer)("on a port another process holds, fails at once naming it, starts nothing, and leaves that process serving", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-held-" })
      const binary = yield* plant(dir, "fake-chrome", FAKE)
      const held = yield* other()
      const port = Number(held.port)
      const refused = yield* Effect.flip(start({ ...DEFAULTS, port }, Option.some(`${dir}/run`), binary))
      expect(refused.message).toContain(`port ${port} is in use by pid ${process.pid}`)
      expect(yield* fs.exists(`${dir}/run`)).toBe(false)
      expect(yield* answers(port)).toBe(true)
    }),
  )

  it.scopedLive.layer(BunServices.layer)("is never another process's browser: a port its file names that another process answers fails, ending only its own", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-impostor-" })
      const held = yield* other()
      const binary = yield* plant(dir, "impostor-chrome", IMPOSTOR.replace("process.env.IMPOSTOR_PORT", String(held.port)))
      const refused = yield* Effect.flip(start(DEFAULTS, Option.some(`${dir}/run`), binary))
      expect(refused.message).toContain(`port ${held.port} answers DevTools from another process, pid ${process.pid}`)
      expect(yield* fs.readDirectory(`${dir}/run`)).toEqual([])
      expect(yield* answers(Number(held.port))).toBe(true)
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
      const port = Number(/"port":(\d+)/.exec(launched.stdout)?.[1])
      expect(launched.stdout).toContain(`"endpoint":"${fakeEndpoint(port)}"`)
      const pid = Number(/"pid":(\d+)/.exec(launched.stdout)?.[1])
      expect(alive(pid)).toBe(true)
      expect((yield* cli(["stop", String(pid)])).code).toBe(0)
      expect(alive(pid)).toBe(false)
      // A fixed port, by the command line too.
      const fixed = yield* freePort
      const onFixed = yield* cli(["launch", "--dir", `${dir}/run`, "--port", String(fixed)])
      expect([onFixed.code, onFixed.stderr]).toEqual([0, ""])
      expect(onFixed.stdout).toContain(`"endpoint":"${fakeEndpoint(fixed)}","port":${fixed},`)
      expect((yield* cli(["stop", String(/"pid":(\d+)/.exec(onFixed.stdout)?.[1])])).code).toBe(0)
    }),
  )
})

/**
 * A browser that parks at a point between its spawn and its readiness, as $STANDIN_PARK names it: `spawned` (nothing
 * written yet) or `portfile` (its port file written, naming a port nothing answers on). It writes its pid to
 * `$STANDIN_GATE/parked` once there, so a signal lands at that exact point, and never becomes ready.
 */
const PARKED = `#!/usr/bin/env bun
const profile = process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16)
require("node:fs").mkdirSync(profile, { recursive: true })
if (process.env.STANDIN_PARK === "portfile") await Bun.write(profile + "/DevToolsActivePort", "1\\n/devtools/browser/parked\\n")
await Bun.write(process.env.STANDIN_GATE + "/parked", String(process.pid))
setTimeout(() => process.exit(0), 60000)
`

/** A process that holds a loopback port with a synthetic secret in its arguments, writing the port to the file it is given. */
const HOLDER = `#!/usr/bin/env bun
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("holder") })
await Bun.write(process.argv[2], String(server.port))
setTimeout(() => process.exit(0), 60000)
`

/** A synthetic credential marker a holder carries in its argv; no real secret. */
const MARKER = "SYNTHETIC-CREDENTIAL-MARKER-7f3a"

/** The pids whose command line names `dir`: every process a test's launch made there (browser, watchdog). */
const census = (dir: string) =>
  spawnSync(["ps", "-axww", "-o", "pid=,command="], { stdout: "pipe" })
    .stdout.toString()
    .split("\n")
    .filter((line) => line.includes(dir) && !line.includes("ps -axww"))
    .map((line) => Number(line.trim().split(/\s+/)[0]))

/** `check` again every 20 ms until it holds, 10 s at most; whether it held. */
const eventually = (check: () => boolean) =>
  Effect.sync(check).pipe(
    Effect.repeat({ schedule: Schedule.spaced(Duration.millis(20)), until: (held) => held, times: 500 }),
    Effect.map(() => check()),
  )

describe("an interrupted launch", () => {
  /** The CLI on a planted stand-in, parked at `park`; its handle, the run folder and the parked browser's pid. */
  const parkedLaunch = (dir: string, park: string, name: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const script = yield* path.fromFileUrl(new URL("./chrome.ts", import.meta.url))
      const gate = `${dir}/gate-${name}`
      yield* fs.makeDirectory(gate, { recursive: true })
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const env = { PLAYWRIGHT_BROWSERS_PATH: `${dir}/pw`, HOME: dir, STANDIN_PARK: park, STANDIN_GATE: gate }
      const handle = yield* spawner.spawn(ChildProcess.make("bun", [script, "launch", "--dir", `${dir}/run`], { env, extendEnv: true, stdin: "ignore", forceKillAfter: "5 seconds" }))
      expect(yield* eventually(() => spawnSync(["test", "-s", `${gate}/parked`]).exitCode === 0)).toBe(true)
      const browser = Number(yield* fs.readFileString(`${gate}/parked`))
      expect(alive(browser)).toBe(true)
      return { handle, browser }
    })

  const plantParked = (dir: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(`${dir}/pw/chromium-1255/chrome-linux64`, { recursive: true })
      yield* plant(`${dir}/pw/chromium-1255/chrome-linux64`, "chrome", PARKED)
    })

  it.scopedLive.layer(BunServices.layer)("SIGTERM or SIGINT at each point between spawn and readiness ends the browser and removes the profile before the launcher exits, handing back nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-signal-" })
      yield* plantParked(dir)
      expect(census(dir)).toEqual([])
      for (const killSignal of ["SIGTERM", "SIGINT"] as const)
        for (const park of ["spawned", "portfile"]) {
          const { handle, browser } = yield* parkedLaunch(dir, park, `${killSignal}-${park}`)
          yield* handle.kill({ killSignal })
          const [stdout, code] = yield* Effect.all([text(handle.stdout), handle.exitCode], { concurrency: 2 })
          // The finalizers ran before the launcher exited: nothing to wait for.
          expect([killSignal, park, stdout, alive(browser), yield* fs.readDirectory(`${dir}/run`)]).toEqual([killSignal, park, "", false, []])
          expect(Number(code)).not.toBe(0)
        }
      // The watchdogs read their word and ended: no process the launches made is left.
      expect(yield* eventually(() => census(dir).length === 0)).toBe(true)
    }),
  )

  it.scopedLive.layer(BunServices.layer)("SIGKILL or SIGHUP, which run no finalizer, leave the browser and the profile to the watchdog, which ends and removes them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-killed-" })
      yield* plantParked(dir)
      for (const killSignal of ["SIGKILL", "SIGHUP"] as const) {
        const { handle, browser } = yield* parkedLaunch(dir, "portfile", killSignal)
        yield* handle.kill({ killSignal })
        yield* handle.exitCode.pipe(Effect.ignore)
        expect([killSignal, yield* eventually(() => !alive(browser))]).toEqual([killSignal, true])
        expect(yield* eventually(() => spawnSync(["sh", "-c", `[ -z "$(ls -A '${dir}/run')" ]`]).exitCode === 0)).toBe(true)
      }
      expect(yield* eventually(() => census(dir).length === 0)).toBe(true)
    }),
  )
})

describe("a refusal for a held port", () => {
  it.scopedLive.layer(BunServices.layer)("names the holder by pid and program, never its arguments, and leaves it serving", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-holder-" })
      const holderScript = (yield* plant(dir, "holder", HOLDER)).path
      const binary = yield* plant(dir, "fake-chrome", FAKE)
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const holder = yield* spawner.spawn(ChildProcess.make(holderScript, [`${dir}/port`, `--token=${MARKER}`], { stdin: "ignore", forceKillAfter: "2 seconds" }))
      expect(yield* eventually(() => spawnSync(["test", "-s", `${dir}/port`]).exitCode === 0)).toBe(true)
      const port = Number(yield* fs.readFileString(`${dir}/port`))
      const refused = yield* Effect.flip(start({ ...DEFAULTS, port }, Option.some(`${dir}/run`), binary))
      expect(refused.message).toContain(`port ${port} is in use by pid ${holder.pid} (`)
      expect(refused.message).not.toContain(MARKER)
      expect(holders([holder.pid])).toBe(`pid ${holder.pid} (bun)`)
      expect(yield* answers(port)).toBe(true)
      expect(alive(holder.pid)).toBe(true)
    }),
  )
})
