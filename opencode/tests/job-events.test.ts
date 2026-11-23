// accept: one at a time (it bounds the backstop-off exit-to-letter time under the sweep's RECOVER_MS).
// A job's end as a durable event on the real host: the process runner
// (mods/wake/process/runner.ts) launches the real runner (cmd/wake/job.ts,
// detached in its own session) in a scratch directory, with a harmless
// command that writes a marker and one progress line and exits 3. Nothing
// here writes an exit, a claim or a marker for the runner: what is read back
// is what the runner wrote. No OpenCode service, cron job or model is started:
// the runner's `opencode` launcher is `/usr/bin/false`, and its call to the
// service (the wakes' `due`, through the OS backstop's script) reaches a
// scratch HTTP server on a scratch port that holds the call unanswered.
//
// - The backstop on: the exit is on disk, typed (failed, generation 1, its
//   sequence after the progress bytes), before the runner's call arrives; while
//   that call is held unanswered a reader reads the end; a second runner
//   started on the same job runs nothing.
// - The backstop off (the runner calls nothing): the wakes over this runner
//   hear the end from the job's own watch and deliver one letter; the runner's
//   call coming late adds nothing; the watch is closed. A host out of watches
//   still runs the job, and the call delivers it.
// - A claim naming a live process with another start time reads lost, and a
//   kill does not signal that process; the same pid with its start reads
//   running.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Clock, Console, Context, Deferred, Effect, Exit, FileSystem, Layer, Logger, Option, Path, Random, Ref, Schedule, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { describe, expect, it } from "effect-bun-test"
import { type JobSpec, RECOVER_MS } from "../mods/wake/job.ts"
import * as MemoryBackstop from "../mods/wake/memory/backstop.ts"
import * as MemoryChecks from "../mods/wake/memory/checks.ts"
import * as MemoryCourier from "../mods/wake/memory/courier.ts"
import * as MemoryOpener from "../mods/wake/memory/opener.ts"
import * as MemoryStore from "../mods/wake/memory/store.ts"
import * as Model from "../mods/wake/model.ts"
import * as ProcessRunner from "../mods/wake/process/runner.ts"
import { FILES, processStart, writeAtomic } from "../mods/wake/process/supervise.ts"
import { Changes, Runner } from "../mods/wake/service.ts"
import { WAKES } from "../mods/wake/wake.ts"
import { withProcessEnv } from "./git-repo.ts"

const PROCESS = withProcessEnv({})
const PASSWORD = "job-events-fixture"
const SESSION = "ses_fixture"

/** A request URL's path: the runner's call carries its location as a query. */
const pathOf = (url: string) => url.split("?")[0] || url

/** A condition the real host reaches: looked at every 20 ms, for at most `ms`. */
const until = <A,>(look: Effect.Effect<Option.Option<A>>, ms = 20_000) =>
  look.pipe(
    Effect.flatMap((found) => Option.match(found, { onNone: () => Effect.fail("pending" as const), onSome: Effect.succeed })),
    Effect.retry({ schedule: Schedule.spaced("20 millis"), times: Math.ceil(ms / 20) }),
    Effect.orDie,
  )

const ExitRecord = Schema.Struct({ exitCode: Schema.NullOr(Schema.Number), endedAt: Schema.Number, disposition: Schema.optional(Schema.String), generation: Schema.optional(Schema.Number), sequence: Schema.optional(Schema.Number) })
const Claim = Schema.Struct({ pid: Schema.Number, startedAt: Schema.Number, start: Schema.String })
const Service = Schema.Struct({ url: Schema.String, password: Schema.String, pid: Schema.Number })

/** The scratch folders one test runs in, and the runner's paths. */
const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "job-events-" })
  const dirs = { home: path.join(base, "home"), state: path.join(base, "state"), work: path.join(base, "work"), root: path.join(base, "jobs") }
  for (const dir of [dirs.home, dirs.work, dirs.root, path.join(dirs.state, "opencode")]) yield* fs.makeDirectory(dir, { recursive: true })
  const script = yield* path.fromFileUrl(new URL("../cmd/wake/job.ts", import.meta.url))
  const env = { HOME: dirs.home, XDG_STATE_HOME: dirs.state, PATH: PROCESS["PATH"] || "/usr/bin:/bin" }
  return { ...dirs, base, script, env, marker: path.join(base, "marker"), fs, path }
})

type Scratch = Effect.Success<typeof scratch>

/** A process runner over the scratch root; `opencode` set is the backstop on (the runner calls the service), unset off. */
const runnerOf = (at: Scratch, more: Partial<ProcessRunner.Config> = {}) =>
  ProcessRunner.layer({
    root: at.root,
    bun: "bun",
    script: at.script,
    platform: "darwin",
    env: at.env,
    exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" }),
    ...more,
  })

