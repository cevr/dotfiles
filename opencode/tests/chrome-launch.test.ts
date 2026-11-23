// accept: deep (3.3 s alone on a quiet host: 1-minute load 3.8 on 12 cores; it starts a real Chrome for Testing twice and needs Playwright's Chrome installed)
// accept: one at a time (it binds loopback ports and starts real browsers)
// A real, isolated Chrome through scripts/chrome.ts only, so both keychain flags are always on its command line, with
// a scratch profile under a scratch run directory, never the owner's Chrome: on any free port (Chrome writes
// DevToolsActivePort) and on a fixed port (Chrome writes none) the launch prints the endpoint of its own browser,
// which answers there, and `stop` ends it; on a port another process holds the launch fails at once, naming it, and
// that process keeps serving. Every browser a launch prints is stopped by its pid when its scope ends, whatever
// failed. With no Playwright Chrome on the host the launch fails, saying so (`bunx playwright install chromium`).
import * as BunServices from "@effect/platform-bun/BunServices"
import { serve, spawnSync } from "bun"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { FetchHttpClient, HttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Launched } from "../scripts/chrome.ts"

const decodeLaunched = Schema.decodeUnknownSync(Schema.fromJsonString(Launched))
const decodeVersion = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ webSocketDebuggerUrl: Schema.String })))

const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** scripts/chrome.ts run with `args`, its exit code and output. */
const cli = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const script = yield* path.fromFileUrl(new URL("../scripts/chrome.ts", import.meta.url))
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make("bun", [script, ...args], { extendEnv: true, stdin: "ignore", forceKillAfter: "5 seconds" }))
    const [stdout, stderr] = yield* Effect.all([text(child.stdout), text(child.stderr)], { concurrency: 2 })
    return { code: Number(yield* child.exitCode), stdout, stderr }
  }).pipe(Effect.scoped)

/** A launch that succeeded, stopped by its pid when the scope ends unless the test stopped it first. */
const launched = (args: ReadonlyArray<string>) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const run = yield* cli(["launch", ...args])
      expect([run.code, run.stderr]).toEqual([0, ""])
      return decodeLaunched(run.stdout.trim())
    }),
    (record) => Effect.ignore(Effect.when(cli(["stop", String(record.pid)]), Effect.sync(() => running(record.pid)))),
  )

/** Whether `pid` runs, by ps; its command line. */
const commandOf = (pid: number) => spawnSync(["ps", "-ww", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()
const running = (pid: number) => commandOf(pid) !== ""

/** What answers on loopback `port` at `route`, as text. */
const get = (port: number, route: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* (yield* client.get(`http://127.0.0.1:${port}${route}`)).text
  }).pipe(Effect.provide(FetchHttpClient.layer))

/** A free loopback port: one the system hands out, released again. */
const freePort = Effect.gen(function* () {
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = Number(server.port)
  yield* Effect.promise(() => server.stop(true))
  return port
})

describe("a real Chrome through scripts/chrome.ts", () => {
  it.scopedLive.layer(BunServices.layer)("on any free port and on a fixed one, it prints its own browser's endpoint, keychain flags on, and stop ends it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-launch-" })
      for (const asked of [0, yield* freePort]) {
        const record = yield* launched(["--dir", dir, "--port", String(asked), "--", "--disable-background-networking"])
        if (asked > 0) expect(record.port).toBe(asked)
        expect(record.folder.startsWith(`${dir}/chrome-`)).toBe(true)
        expect(decodeVersion(yield* get(record.port, "/json/version")).webSocketDebuggerUrl).toBe(record.endpoint)
        expect(commandOf(record.pid)).toContain(`--user-data-dir=${record.folder}/profile --remote-debugging-port=${asked} --use-mock-keychain --password-store=basic`)
        expect((yield* cli(["stop", String(record.pid)])).code).toBe(0)
        expect(running(record.pid)).toBe(false)
      }
      expect(yield* fs.readDirectory(dir)).toEqual([])
    }),
  )

  it.scopedLive.layer(BunServices.layer)("on a port another process holds, it fails at once naming that process, starts no browser, and the holder keeps serving", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chrome-held-" })
      const holder = yield* Effect.acquireRelease(
        Effect.sync(() => serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("holder") })),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const port = Number(holder.port)
      const refused = yield* cli(["launch", "--dir", dir, "--port", String(port)])
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain(`port ${port} is in use by pid ${process.pid}`)
      expect(yield* fs.readDirectory(dir)).toEqual([])
      expect(yield* get(port, "/")).toBe("holder")
    }),
  )
})
