import { argv, readableStreamToText, spawn } from "bun"
import { Database } from "bun:sqlite"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Console, Data, Effect, FileSystem, Path, Predicate, Schedule, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { expect, it } from "effect-bun-test"
import fixtures from "../mods/guard/fixtures/holder-v1.json"
import { admissionLauncher } from "../mods/guard/launcher.ts"
import { parseShell } from "../mods/guard/command-line.ts"
import { admittedJobArgv } from "../mods/wake/process/supervise.ts"
import { scratch } from "./scratch.ts"

const fixtureEntry = new URL("./fixtures/host-admit-test-entry.ts", import.meta.url)
const realEntry = new URL("../cmd/guard/host-admit.ts", import.meta.url)
const decode = <S extends Schema.Top>(codec: S) => Schema.decodeUnknownEffect(Schema.fromJsonString(codec))
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const seed = (folder: string, outside = 500) => Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.writeFileString(`${folder}/host-admit-supply.json`, json({ outside })))
const Status = Schema.Struct({
  hostId: Schema.String, bootId: Schema.String, nowBootMs: Schema.Int,
  principal: Schema.Struct({ kind: Schema.Literal("external-runner"), scopeId: Schema.String, epoch: Schema.Int }),
  defaultVolume: Schema.NullOr(Schema.String),
  maximumCpuMilli: Schema.Int,
  maximumMemoryBytes: Schema.Int,
})
const Reply = Schema.Struct({
  id: Schema.NullOr(Schema.String), state: Schema.String, sequence: Schema.Int, reason: Schema.String,
  qualifiedForm: Schema.optionalKey(Schema.String),
})
class CliFixtureUnavailable extends Data.TaggedError("CliFixtureUnavailable")<{ readonly operation: "spawn" | "read" }> {}

const readAdmission = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  leases: Schema.Record(Schema.String, Schema.Struct({
    state: Schema.String, reason: Schema.String,
    request: Schema.Struct({ purpose: Schema.String, demand: Schema.Struct({
      width: Schema.Union([Schema.Number, Schema.Literals(["unknown", "full"])]), memoryBytes: Schema.Number,
    }) }),
    admittedDemand: Schema.NullOr(Schema.Struct({ cpuMilli: Schema.Number })),
  })),
})))

type LeaseRows = ReturnType<typeof readAdmission>["leases"]
const rowsAt = (filename: string) => Effect.try((): LeaseRows => {
  using db = new Database(filename, { readonly: true })
  const body = db.query<{ body: string }, []>("SELECT body FROM admission_v1").get()
  if (!body) return {}
  return readAdmission(body.body).leases
}).pipe(Effect.orElseSucceed((): LeaseRows => ({})))

