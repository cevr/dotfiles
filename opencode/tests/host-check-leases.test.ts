import { argv, readableStreamToText, spawn } from "bun"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Console, Data, Effect, FileSystem, Option, Path, Predicate, Schedule, Schema } from "effect"
import { expect, it } from "effect-bun-test"
import { type Input } from "../mods/guard/admission.ts"
import { owner, request, supply } from "../mods/guard/memory/admission-acceptance.ts"
import { bootHost } from "../mods/guard/process/admission.ts"
import { actorLiveness, armDescriptor, descriptorHolders, descriptorLiveness, pinOf, processIdentity, spawnOwned, watchGroup } from "../mods/guard/process/launchers.ts"
import { open } from "../mods/guard/sqlite/admission.ts"
import { scratch } from "./scratch.ts"

const HOST = { hostId: "host-fixture", bootId: "boot-fixture" }
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
  id: Schema.NullOr(Schema.String), reason: Schema.String, state: Schema.String, sequence: Schema.Int,
})))
class FixtureUnavailable extends Data.TaggedError("FixtureUnavailable")<{ readonly op: string }> {}
const descriptorOf = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
  file: Schema.String, device: Schema.String, inode: Schema.String,
})))

const watchdogLeader = Effect.fn("LeaseHarness.watchdogLeader")(function* (folder: string) {
  const path = yield* Path.Path
  const host = yield* bootHost()
  const pin = yield* pinOf(host, "watch-fixture", 1, 1000, 1)
  const guard = yield* watchGroup(host, pin)
  const { fd, descriptor } = yield* armDescriptor(host, path.join(folder, "watchdog.lock"))
  yield* guard.arm
  yield* Console.log(encode(descriptor))
  const payload = yield* spawnOwned(["/bin/sh", "-c", "printf 'ready\\n'; IFS= read -r done"], folder, { HOME: folder }, fd)
  yield* payload.exited
})

const untilReady = (stream: ReadableStream<Uint8Array>) => Effect.acquireUseRelease(
  Effect.sync(() => stream.getReader()),
  (reader) => Effect.gen(function* () {
    const text = new TextDecoder()
    let ready = ""
    while (!ready.endsWith("ready\n")) {
      const next = yield* Effect.tryPromise({ try: () => reader.read(), catch: () => new FixtureUnavailable({ op: "watchdog-ready" }) })
      if (next.done) break
      ready += text.decode(next.value, { stream: true })
    }
    return ready
  }),
  (reader) => Effect.sync(() => reader.releaseLock()),
).pipe(Effect.timeout(2500))

const child = Effect.fn("LeaseHarness.child")(function* (database: string, op: string, name: string, lease: string, pid: number) {
  const { ledger, native } = yield* open(database, HOST)
  const at = supply({ cores: 5 })
  const key = { id: lease, owner: owner(name) }
  if (op === "submit" && pid > 0) {
    const host = yield* bootHost()
    const actor = yield* processIdentity(host, pid)
    if (Option.isNone(actor)) return yield* new FixtureUnavailable({ op: "identify-waiter" })
    yield* native.remember(key.owner, pid, actor.value.start)
  }
  if (op === "dead-waiter") {
    const host = yield* bootHost()
    const actor = yield* native.peer(key.owner)
    if (Predicate.isNull(actor) || (yield* actorLiveness(host, actor.pid, actor.start)) !== "gone")
      return yield* new FixtureUnavailable({ op: "prove-waiter-gone" })
  }
  const inputOf = (): Input => {
    switch (op) {
      case "submit": return { op: "request", owner: owner(name), request: request(name, 1000, name === "exclusive") }
      case "claim": return { ...key, op: "claim", generation: 1, binding: `scope-${name}` }
      case "dead-waiter": return { ...key, op: "observe", generation: 0, liveness: "gone", evidence: "os-observed-death" }
      case "scope-exited": return { op: "drain", id: lease, generation: 1, evidence: "scripted-exit", binding: `scope-${name}` }
      default: return { ...key, op: "status" }
    }
  }
  return yield* Console.log(encode((yield* ledger.transact(inputOf(), at)).reply))
})