const idOf = Effect.map(Random.nextIntBetween(0, 36 ** 6 - 1), (n) => `j${n.toString(36).padStart(6, "0")}`)

const specOf = (at: Scratch, id: string, setAt: number): JobSpec => ({
  id,
  sessionID: SESSION,
  directory: at.work,
  command: `printf job-events-marker > '${at.marker}'; printf 'step\\n' >> "$JOB_DRIP"; exit 3`,
  cwd: at.work,
  note: "fixture",
  heavy: false,
  timeoutSeconds: 60,
  setAt,
  generation: 1,
})

/** The wakes' model of the scratch work directory over `runner`, its letters going to `sessions`; `recoverMs` is its sweep's period. */
const wakesOver = (at: Scratch, sessions: MemoryCourier.MemorySessions, runner: Layer.Layer<Runner>, recoverMs = RECOVER_MS) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Model.layer({ directory: at.work, settleMs: 0, recoverMs }).pipe(
        Layer.provideMerge(runner),
        Layer.provide(MemoryStore.layer(MemoryStore.empty())),
        Layer.provide(MemoryCourier.layer(sessions)),
        Layer.provide(MemoryChecks.layer(MemoryChecks.empty())),
        Layer.provide(MemoryBackstop.layer(MemoryBackstop.empty())),
        Layer.provide(MemoryOpener.layer(MemoryOpener.empty())),
        Layer.provide(Layer.succeed(Changes, Changes.of({ changed: () => Effect.void }))),
      ),
    )
    return { wakes: Context.get(context, Model.WakesModel), runner: Context.get(context, Runner) }
  })

/** A job's end letters in the fixture session: its job letters that are not progress. */
const lettersIn = (sessions: MemoryCourier.MemorySessions) => (id: string) =>
  (sessions.inboxes.get(SESSION) ?? []).filter((received) => received.letter.metadata["id"] === id && received.letter.metadata["progress"] !== true)

/** A watch the host refuses with `code`, thrown as `fs.watch` throws it: an object naming its code. */
const refusedWatch = (code: "ENOSPC" | "EMFILE"): NonNullable<ProcessRunner.Config["watch"]> => () =>
  Option.getOrThrowWith(Option.none(), () => ({ code, message: `${code}: the host refused a watch` }))

/** What the wakes logged, by message, kept for the test to read. */
const logged: Array<unknown> = []
const Keep = Logger.layer([Logger.make(({ message }) => void logged.push(message))])

const readExit = (at: Scratch, id: string) =>
  at.fs.readFileString(at.path.join(at.root, id, FILES.exit)).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ExitRecord))), Effect.option)