it.scopedLive("standalone, Guard and Wake carry modeled Go, Bun, Make and Ninja width to the durable claim", () =>
  Effect.gen(function* () {
    if (process.platform !== "darwin") return
    using dir = scratch("hcl-demand-")
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const folder = yield* fs.realPath(dir.path)
    yield* seed(folder)
    const host = yield* decode(Status)((yield* runner(folder)(["host", "status", "--json"])).out)
    const [exe = "bun"] = argv
    const cli = yield* path.fromFileUrl(fixtureEntry)
    const helper = [exe, cli]
    const command = "GOENV=off GOMAXPROCS=2 go test -p 1 -parallel 4 './exact argument'"
    const file = path.join(folder, "guard-wrapper")
    yield* fs.writeFileString(file, admissionLauncher("/bin/sh", helper, parseShell(command)), { mode: 0o700 })
    for (const tool of ["go", "bun", "make", "ninja", "unmodeled"]) {
      yield* fs.writeFileString(path.join(folder, tool), "#!/bin/sh\nprintf 'payload ran\\n' > \"$HCL_MARKER\"\nIFS= read -r done < \"$HCL_RELEASE\"\n", { mode: 0o700 })
    }
    const job = path.join(folder, "wake-job")
    yield* fs.makeDirectory(job, { mode: 0o700 })
    yield* fs.writeFileString(path.join(job, "job.json"), json({
      spec: { id: "j000001", sessionID: "ses_fixture", directory: folder, command, cwd: folder, note: "fixture", heavy: false, timeoutSeconds: 15, setAt: 1 },
    }), { mode: 0o600 })
    const programs = [
      { argv: [...helper, "check", "run", "--", "go", "test", "-p", "4", "-parallel", "4", "./exact argument"], width: 16, env: { GOENV: "off", GOMAXPROCS: "4" } },
      { argv: [file, "-c", command], width: 2 },
      { argv: admittedJobArgv(helper, command, false), width: 2 },
      { argv: [...helper, "wake", job], width: 2 },
      { argv: [...helper, "check", "run", "--", "go", "test", "-p=1", "./fixture"], width: "unknown" },
      { argv: admittedJobArgv(helper, "bun test --parallel=2 ./fixture", false), width: 2 },
      { argv: admittedJobArgv(helper, "make -j2", true), width: 2 },
      { argv: admittedJobArgv(helper, "ninja -j 2", true), width: 2 },
    ]
    for (const [i, { argv: program, env, width }] of programs.entries()) {
      const state = path.join(folder, `state-${i}`)
      const marker = path.join(folder, `payload-ran-${i}`)
      const release = path.join(folder, `payload-release-${i}`)
      const filename = path.join(state, "host-admit", "admission-v1.sqlite")
      const environment = { HOME: folder, XDG_STATE_HOME: state, PATH: `${folder}:/usr/bin:/bin`, HCL_MARKER: marker, HCL_RELEASE: release, ...env }
      const fifo = yield* spawner.exitCode(ChildProcess.make("/usr/bin/mkfifo", [marker, release], {
        stdin: "ignore", forceKillAfter: "1 second",
      }))
      if (Number(fifo) !== 0) return yield* new CliFixtureUnavailable({ operation: "spawn" })
      if (program.includes("wake")) yield* fs.writeFileString(path.join(job, "env.json"), json(environment), { mode: 0o600 })
      const task = yield* Effect.acquireRelease(Effect.try({
        try: () => spawn([...program], {
          cwd: folder, env: environment,
          stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
        }),
        catch: () => new CliFixtureUnavailable({ operation: "spawn" }),
      }), (child) => Effect.sync(() => { if (Predicate.isNull(child.exitCode) && Predicate.isNull(child.signalCode)) child.kill("SIGTERM") }))
      const exit = Effect.promise(() => task.exited)
      yield* Effect.raceFirst(
        spawner.string(ChildProcess.make("/bin/cat", [marker], { stdin: "ignore", forceKillAfter: "1 second" })),
        exit.pipe(Effect.flatMap((code) => Effect.die(`wrapper leg ${i} exited ${code} before its bound payload signalled readiness`))),
      )
      const rows = yield* rowsAt(filename)
      const [row] = Object.values(rows)
      expect(row?.request).toMatchObject({ purpose: "check", demand: { width, memoryBytes: 4 * 2 ** 30 } })
      expect(row?.state).toBe("running")
      const ceiling = host.maximumCpuMilli
      expect(row?.admittedDemand?.cpuMilli).toBe(Math.min(ceiling, Number(width) * 1000 || ceiling))
      const released = yield* Effect.raceFirst(
        spawner.exitCode(ChildProcess.make("/bin/sh", ["-c", "printf 'release\\n' > \"$1\"", "fixture", release], {
          stdin: "ignore", forceKillAfter: "1 second",
        })),
        exit,
      )
      if (Number(released) !== 0) return yield* new CliFixtureUnavailable({ operation: "read" })
      expect(yield* Effect.promise(() => task.exited).pipe(Effect.timeout(6500))).toBe(0)
    }
  }).pipe(Effect.provide(BunServices.layer)),
  100_000,
)