const one = Effect.fn("LeaseHarness.one")(function* (folder: string, op: string, name: string, id = "", pid = 0) {
  const path = yield* Path.Path
  const file = yield* path.fromFileUrl(new URL("host-check-leases.test.ts", import.meta.url))
  const [exe = "bun"] = argv
  const program = [exe, file, "--fixture-child", path.join(folder, "scratch-admission.sqlite"), op, name, id, String(pid)]
  const started = yield* Effect.acquireRelease(
    Effect.try({ try: () => spawn(program, { cwd: folder, env: { HOME: folder, XDG_STATE_HOME: folder, XDG_CONFIG_HOME: folder }, stdout: "pipe", stderr: "pipe",
      stdin: "ignore", detached: true }), catch: () => new FixtureUnavailable({ op: "start" }) }),
    (child) => Effect.sync(() => { if (Predicate.isNull(child.exitCode) && Predicate.isNull(child.signalCode)) child.kill("SIGTERM") }),
  )
  const text = (stream: ReadableStream<Uint8Array>) => Effect.tryPromise({ try: () => readableStreamToText(stream), catch: () => new FixtureUnavailable({ op: "read" }) })
  const [result, err, code] = yield* Effect.all([text(started.stdout), text(started.stderr), Effect.promise(() => started.exited)], { concurrency: 3 })
  expect({ code, err: err + result.repeat(Number(code !== 0)) }).toEqual({ code: 0, err: "" })
  return yield* decode(result.trim())
})

