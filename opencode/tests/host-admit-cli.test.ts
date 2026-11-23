import { argv, readableStreamToText, spawn } from "bun"
import { Database } from "bun:sqlite"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Path, Predicate, Schedule, Schema } from "effect"
import { expect, it } from "effect-bun-test"
import fixtures from "../mods/guard/fixtures/holder-v1.json"
import { admissionLauncher } from "../mods/guard/launcher.ts"
import { admittedJobArgv } from "../mods/wake/process/supervise.ts"
import { scratch } from "./scratch.ts"

const decode = <S extends Schema.Top>(codec: S) => Schema.decodeUnknownEffect(Schema.fromJsonString(codec))
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const Status = Schema.Struct({
  hostId: Schema.String, bootId: Schema.String, nowBootMs: Schema.Int,
  principal: Schema.Struct({ kind: Schema.Literal("external-runner"), scopeId: Schema.String, epoch: Schema.Int }),
  defaultVolume: Schema.NullOr(Schema.String),
})
const Reply = Schema.Struct({ id: Schema.NullOr(Schema.String), state: Schema.String, sequence: Schema.Int })
class CliFixtureUnavailable extends Data.TaggedError("CliFixtureUnavailable")<{ readonly operation: "spawn" | "read" }> {}

const readAdmission = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  leases: Schema.Record(Schema.String, Schema.Struct({
    state: Schema.String,
    request: Schema.Struct({ purpose: Schema.String, demand: Schema.Struct({ width: Schema.Number, memoryBytes: Schema.Number }) }),
    admittedDemand: Schema.NullOr(Schema.Struct({ cpuMilli: Schema.Number })),
  })),
})))

it.scopedLive("standalone, Guard, and durable Wake all reserve width four or hold before the payload", () =>
  Effect.gen(function* () {
    if (process.platform !== "darwin") return
    using dir = scratch("hcl-demand-")
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const folder = yield* fs.realPath(dir.path)
    const [exe = "bun"] = argv
    const cli = yield* path.fromFileUrl(new URL("../cmd/guard/host-admit.ts", import.meta.url))
    const marker = path.join(folder, "payload-ran")
    const helper = [exe, cli]
    const command = "GOMAXPROCS=4 go test -p 4 -parallel 4 './exact argument'"
    const file = path.join(folder, "guard-wrapper")
    yield* fs.writeFileString(file, admissionLauncher("/bin/sh", helper, command), { mode: 0o700 })
    yield* fs.writeFileString(path.join(folder, "go"), "#!/bin/sh\nprintf 'payload ran\\n' > \"$HCL_MARKER\"\nexec /bin/sleep 8\n", { mode: 0o700 })
    const job = path.join(folder, "wake-job")
    const wake = yield* path.fromFileUrl(new URL("../cmd/wake/job.ts", import.meta.url))
    yield* fs.makeDirectory(job, { mode: 0o700 })
    yield* fs.writeFileString(path.join(job, "job.json"), json({
      spec: { id: "j000001", sessionID: "ses_fixture", directory: folder, command, cwd: folder, note: "fixture", heavy: false, timeoutSeconds: 15, setAt: 1 },
    }), { mode: 0o600 })
    const programs: ReadonlyArray<ReadonlyArray<string>> = [
      [...helper, "check", "run", "--", "go", "test", "-p", "4", "-parallel", "4", "./exact argument"],
      [file, "-c", command],
      admittedJobArgv(helper, command, false),
      [exe, wake, job],
    ]
    for (const [i, program] of programs.entries()) {
      const state = path.join(folder, `state-${i}`)
      const filename = path.join(state, "host-admit", "admission-v1.sqlite")
      const environment = { HOME: folder, XDG_STATE_HOME: state, PATH: `${folder}:/usr/bin:/bin`, HCL_MARKER: marker, GOMAXPROCS: "4" }
      if (program.includes(wake)) yield* fs.writeFileString(path.join(job, "env.json"), json(environment), { mode: 0o600 })
      const task = yield* Effect.acquireRelease(Effect.try({
        try: () => spawn([...program], {
          cwd: folder, env: environment,
          stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
        }),
        catch: () => new CliFixtureUnavailable({ operation: "spawn" }),
      }), (child) => Effect.sync(() => { if (Predicate.isNull(child.exitCode) && Predicate.isNull(child.signalCode)) child.kill("SIGTERM") }))
      const observed = Effect.gen(function* () {
        if (!(yield* fs.exists(filename))) return {}
        return yield* Effect.try(() => {
            using db = new Database(filename, { readonly: true })
            const body = db.query<{ body: string }, []>("SELECT body FROM admission_v1").get()
            if (!body) return {}
            return readAdmission(body.body).leases
        }).pipe(Effect.orElseSucceed(() => ({})))
      })
      const rows = yield* observed.pipe(
        Effect.repeat({ schedule: Schedule.spaced(50), until: (rows) => Object.keys(rows).length > 0 }),
        Effect.timeoutOrElse({ duration: 4500, orElse: () => Effect.die(`wrapper leg ${i} did not write its demand`) }),
      )
      const [row] = Object.values(rows)
      expect(row?.request).toMatchObject({ purpose: "check", demand: { width: 4, memoryBytes: 4 * 2 ** 30 } })
      if (row?.state === "queued") expect(yield* fs.exists(marker)).toBe(false)
      else expect(row?.admittedDemand?.cpuMilli).toBe(16_000)
      task.kill("SIGTERM")
      yield* Effect.promise(() => task.exited).pipe(Effect.timeout(4000))
      if (yield* fs.exists(marker)) yield* fs.remove(marker)
    }
  }).pipe(Effect.provide(BunServices.layer)),
  22_000,
)

const runner = (folder: string) => Effect.fn("HostAdmitTest.invoke")(function* (args: ReadonlyArray<string>, input: string = "") {
  const path = yield* Path.Path
  const cli = yield* path.fromFileUrl(new URL("../cmd/guard/host-admit.ts", import.meta.url))
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

it.scopedLive("v1 JSONL holder input works across fresh CLI processes; scanner cannot forge a terminal event", () =>
  Effect.gen(function* () {
    using dir = scratch("host-admit-cli-")
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
  }).pipe(Effect.provide(BunServices.layer)),
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