it.scopedLive("Unknown executes; a width-one peer cannot exec until it drains", () =>
  Effect.gen(function* () {
    if (process.platform !== "darwin") return
    using dir = scratch("hcl-r3-fifo-")
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const folder = yield* fs.realPath(dir.path)
    yield* seed(folder)
    const cli = yield* path.fromFileUrl(fixtureEntry)
    const [exe = "bun"] = argv
    const file = path.join(folder, "unmodeled")
    const claimed = path.join(folder, "full-started")
    const next = path.join(folder, "peer-started")
    yield* fs.writeFileString(file, "#!/bin/sh\nprintf '%s\\n' ready > \"$HCL_MARKER\"\nIFS= read -r stop\n", { mode: 0o700 })
    const home = { HOME: folder, XDG_STATE_HOME: `${folder}/state`, XDG_CONFIG_HOME: `${folder}/config`, XDG_DATA_HOME: `${folder}/data` }
    const start = (args: ReadonlyArray<string>, marker: string) => Effect.acquireRelease(
      Effect.try({
        try: () => spawn([exe, cli, ...args], {
          cwd: folder, env: { ...home, HCL_MARKER: marker }, stdin: "pipe", stdout: "ignore", stderr: "pipe", detached: true,
        }),
        catch: () => new CliFixtureUnavailable({ operation: "spawn" }),
      }),
      (task) => Effect.sync(() => {
        task.stdin.end()
        if (Predicate.isNull(task.exitCode) && Predicate.isNull(task.signalCode)) task.kill("SIGTERM")
      }),
    )
    const invoke = runner(folder)
    const host = yield* decode(Status)((yield* invoke(["host", "status", "--json"])).out)
    const filename = path.join(folder, "state", "host-admit", "admission-v1.sqlite")
    const full = yield* start(["check", "run", "--", file, "--parallel=1"], claimed)
    const read = (marker: string) => fs.exists(marker).pipe(
      Effect.repeat({ schedule: Schedule.spaced(50), until: (ok) => ok }), Effect.timeout(6500),
    )
    expect(yield* read(claimed)).toBe(true)
    const [held] = Object.values(yield* rowsAt(filename))
    expect(held?.state).toBe("running")
    expect(held?.request.demand.width).toBe("unknown")
    expect(held?.admittedDemand?.cpuMilli).toBe(host.maximumCpuMilli)
    const waiting = yield* decode(Reply)((yield* invoke(["lease", "request", "--json"], json({
      version: 1, requestId: "peer", principal: host.principal, purpose: "check", tier: "small",
      deadlineBootMs: host.nowBootMs + 30_000,
      demand: { width: 1, cpuMilli: 1000, memoryBytes: 2 ** 30, keys: [], ioClass: "idle",
        volumeReservations: [{ volumeId: host.defaultVolume ?? "missing", bytes: 0 }] },
    }))).out)
    expect(waiting.state).toBe("queued")
    const peer = yield* start(["lease", "run", "--id", waiting.id ?? "missing", "--", "/bin/echo", "peer-ran"], next)
    expect((yield* rowsAt(filename))[waiting.id ?? "missing"]?.state).toBe("queued")
    expect(peer.exitCode).toBeNull()
    full.stdin.write("finish\n")
    expect(yield* Effect.promise(() => full.exited).pipe(Effect.timeout(4500))).toBe(0)
    expect(yield* Effect.promise(() => peer.exited).pipe(Effect.timeout(6500))).toBe(0)
    expect(Object.values(yield* rowsAt(filename)).find((row) => row.request.demand.width === 1)?.state).toBe("released")
    const err = yield* Effect.promise(() => readableStreamToText(full.stderr))
    expect(err.trim().split("\n")).toHaveLength(1)
    expect(err).toContain("no verified tool width")
    expect(err).toContain("whole managed CPU pool")
  }).pipe(Effect.provide(BunServices.layer)),
  25_000,
)

