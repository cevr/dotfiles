// accept: one at a time (it measures a stall against a two-second threshold).
// The stall watchdog in a real OpenCode service: the fork's own
// `serve --service` in a scratch home, with the stall plugin and a test-only
// plugin whose RPC `block` busy-waits on the server's main thread for the
// milliseconds asked (`blockTheEventLoop`). No system load is involved: the
// stall is the server's own synchronous work.
//
// - A 1 s stall (under the 2 s threshold) is no capture: the one capture that
//   follows is the 3 s stall's, which the cooldown would have skipped had the
//   1 s stall been captured.
// - A 3 s stall writes one capture into the service's log directory: a valid
//   `.cpuprofile` that names `blockTheEventLoop`, its lag and time in the
//   name, a summary beside it, and a log line naming the file.
// - A second 3 s stall inside the cooldown writes nothing more: the log says
//   it is skipped, and the capture stays the only one.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schedule, Schema } from "effect"
import { forkLaunch } from "../testbeds/gamut/gamut.ts"
import { ROOT } from "../scripts/agents.ts"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"
import { ready } from "./service.ts"

const fork = process.env.OPENCODE_DEV
const runs = Boolean(fork)
if (!runs) console.warn("tests/stall.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const THRESHOLD_MS = 2_000
const CAPTURE_MS = 3_000
const TIMEOUT_MS = 150_000

/** The test-only plugin: an RPC that holds the server's main thread, in a named function the profile must show. */
const FIXTURE = `function blockTheEventLoop(ms) {
  const end = performance.now() + ms
  let turns = 0
  while (performance.now() < end) turns++
  return turns
}
export default { id: "fixture.stall", async setup(ctx) {
  await ctx.rpc.register(
    { id: "fixture.stall", methods: { block: { input: { type: "object" }, output: { type: "object" } } }, events: {} },
    { block: async (input) => ({ turns: blockTheEventLoop(Number(input.ms ?? 0)) }) },
  )
} }
`

/** As much of a `.cpuprofile` as the test reads. */
const CpuProfile = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ id: Schema.Finite, callFrame: Schema.Struct({ functionName: Schema.String }) })),
  samples: Schema.Array(Schema.Finite),
  timeDeltas: Schema.Array(Schema.Finite),
  startTime: Schema.Finite,
  endTime: Schema.Finite,
})
const SummaryFile = Schema.Struct({
  profile: Schema.String,
  stall: Schema.Struct({ lagMs: Schema.Finite, rssBefore: Schema.Finite, rssAfter: Schema.Finite }),
})
const Blocked = Schema.Struct({ output: Schema.Struct({ turns: Schema.Finite }) })
const decodeProfile = Schema.decodeUnknownSync(Schema.fromJsonString(CpuProfile))
const decodeSummary = Schema.decodeUnknownSync(Schema.fromJsonString(SummaryFile))
const decodeBlocked = Schema.decodeUnknownEffect(Schema.fromJsonString(Blocked))

const POLL = Schedule.spaced("250 millis")

/** `read` again until `done` holds of it; past `ms`, the test dies saying what it waited for. */
const until = <A, E>(read: Effect.Effect<A, E>, done: (value: A) => boolean, label: () => string, ms = 30_000) =>
  read.pipe(
    Effect.repeat({ schedule: POLL, until: done }),
    Effect.timeout(ms),
    Effect.catchTag("TimeoutError", () => Effect.die(`waited ${ms} ms for ${label()}`)),
  )

const kept = keptScratch(runs, "stall-e2e-")

/** The service in a fresh scratch home with the stall plugin and the fixture; stopped with the scope. */
const serve = Effect.gen(function* () {
  const base = kept.dir("service-")
  const home = join(base, "home")
  const fixture = join(base, "fixture")
  for (const dir of [join(base, "work"), home, join(home, ".config"), join(home, ".config/opencode"), join(home, ".local"), join(home, ".local/state"), fixture]) mkdirSync(dir)
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module", exports: { "./server": "./server.js" } }))
  writeFileSync(join(fixture, "server.js"), FIXTURE)
  writeFileSync(
    join(home, ".config/opencode/opencode.json"),
    JSON.stringify({ plugins: [{ package: join(ROOT, "cmd/stall"), options: { thresholdMs: THRESHOLD_MS, captureMs: CAPTURE_MS } }, { package: fixture }] }),
  )
  const launch = forkLaunch(fork ?? "", process.execPath)
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_DB: join(base, "opencode.db"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    ...launch.env,
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => owned([...launch.base, "serve", "--service", "--port", "0"], { cwd: join(base, "work"), env, stdout: "ignore", stderr: "ignore" })),
    (child) =>
      Effect.promise(() => {
        child.kill()
        return child.exited
      }),
  )
  const logDir = join(home, ".local/share/opencode/log")
  const service = yield* Effect.promise(() => ready(join(home, ".local/state/opencode/service-local.json"), () => "the stall test's service"))
  return { service, logDir }
})

