import { argv, readableStreamToText, spawn, stdin } from "bun"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Console, Data, Effect, FileSystem, Option, Path, Predicate, Schedule, Schema } from "effect"
import { expect, it } from "effect-bun-test"
import { type Input } from "../mods/guard/admission.ts"
import { owner, request, supply } from "../mods/guard/memory/admission-acceptance.ts"
import { readHolderSnapshot } from "../mods/guard/host-resources.ts"
import { bootHost, readProcess } from "../mods/guard/process/admission.ts"
import { actorLiveness, armDescriptor, descriptorHolders, descriptorLiveness, pinOf, processIdentity, spawnOwned, watchOwnGroup, type ProcessPin } from "../mods/guard/process/launchers.ts"
import { inheritedController, inheritedProcess } from "../mods/guard/process/ownership.ts"
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

const watchdogLeader = Effect.fn("LeaseHarness.watchdogLeader")(function* (folder: string, failure: string) {
  const path = yield* Path.Path
  const host = yield* bootHost()
  const pin = yield* pinOf(host, "watch-fixture", 1, 1000, 1)
  const children: Array<ReturnType<typeof startWatchdog>> = []
  const start = (script: string) => {
    const task = startWatchdog(script)
    children.push(task)
    return task
  }
  const guard = yield* watchOwnGroup(host, pin.pid, start)
  const { fd, descriptor } = yield* armDescriptor(host, path.join(folder, "watchdog.lock"))
  yield* guard.arm
  yield* Console.log(encode(descriptor))
  const payload = yield* spawnOwned(["/bin/sh", "-c", "printf 'ready\\n'; IFS= read -r done"], folder, { HOME: folder }, fd)
  if (failure === "watchdog-first") {
    const first = children[0]
    if (!first) return yield* new FixtureUnavailable({ op: "retained-watchdog" })
    yield* Effect.tryPromise({ try: () => stdin.text(), catch: () => new FixtureUnavailable({ op: "watch-order" }) })
    yield* Effect.sync(() => first.kill("SIGKILL"))
    yield* Effect.promise(() => first.exited)
    yield* guard.stop
  }
  yield* payload.exited
})

const startWatchdog = (script: string) => spawn(["/bin/sh", "-c", script], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })

// The direct child observes exit without polling; the held grandchild
// outlives its original parent and is released by EOF from this test alone.
const reparentProgram = `
import os, select, sys
reader, writer = os.pipe()
original_parent = os.fork()
if original_parent == 0:
    os.close(reader)
    payload = os.fork()
    if payload == 0:
        os.close(writer)
        os.read(0, 1)
        os._exit(0)
    os.write(writer, str(payload).encode())
    os._exit(0)
os.close(writer)
os.close(3)
payload = int(os.read(reader, 64))
os.close(reader)
os.waitpid(original_parent, 0)
if sys.platform == "darwin":
    watch = select.kqueue()
    event = select.kevent(payload, filter=select.KQ_FILTER_PROC,
        flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)
    watch.control([event], 0, 0)
    print(payload, original_parent, flush=True)
    watch.control([], 1)
else:
    watch = select.poll()
    fd = os.pidfd_open(payload)
    watch.register(fd, select.POLLIN)
    print(payload, original_parent, flush=True)
    watch.poll()
`

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
  const [, , , folder = "", failure = "launcher-first"] = argv
  BunRuntime.runMain(Effect.scoped(watchdogLeader(folder, failure)).pipe(Effect.provide(BunServices.layer)))
} else if (import.meta.main && argv[2] === "--fixture-child") {
  const [file = "", op = "", name = "", id = "", pid = "0"] = argv.slice(3)
  BunRuntime.runMain(Effect.scoped(child(file, op, name, id, Number(pid))).pipe(Effect.provide(BunServices.layer)))
} else {
  it.scopedLive("the reopened holder ledger joins a real reparented descendant by descriptor and birth", () =>
    Effect.gen(function* () {
      using tmp = scratch("host-ownership-reparent-")
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const folder = yield* fs.realPath(tmp.path)
      const host = { ...(yield* bootHost()), ...HOST }
      const file = path.join(folder, "fixture.sqlite")
      const account = owner("local-adapter")
      const sample = supply({ cores: 5 })
      const journal = yield* open(file, HOST)
      const offer = yield* journal.ledger.transact({
        op: "request", owner: account,
        request: { ...request("launch-detached"), principal: { kind: "native-shell", scopeId: "session-fixture", epoch: 1 } },
      }, sample)
      const id = Option.getOrThrow(Option.fromNullishOr(offer.reply.id))
      const supervise = Effect.fn("LeaseHarness.ownDetached")(function* (fd: number) {
        return yield* Effect.try({
          try: () => spawn(["python3", "-c", reparentProgram], {
            cwd: folder, env: { HOME: folder, PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
            stdio: ["pipe", "pipe", "ignore", fd], detached: true,
          }),
          catch: () => new FixtureUnavailable({ op: "reparent-start" }),
        })
      })
      const { child, descriptor } = yield* Effect.scoped(Effect.gen(function* () {
        const { fd, descriptor } = yield* armDescriptor(host, path.join(folder, "descendant.lock"))
        const child = yield* supervise(fd)
        return { child, descriptor }
      }))
      const release = Effect.fn("LeaseHarness.releaseDetached")(function* () {
        yield* Effect.sync(() => {
          if (Predicate.isNull(child.exitCode) && Predicate.isNull(child.signalCode)) child.stdin.end()
        })
        return yield* Effect.promise(() => child.exited)
      })
      yield* Effect.addFinalizer(() => Effect.asVoid(release()))
      const first = yield* Effect.acquireUseRelease(
        Effect.sync(() => child.stdout.getReader()),
        (reader) => Effect.tryPromise({ try: () => reader.read(), catch: () => new FixtureUnavailable({ op: "reparent-ready" }) }),
        (reader) => Effect.sync(() => reader.releaseLock()),
      )
      const [pid, originalParent] = new TextDecoder().decode(first.value).trim().split(" ").map(Number)
      if (!pid || !originalParent) return yield* new FixtureUnavailable({ op: "reparent-pid" })
      const parent = Number(yield* readProcess(["/bin/ps", "-p", String(pid), "-o", "ppid="]))
      expect(parent).toBeGreaterThan(0)
      expect(parent).not.toBe(originalParent)
      const process = Option.getOrThrow(yield* processIdentity(host, pid))
      const pin: ProcessPin = {
        bootId: HOST.bootId, ref: "fixture-scope", pid: child.pid, start: process.start, group: child.pid, cgroup: Option.none(), descriptor,
      }
      expect((yield* journal.bind({ id, owner: account, generation: 1 }, pin, sample)).reply.state).toBe("running")
      const evidence = Option.getOrThrow(yield* inheritedProcess(host, pin, process))
      const reopened = Effect.scoped(open(file, HOST).pipe(Effect.flatMap(({ holder }) => readHolderSnapshot(holder))))
      const firstView = yield* reopened
      const secondView = yield* reopened
      const joined = inheritedController(firstView, evidence)
      expect(joined).toEqual(inheritedController(secondView, evidence))
      expect(Option.getOrThrow(joined)).toMatchObject({
        state: "live", owner: { sessionId: "session-fixture" }, placement: { confinementRef: "fixture-scope" },
      })
      expect(yield* release()).toBe(0)
      expect(yield* Effect.scoped(descriptorLiveness(host, descriptor))).toBe("gone")
    }).pipe(Effect.provide(BunServices.layer)),
  )

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
      const probe = Effect.fn("LeaseHarness.watchdogProbe")(function* (failure: string) {
      const isolated = path.join(folder, failure)
      yield* fs.makeDirectory(isolated)
      const launcher = yield* Effect.acquireRelease(Effect.try({
        try: () => spawn([exe, file, "--fixture-watchdog", isolated, failure], {
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
      yield* Effect.sync(() => {
        if (failure === "launcher-first") launcher.kill("SIGKILL")
        else launcher.stdin.end()
      })
      const released = yield* Effect.scoped(descriptorLiveness(host, descriptor)).pipe(
        Effect.repeat({ schedule: Schedule.spaced(25), until: (state) => state === "gone" }),
        Effect.timeout(2500),
      )
      expect(released).toBe("gone")
      })
      yield* probe("launcher-first")
      yield* probe("watchdog-first")
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