const runner = (folder: string, entry = fixtureEntry) => Effect.fn("HostAdmitTest.invoke")(function* (args: ReadonlyArray<string>, input: string = "") {
  const path = yield* Path.Path
  const cli = yield* path.fromFileUrl(entry)
  const [exe = "bun"] = argv
  const task = yield* Effect.acquireRelease(
    Effect.try({
      try: () => spawn([exe, cli, ...args], {
        cwd: folder, env: { HOME: folder, XDG_STATE_HOME: `${folder}/state`, XDG_CONFIG_HOME: `${folder}/config`, XDG_DATA_HOME: `${folder}/data` },
        stdin: new Blob([input]), stdout: "pipe", stderr: "ignore", detached: true,
      }), catch: () => new CliFixtureUnavailable({ operation: "spawn" }),
    }),
    (child) => Effect.sync(() => { if (Predicate.isNull(child.exitCode) && Predicate.isNull(child.signalCode)) child.kill("SIGTERM") }),
  )
  const out = yield* Effect.tryPromise({ try: () => readableStreamToText(task.stdout), catch: () => new CliFixtureUnavailable({ operation: "read" }) })
  return { out, code: yield* Effect.promise(() => task.exited) }
})

it.scopedLive("the scripted public CLI diagnoses outside CPU without starting a full-width command", () =>
  Effect.gen(function* () {
    if (process.platform !== "darwin") return
    using dir = scratch("hcl-outside-")
    yield* seed(dir.path, 7300)
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const cli = yield* path.fromFileUrl(fixtureEntry)
    const [exe = "bun"] = argv
    const payload = path.join(dir.path, "bun")
    yield* fs.writeFileString(payload, "#!/bin/sh\nprintf 'unexpected exec\\n'\n", { mode: 0o700 })
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => spawn([exe, cli, "check", "run", "--", payload, "test"], {
        cwd: dir.path, env: { HOME: dir.path, XDG_STATE_HOME: dir.path, PATH: "/usr/bin:/bin" },
        stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true,
      })),
      (task) => Effect.sync(() => { if (Predicate.isNull(task.exitCode)) task.kill("SIGTERM") }),
    )
    const filename = path.join(dir.path, "host-admit", "admission-v1.sqlite")
    const rows = yield* rowsAt(filename).pipe(Effect.repeat({
      schedule: Schedule.spaced(25), until: (rows) => Object.values(rows).some(({ reason }) => reason === "outside-busy"),
    }), Effect.timeout(4000))
    expect(Object.values(rows).map(({ state, reason }) => [state, reason])).toEqual([["queued", "outside-busy"]])
    const reader = child.stderr.getReader()
    const first = yield* Effect.promise(() => reader.read()).pipe(Effect.timeout(2500))
    reader.releaseLock()
    expect(new TextDecoder().decode(first.value)).toContain("host busy outside the lease: 7.3 of 12 cores in use. bun test: worker count: pass --parallel=N.")
    expect(child.exitCode).toBeNull()
    child.kill("SIGTERM")
    expect(yield* Effect.promise(() => child.exited)).toBe(143)
    expect(yield* Effect.promise(() => readableStreamToText(child.stdout))).toBe("")
  }).pipe(Effect.provide(BunServices.layer)),
)