describe.skipIf(!runs)("the stall watchdog (real OpenCode service)", () => {
  test(
    "a stall under the threshold writes nothing; one over it writes one profile of the blocking function; a second inside the cooldown writes nothing more",
    kept.test(() =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { service, logDir } = yield* serve
            const files = Effect.sync(() => {
              if (!existsSync(logDir)) return []
              return readdirSync(logDir)
            })
            const profiles = Effect.map(files, (names) => names.filter((name) => name.startsWith("stall-") && name.endsWith(".cpuprofile")))
            const logText = Effect.map(files, (names) =>
              names
                .filter((name) => name.endsWith(".log"))
                .map((name) => readFileSync(join(logDir, name), "utf8"))
                .join("\n"),
            )
            const block = (ms: number) =>
              Effect.tryPromise(() =>
                fetch(new URL("/api/rpc/fixture.stall/block", service.url), {
                  method: "POST",
                  headers: { authorization: `Basic ${btoa(`opencode:${service.password}`)}`, "content-type": "application/json" },
                  body: JSON.stringify({ input: { ms } }),
                }),
              ).pipe(
                Effect.flatMap((response) => Effect.tryPromise(() => response.text())),
                Effect.flatMap(decodeBlocked),
                Effect.map((blocked) => blocked.output.turns),
              )
            const seen = (what: string) => () => `${what} (files: ${readdirSync(logDir).join(", ")})`

            // The location loads with the first call, the stall plugin with it: wait for the watchdog to run.
            yield* block(0).pipe(Effect.retry({ schedule: POLL, times: 240 }))
            yield* until(logText, (text) => text.includes("stall watchdog: watching"), seen("the watchdog's start"))

            // Under the threshold, then over it: one capture, the 3 s stall's, once its window has sampled CAPTURE_MS more.
            expect(yield* block(1_000)).toBeGreaterThan(0)
            expect(yield* block(3_000)).toBeGreaterThan(0)
            const [name = ""] = yield* until(profiles, (found) => found.length > 0, seen("a capture"))
            expect(name).toMatch(/^stall-\d{8}T\d{9}Z-\d+ms-\d+\.cpuprofile$/)
            expect(Number(/-(\d+)ms-/.exec(name)?.[1])).toBeGreaterThanOrEqual(THRESHOLD_MS)

            const profile = decodeProfile(readFileSync(join(logDir, name), "utf8"))
            expect(profile.endTime).toBeGreaterThan(profile.startTime)
            expect(profile.samples.length).toBeGreaterThan(0)
            expect(profile.timeDeltas).toHaveLength(profile.samples.length)
            const ids = new Set(profile.nodes.map((node) => node.id))
            expect(profile.samples.every((sample) => ids.has(sample))).toBe(true)
            expect(profile.nodes.map((node) => node.callFrame.functionName)).toContain("blockTheEventLoop")

            const summary = decodeSummary(readFileSync(join(logDir, name.replace(/\.cpuprofile$/, ".json")), "utf8"))
            expect(summary.profile).toBe(join(logDir, name))
            expect(summary.stall.lagMs).toBeGreaterThanOrEqual(THRESHOLD_MS)
            expect(summary.stall.rssAfter).toBeGreaterThan(0)
            yield* until(logText, (text) => text.includes(`CPU profile ${join(logDir, name)}`), seen("the log line naming the capture"))

            // A second stall inside the cooldown: skipped, said in the log, and no second capture (a skip begins none).
            expect(yield* block(3_000)).toBeGreaterThan(0)
            yield* until(logText, (text) => text.includes("no capture (one per"), seen("the skipped stall's log line"))
            expect(yield* profiles).toEqual([name])
          }),
        ),
      ),
    ),
    TIMEOUT_MS,
  )
})