if (import.meta.main && argv[2] === "--fixture-watchdog") {
  const [, , , folder = ""] = argv
  BunRuntime.runMain(Effect.scoped(watchdogLeader(folder)).pipe(Effect.provide(BunServices.layer)))
} else if (import.meta.main && argv[2] === "--fixture-child") {
  const [file = "", op = "", name = "", id = "", pid = "0"] = argv.slice(3)
  BunRuntime.runMain(Effect.scoped(child(file, op, name, id, Number(pid))).pipe(Effect.provide(BunServices.layer)))
} else {
  it.scopedLive("a detached exec keeps the inherited lease after the launcher releases its own copy", () =>
    Effect.gen(function* () {
      using tmp = scratch("host-lease-descriptor-")
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const folder = yield* fs.realPath(tmp.path)
      const host = yield* bootHost()
      const acquired = yield* Effect.scoped(Effect.gen(function* () {
        const { fd, descriptor } = yield* armDescriptor(host, path.join(folder, "fixture.lock"))
        const payload = yield* Effect.try({
          try: () => spawn(["/bin/sh", "-c", "printf 'ready\\n'; IFS= read -r done"], {
            cwd: folder, env: { HOME: folder }, stdio: ["pipe", "pipe", "ignore", fd], detached: true,
          }),
          catch: () => new FixtureUnavailable({ op: "descriptor-payload" }),
        })
        return { payload, descriptor }
      }))
      const { payload, descriptor } = acquired
      const leave = Effect.sync(() => {
        if (Predicate.isNull(payload.exitCode) && Predicate.isNull(payload.signalCode)) {
          payload.stdin.write("\n")
          payload.stdin.end()
        }
      })
      yield* Effect.addFinalizer(() => leave)
      const first = yield* Effect.tryPromise({
        try: () => payload.stdout.getReader().read(),
        catch: () => new FixtureUnavailable({ op: "descriptor-ready" }),
      }).pipe(Effect.timeout(1500))
      expect(new TextDecoder().decode(first.value)).toBe("ready\n")
      expect(yield* Effect.scoped(descriptorLiveness(host, descriptor))).toBe("held")
      expect((yield* descriptorHolders(host, descriptor)).map(({ pid }) => pid)).toContain(payload.pid)
      yield* leave
      expect(yield* Effect.promise(() => payload.exited)).toBe(0)
      expect(yield* Effect.scoped(descriptorLiveness(host, descriptor))).toBe("gone")
    }).pipe(Effect.provide(BunServices.layer)),
  )
  it.scopedLive("the Darwin in-group watchdog releases the child on launcher death before any numeric-PID actuator", () =>
    Effect.gen(function* () {
      using tmp = scratch("host-lease-watchdog-")
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const folder = yield* fs.realPath(tmp.path)
      const host = yield* bootHost()
      // This leg actually uses a dedicated Darwin process group. It does not
      // represent an attested Linux cgroup; Linux's leg requires provisioning.
      if (host.platform !== "darwin") return
      const file = yield* path.fromFileUrl(new URL("host-check-leases.test.ts", import.meta.url))
      const [exe = "bun"] = argv
      const launcher = yield* Effect.acquireRelease(Effect.try({
        try: () => spawn([exe, file, "--fixture-watchdog", folder], {
          cwd: folder, env: { HOME: folder, XDG_STATE_HOME: folder, XDG_CONFIG_HOME: folder },
          stdio: ["pipe", "pipe", "pipe"], detached: true,
        }),
        catch: () => new FixtureUnavailable({ op: "watchdog-launcher" }),
      }), (task) => Effect.sync(() => {
        task.stdin.end()
        if (Predicate.isNull(task.exitCode) && Predicate.isNull(task.signalCode)) task.kill("SIGTERM")
      }))
      const text = yield* untilReady(launcher.stdout)
      expect(text).toEndWith("ready\n")
      const [stamp = "", ready = ""] = text.split("\n")
      expect(ready).toBe("ready")
      const descriptor = yield* descriptorOf(stamp)
      expect(yield* Effect.scoped(descriptorLiveness(host, descriptor))).toBe("held")
      // The test controls only its acquired launcher. Payload stdin remains
      // open here, so launcher death alone cannot satisfy the read.
      yield* Effect.sync(() => { launcher.kill("SIGKILL") })
      const released = yield* Effect.scoped(descriptorLiveness(host, descriptor)).pipe(
        Effect.repeat({ schedule: Schedule.spaced(25), until: (state) => state === "gone" }),
        Effect.timeout(2500),
      )
      expect(released).toBe("gone")
    }).pipe(Effect.provide(BunServices.layer)),
  )
  it.scopedLive("independent processes share counted FIFO, dead waiters and durable drain", () =>
    Effect.gen(function* () {
      using tmp = scratch("host-lease-process-")
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.realPath(tmp.path)
      const ask = (op: string, owner: string, id = "", pid = 0) => Effect.scoped(one(folder, op, owner, id, pid))
      const first = yield* ask("submit", "shared-1")
      const bound = yield* ask("claim", "shared-1", first.id ?? "missing")
      expect(bound.state).toBe("running")
      const waitingProcess = yield* Effect.acquireRelease(Effect.try({
        try: () => spawn(["/bin/sh", "-c", "IFS= read -r tick"], {
          cwd: folder, env: { HOME: folder }, stdin: "pipe", stdout: "ignore", stderr: "ignore", detached: true,
        }),
        catch: () => new FixtureUnavailable({ op: "waiter" }),
      }), (task) => Effect.sync(() => { task.stdin.end() }))
      const doomed = yield* ask("submit", "exclusive", "", waitingProcess.pid)
      const waiting = yield* ask("submit", "shared-2")
      expect(doomed.state).toBe("queued")
      expect(waiting.state).toBe("queued")
      expect(waiting.reason).toBe("fifo")
      const read = yield* ask("status", "shared-2", waiting.id ?? "missing")
      expect(read.sequence).toBe(waiting.sequence)
      yield* Effect.sync(() => { waitingProcess.stdin.end() })
      yield* Effect.promise(() => waitingProcess.exited).pipe(Effect.timeout(1000))
      const dropped = yield* ask("dead-waiter", "exclusive", doomed.id ?? "missing")
      expect(dropped.state).toBe("cancelled")
      expect((yield* ask("status", "shared-2", waiting.id ?? "missing")).state).toBe("granted")
      const drained = yield* ask("scope-exited", "shared-1", first.id ?? "missing")
      expect(drained.state).toBe("released")
      expect((yield* ask("scope-exited", "shared-1", first.id ?? "missing")).reason).toBe("stale")
    }).pipe(Effect.provide(BunServices.layer)),
  )
}