it.scopedLive("real sampler smoke: Darwin supply matches independent counters, without launching a payload", () =>
  Effect.gen(function* () {
    if (process.platform !== "darwin") return
    using dir = scratch("hcl-measured-")
    yield* seed(dir.path, 12000)
    const path = yield* Path.Path
    const cli = yield* path.fromFileUrl(realEntry)
    const script = yield* path.fromFileUrl(new URL("./fixtures/host-admit-measured.py", import.meta.url))
    const [exe = "bun"] = argv
    const result = yield* Effect.acquireUseRelease(
      Effect.sync(() => spawn(["/usr/bin/python3", script, dir.path, exe, cli], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })),
      (child) => Effect.all([Effect.promise(() => child.exited), Effect.promise(() => readableStreamToText(child.stdout)),
        Effect.promise(() => readableStreamToText(child.stderr))], { concurrency: 3 }),
      (child) => Effect.sync(() => { if (Predicate.isNull(child.exitCode)) child.kill("SIGTERM") }),
    )
    const [code, output, error] = result
    expect({ code, error }).toEqual({ code: 0, error: "" })
    expect(output).toContain("positive leg")
    yield* Console.log(output.trim())
  }).pipe(Effect.provide(BunServices.layer)),
  20_000,
)

it.scopedLive("v1 JSONL holder input works across fresh CLI processes; scanner cannot forge a terminal event", () =>
  Effect.gen(function* () {
    using dir = scratch("host-admit-cli-")
    yield* seed(dir.path)
    const invoke = runner(dir.path)
    const status = yield* invoke(["host", "status", "--json"])
    expect(status.code).toBe(0)
    const host = yield* decode(Status)(status.out)
    const disk = fixtures.fixtures.disk
    const record = { ...disk, hostId: host.hostId, bootId: host.bootId, producerId: host.principal.scopeId, sampleBootMs: host.nowBootMs }
    const put = ["holder", "put", "--json"]
    const stored = yield* invoke(put, json(record))
    expect(stored.code).toBe(0)
    expect(yield* invoke(put, json(record))).toEqual(stored)
    const forged = yield* invoke(put, json({ ...record, state: "terminal", producerSeq: 2 }))
    expect(forged.code).toBe(2)
    const duplicateKey = json(record).replace(`"version":1`, `"version":99,"version":1`)
    expect((yield* invoke(put, duplicateKey)).code).toBe(2)
    expect((yield* invoke(put, " ".repeat(262_145))).code).toBe(2)
    const listing = yield* invoke(["holder", "list", "--json"])
    const page = yield* decode(Schema.Struct({ complete: Schema.Boolean, records: Schema.Array(Schema.Json) }))(listing.out)
    const row = yield* Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.Int }))(page.records[0])
    expect(page.complete).toBe(true)
    expect(page.records).toEqual([{ ...record, revision: row.revision }])
    expect(row.revision).toBeGreaterThan(0)
  }).pipe(Effect.provide(BunServices.layer)),
)

it.scopedLive("the standalone API binds request identity to the caller, not the submitted principal", () =>
  Effect.gen(function* () {
    using dir = scratch("host-admit-owner-")
    yield* seed(dir.path)
    const invoke = runner(dir.path)
    const host = yield* decode(Status)((yield* invoke(["host", "status", "--json"])).out)
    const draft = {
      version: 1, requestId: "intent-fixture", principal: host.principal,
      purpose: "exclusive-check", tier: "small", deadlineBootMs: host.nowBootMs + 15_000,
      demand: { width: 1, cpuMilli: 1000, memoryBytes: 0, volumeReservations: [{ volumeId: host.defaultVolume ?? "unavailable", bytes: 0 }], keys: [], ioClass: "idle" },
    }
    const req = ["lease", "request", "--json"]
    const impersonation = yield* invoke(req, json({ ...draft, principal: { ...draft.principal, kind: "native-shell" } }))
    expect(impersonation.code).toBe(2)
    expect(impersonation.out).toContain(`"reason":"wrong-owner"`)
    const reply = yield* decode(Reply)((yield* invoke(req, json(draft))).out)
    expect(["queued", "granted"]).toContain(reply.state)
    expect(reply.id).not.toBeNull()
    const ref = reply.id ?? "missing"
    const cancel = yield* invoke(["lease", "cancel", "--id", ref, "--json"])
    expect((yield* decode(Reply)(cancel.out)).state).toBe("cancelled")
    const watch = ["lease", "watch", "--id", ref, "--after", String(reply.sequence), "--json"]
    const replay = yield* invoke(watch)
    expect(replay).toEqual(cancel)
    expect(yield* invoke(watch)).toEqual(replay)
    const { width: _width, ...legacyDemand } = draft.demand
    const legacy = { ...draft, requestId: "legacy-width", demand: legacyDemand }
    const held = yield* decode(Reply)((yield* invoke(req, json(legacy))).out)
    expect(["queued", "granted"]).toContain(held.state)
    expect(held.id).not.toBeNull()
    expect((yield* invoke(["lease", "cancel", "--id", held.id ?? "missing", "--json"])).code).toBe(0)
  }).pipe(Effect.provide(BunServices.layer)),
)