describe("durable job events on the real host", () => {
  it.live.layer(Layer.mergeAll(BunServices.layer, BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })))(
    "the backstop on: the runner writes the typed exit before its call; a reader reads the end while the call is held; a second runner runs nothing",
    () =>
      Effect.gen(function* () {
        const at = yield* scratch
        const id = yield* idOf
        const runner = Context.get(yield* Layer.build(runnerOf(at, { opencode: "/usr/bin/false" })), Runner)
        const jobDir = at.path.join(at.root, id)

        // The scratch service: it answers the probe; it holds the wakes' `due` call until the test lets it go.
        const calls = yield* Ref.make<ReadonlyArray<{ readonly id: string; readonly exitOnDisk: boolean; readonly readEnded: boolean; readonly at: number }>>([])
        const called = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const Due = Schema.Struct({ input: Schema.Struct({ id: Schema.String }) })
        yield* HttpServer.serveEffect(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            if (request.headers["authorization"] !== `Basic ${Base64.encode(`opencode:${PASSWORD}`)}`) return HttpServerResponse.text("no", { status: 401 })
            if (pathOf(request.url).endsWith("/api/info")) return yield* HttpServerResponse.json({})
            if (!pathOf(request.url).endsWith(`/api/rpc/${encodeURIComponent(WAKES.id)}/due`)) return HttpServerResponse.text("unknown", { status: 404 })
            const body = yield* HttpServerRequest.schemaBodyJson(Due)
            const read = yield* runner.read(id)
            const exitOnDisk = yield* at.fs.exists(at.path.join(jobDir, FILES.exit))
            const now = yield* Clock.currentTimeMillis
            yield* Ref.update(calls, (list) => [...list, { id: body.input.id, exitOnDisk, readEnded: Option.exists(Option.fromNullishOr(read), (record) => record.run.state === "ended"), at: now }])
            yield* Deferred.done(called, Exit.void)
            yield* Deferred.await(release)
            return yield* HttpServerResponse.json({ output: { outcome: "fired" } })
          }).pipe(Effect.orDie),
        )
        const server = yield* HttpServer.HttpServer
        yield* at.fs.writeFileString(
          at.path.join(at.state, "opencode", "service.json"),
          yield* Schema.encodeEffect(Schema.fromJsonString(Service))({ url: HttpServer.formatAddress(server.address), password: PASSWORD, pid: 1 }),
        )

        yield* runner.launch(specOf(at, id, yield* Clock.currentTimeMillis))
        yield* Deferred.await(called).pipe(
          Effect.timeout("30 seconds"),
          // What the runner's call met, from its own log, when it never came.
          Effect.tapError(() => at.fs.readFileString(at.path.join(at.state, "opencode-wake", "backstop.log")).pipe(Effect.flatMap((log) => Effect.logError(`the runner's call: ${log}`)), Effect.ignore)),
        )
        // The call is held: the exit was on disk before it came, and the end reads now.
        const exit = yield* readExit(at, id)
        const held = yield* Ref.get(calls)
        expect(held.map((call) => ({ id: call.id, exitOnDisk: call.exitOnDisk, readEnded: call.readEnded }))).toEqual([{ id, exitOnDisk: true, readEnded: true }])
        expect(Option.map(exit, (value) => ({ exitCode: value.exitCode, disposition: value.disposition, generation: value.generation, sequence: value.sequence }))).toEqual(
          Option.some({ exitCode: 3, disposition: "failed", generation: 1, sequence: 6 }),
        )
        expect(yield* at.fs.readFileString(at.marker)).toBe("job-events-marker")
        // The claim names the runner with its start (the decode fails without it).
        const claim = yield* at.fs.readFileString(at.path.join(jobDir, FILES.runner)).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Claim))))
        expect(claim.start.length > 0).toBe(true)
        const arrived = Option.all({ call: Arr.head(held), exit })
        expect(Option.isSome(arrived)).toBe(true)
        yield* Option.match(arrived, {
          onNone: () => Effect.void,
          onSome: ({ call, exit: written }) => Console.log(`job-events: backstop on, exit written to the runner's call arriving: ${call.at - written.endedAt} ms`),
        })
        yield* Deferred.done(release, Exit.void)

        // A second runner on the same job finds the claim and runs nothing: no marker, the exit untouched, no call.
        yield* at.fs.remove(at.marker)
        const written = yield* at.fs.readFileString(at.path.join(jobDir, FILES.exit))
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const second = yield* spawner.spawn(ChildProcess.make("bun", [at.script, jobDir], { env: at.env, stdin: "ignore", stdout: "ignore", stderr: "ignore", forceKillAfter: "3 seconds" }))
        expect(Number(yield* second.exitCode)).toBe(0)
        expect(yield* at.fs.exists(at.marker)).toBe(false)
        expect(yield* at.fs.readFileString(at.path.join(jobDir, FILES.exit))).toBe(written)
        expect((yield* Ref.get(calls)).length).toBe(1)
      }).pipe(Effect.scoped),
    60_000,
  )

  it.live.layer(BunServices.layer)(
    "the backstop off: the job's own watch announces its end and one letter goes; the runner's call coming late adds nothing; the watch closes; a host out of watches runs the job and the call delivers it",
    () =>
      Effect.gen(function* () {
        const at = yield* scratch
        const sessions = MemoryCourier.empty(SESSION)
        const lettersOf = lettersIn(sessions)

        // Watched: the letter goes when the exit is written, long before any sweep.
        const watched = yield* wakesOver(at, sessions, runnerOf(at))
        const placed = yield* watched.wakes.job(SESSION, { command: `printf watched > '${at.marker}'; exit 3`, note: "WATCHED" })
        const id = placed.job.id
        expect(yield* watched.runner.watching).toEqual([id])
        const letter = yield* until(Effect.sync(() => Option.fromNullishOr(lettersOf(id)[0])))
        const seenAt = yield* Clock.currentTimeMillis
        const exit = yield* until(readExit(at, id))
        expect(letter.letter.metadata["event"]).toMatchObject({ job: id, generation: 1, disposition: "failed", exitCode: 3, log: `job-log:${id}/1` })
        yield* Console.log(`job-events: backstop off, exit written to the letter seen: ${seenAt - exit.endedAt} ms`)
        expect(seenAt - exit.endedAt).toBeLessThan(RECOVER_MS)
        // The runner's call, late: nothing more.
        expect((yield* watched.wakes.due(id)).outcome).toBe("gone")
        expect(lettersOf(id)).toHaveLength(1)
        expect(yield* watched.runner.watching).toEqual([])

        // Out of watches: the job still runs; the runner's call delivers its end.
        const refusing = yield* wakesOver(
          at,
          sessions,
          runnerOf(at, {
            // A host out of watches: the watch call itself fails, as fs.watch does with ENOSPC or EMFILE.
            watch: refusedWatch("ENOSPC"),
          }),
        )
        const unwatched = (yield* refusing.wakes.job(SESSION, { command: "exit 0", note: "UNWATCHED" })).job.id
        expect(yield* refusing.runner.watching).toEqual([])
        yield* until(readExit(at, unwatched))
        expect(lettersOf(unwatched)).toEqual([])
        expect((yield* refusing.wakes.due(unwatched)).outcome).toBe("fired")
        expect(lettersOf(unwatched)).toHaveLength(1)
      }).pipe(Effect.scoped),
    60_000,
  )

  it.live.layer(Layer.mergeAll(BunServices.layer, Keep))(
    "the backstop off and the host out of watches (ENOSPC, EMFILE at the watch's open): each job still runs and ends; the sweep alone delivers each end once; each fallback is logged with its code",
    () =>
      Effect.gen(function* () {
        const at = yield* scratch
        const sessions = MemoryCourier.empty(SESSION)
        const lettersOf = lettersIn(sessions)
        // A short sweep period stands for RECOVER_MS: with no call (backstop off) and no watch, only the sweep can deliver.
        const recoverMs = 1_500
        const ids = yield* Effect.forEach(["ENOSPC", "EMFILE"] as const, (code) =>
          Effect.gen(function* () {
            const refusing = yield* wakesOver(at, sessions, runnerOf(at, { watch: refusedWatch(code) }), recoverMs)
            const id = (yield* refusing.wakes.job(SESSION, { command: `printf ${code} > '${at.marker}.${code}'`, note: code })).job.id
            expect(yield* refusing.runner.watching).toEqual([])
            return { code, id, wakes: refusing.wakes }
          }),
        )
        for (const { code, id, wakes } of ids) {
          const exit = yield* until(readExit(at, id))
          expect({ code, marker: yield* at.fs.readFileString(`${at.marker}.${code}`), disposition: exit.disposition }).toEqual({ code, marker: code, disposition: "succeeded" })
          const letter = yield* until(Effect.sync(() => Arr.head(lettersOf(id))), 4 * recoverMs + 10_000)
          expect(letter.letter.metadata["event"]).toMatchObject({ job: id, disposition: "succeeded" })
          // The fallback is on record: the warning that names the job and the host's code.
          expect(logged).toContainEqual(["wake: a job is not watched; the sweep finds its end", { id, code }])
          // A late call finds it delivered.
          expect((yield* wakes.due(id)).outcome).toBe("gone")
        }
        // Their entries gone (the late calls found none), nothing can fire again: one letter each.
        expect(ids.map(({ id }) => lettersOf(id).length)).toEqual([1, 1])
      }).pipe(Effect.scoped),
    60_000,
  )

  it.live.layer(BunServices.layer)(
    "a claim whose pid is a live process started at another time reads lost and is never signalled; its own start reads running",
    () =>
      Effect.gen(function* () {
        const at = yield* scratch
        const id = yield* idOf
        const jobDir = at.path.join(at.root, id)
        yield* at.fs.makeDirectory(jobDir, { recursive: true })
        const runner = Context.get(yield* Layer.build(runnerOf(at)), Runner)
        writeAtomic(at.path.join(jobDir, FILES.job), { spec: { ...specOf(at, id, yield* Clock.currentTimeMillis), command: "true" } })
        // A process of the test's own, standing for whatever took a dead runner's pid; stopped with the test's scope.
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const stranger = yield* spawner.spawn(ChildProcess.make("sleep", ["30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", forceKillAfter: "3 seconds" }))
        const pid = Number(stranger.pid)
        const start = yield* until(Effect.sync(() => processStart(pid)))
        writeAtomic(at.path.join(jobDir, FILES.runner), { pid, startedAt: 1, start: "Thu Jan  1 00:00:00 1970" })
        expect((yield* runner.read(id))?.run).toMatchObject({ state: "lost", cause: "runner-gone" })
        expect(yield* runner.kill(id)).toBe(false)
        expect(ProcessRunner.alive(pid)).toBe(true)
        writeAtomic(at.path.join(jobDir, FILES.runner), { pid, startedAt: 1, start })
        expect((yield* runner.read(id))?.run.state).toBe("running")
        yield* stranger.kill({ killSignal: "SIGKILL" })
      }).pipe(Effect.scoped),
    30_000,
  )
})