it.scopedLive("public CLI refuses an impossible predecessor before ticketing and still grants the next qualified check", () =>
  Effect.gen(function* () {
    if (process.platform !== "darwin") return
    using dir = scratch("hcl-frontier-")
    yield* seed(dir.path)
    const invoke = runner(dir.path)
    const host = yield* decode(Status)((yield* invoke(["host", "status", "--json"])).out)
    const draft = {
      version: 1, requestId: "fixture", principal: host.principal, purpose: "check", tier: "small",
      deadlineBootMs: host.nowBootMs + 30_000,
      demand: { width: 1, cpuMilli: 1000, memoryBytes: 2 ** 30, ioClass: "idle", keys: [],
        volumeReservations: [{ volumeId: host.defaultVolume ?? "missing", bytes: 0 }] },
    }
    const submit = (request: typeof draft) => invoke(["lease", "request", "--json"], json(request))
    const review = decode(Reply)
    const impossible = [
      { ...draft, requestId: "memory", demand: { ...draft.demand, memoryBytes: host.maximumMemoryBytes + 1 } },
      { ...draft, requestId: "volume", demand: { ...draft.demand, volumeReservations: [{ volumeId: "not-mounted", bytes: 0 }] } },
      { ...draft, requestId: "class", purpose: "class-not-offered" },
      { ...draft, requestId: "width", demand: { ...draft.demand, width: 0 } },
    ]
    for (const [i, reason] of ["memory-limit", "unknown-volume", "unsupported-class", "invalid-width"].entries()) {
      const request = impossible[i]
      if (!request) return yield* Effect.die("missing ungrantable fixture")
      const reply = yield* submit(request)
      expect(reply.code).toBe(2)
      expect(reply.out).toContain(`"reason":"${reason}"`)
      expect(reply.out).toContain(`"qualifiedForm":`)
      expect(reply.out).not.toContain(`"id":"`)
    }
    const younger = yield* review((yield* submit(draft)).out)
    const id = younger.id ?? "missing"
    const granted = yield* invoke(["lease", "status", "--id", id, "--json"]).pipe(Effect.flatMap(({ out }) => review(out)),
      Effect.repeat({ schedule: Schedule.spaced(100), until: (row) => row.state === "granted" }), Effect.timeout(6500))
    expect(granted.state).toBe("granted")
    expect((yield* invoke(["lease", "cancel", "--id", id, "--json"])).code).toBe(0)
    const older = yield* review((yield* invoke(["lease", "request", "--json"], json({
      ...draft, requestId: "host-wide", demand: { ...draft.demand, width: "unknown" },
    }))).out)
    expect(["queued", "granted"]).toContain(older.state)
    const successor = yield* review((yield* submit({ ...draft, requestId: "successor" })).out)
    expect(successor.state).toBe("queued")
    expect((yield* invoke(["lease", "cancel", "--id", older.id ?? "missing", "--json"])).code).toBe(0)
    const after = yield* invoke(["lease", "status", "--id", successor.id ?? "missing", "--json"]).pipe(
      Effect.flatMap(({ out }) => review(out)),
      Effect.repeat({ schedule: Schedule.spaced(100), until: (row) => row.state === "granted" }), Effect.timeout(6500),
    )
    expect(after.state).toBe("granted")
    expect((yield* invoke(["lease", "cancel", "--id", successor.id ?? "missing", "--json"])).code).toBe(0)
  }).pipe(Effect.provide(BunServices.layer)),
  20_000,
)

it.scopedLive("Wake's real durable entry fails closed before heavy payload exec and still runs a light job", () =>
  Effect.gen(function* () {
    using dir = scratch("host-admit-wake-")
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const folder = yield* fs.realPath(dir.path)
    const script = yield* path.fromFileUrl(new URL("../cmd/wake/job.ts", import.meta.url))
    const [exe = "bun"] = argv
    const env = { HOME: folder, XDG_STATE_HOME: "relative-is-invalid", XDG_CONFIG_HOME: path.join(folder, "config") }
    const run = Effect.fn("HostAdmitTest.durableJob")(function* (id: string, command: string, heavy: boolean) {
      const cwd = path.join(folder, id)
      yield* fs.makeDirectory(cwd, { mode: 0o700 })
      const spec = { id, sessionID: "ses_fixture", directory: folder, command, cwd, note: "fixture", heavy, timeoutSeconds: 8, setAt: 1 }
      yield* fs.writeFileString(path.join(cwd, "job.json"), json({ spec }), { mode: 0o600 })
      yield* fs.writeFileString(path.join(cwd, "env.json"), json(env), { mode: 0o600 })
      const runner = yield* Effect.acquireRelease(Effect.try({
        try: () => spawn([exe, script, cwd], { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }),
        catch: () => new CliFixtureUnavailable({ operation: "spawn" }),
      }), (task) => Effect.sync(() => { if (Predicate.isNull(task.exitCode) && Predicate.isNull(task.signalCode)) task.kill("SIGTERM") }))
      expect(yield* Effect.promise(() => runner.exited).pipe(Effect.timeout(2500))).toBe(0)
      const log = yield* fs.readFileString(path.join(cwd, "log"))
      const exit = yield* fs.readFileString(path.join(cwd, "exit.json"))
      return { log, exit }
    })
    const heavy = yield* run("j000001", "printf 'heavy-payload-ran\\n'", true)
    expect(heavy.log).toContain(`"reason":"invalid-request"`)
    expect(heavy.log).not.toContain("heavy-payload-ran")
    expect(heavy.exit).toContain(`"exitCode":2`)
    const classified = yield* run("j000002", "printf 'classified-payload-ran\\n'; bun test", false)
    expect(classified.log).toContain(`"reason":"invalid-request"`)
    expect(classified.log).not.toContain("classified-payload-ran")
    const light = yield* run("j000003", "printf 'light-payload-ran\\n'", false)
    expect(light.log).toBe("light-payload-ran\n")
    expect(light.exit).toContain(`"exitCode":0`)
  }).pipe(Effect.provide(BunServices.layer)),
)

it.scopedLive("the public CLI names both versions when its private store is newer", () =>
  Effect.gen(function* () {
    using dir = scratch("host-admit-future-format-")
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const journal = path.join(dir.path, "state", "host-admit")
    yield* fs.makeDirectory(journal, { recursive: true, mode: 0o700 })
    const file = path.join(journal, "admission-v1.sqlite")
    yield* Effect.sync(() => {
      using db = new Database(file)
      db.exec("PRAGMA user_version=7")
    })
    const { code, out } = yield* runner(dir.path, realEntry)(["holder", "list", "--json"])
    expect(code).toBe(2)
    expect(out).toContain(`"reason":"incompatible"`)
    expect(out).toContain("Host admission store v7; this binary supports v2. Upgrade host-admit to support store v7.")
  }).pipe(Effect.provide(BunServices.layer)),
)
