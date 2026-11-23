import { Clock, Console, Effect, FileSystem, Option, Path, Predicate, Schedule, Stream } from "effect"
import { AdmissionUnavailable, type Address, type Input, type Lease, type Observation } from "@dotfiles/opencode-guard/admission"
import { type Request } from "@dotfiles/opencode-guard/admission-wire"
import { argvWidth, demandOnVolume, type CheckDemand } from "@dotfiles/opencode-guard/check-demand"
import { POLICY } from "@dotfiles/opencode-guard/host-supply"
import * as Supply from "@dotfiles/opencode-guard/process/admission"
import * as Scope from "@dotfiles/opencode-guard/process/launchers"
import { attachGrant, runAfterClaim } from "@dotfiles/opencode-guard/process/linux-controller"
import { foregroundOf, foregroundScope } from "@dotfiles/opencode-guard/process/terminal"
import * as Journal from "@dotfiles/opencode-guard/sqlite/admission"

const fail = (reason: ConstructorParameters<typeof AdmissionUnavailable>[0]["reason"]) => new AdmissionUnavailable({ reason })
const active = (lease: Lease) => lease.state === "running" || lease.state === "draining"
const granting = (lease: Lease) => lease.state === "queued" || lease.state === "granted"
const terminal = (state: string) => ["released", "expired", "cancelled", "refused"].includes(state)
const cut = (now: number): Observation => ({ now })

export interface Config {
  readonly cwd: string
  readonly directory: string
  readonly executable: string
  readonly script: string
  readonly onForeground?: (owned: boolean) => void
}

const inspectOwner = Effect.fn("HostAdmission.inspectOwner")(function* (
  host: Supply.BootHost, native: Journal.NativeJournal, row: Lease,
) {
  if (terminal(row.state)) return Option.none()
  const peer = yield* native.peer(row.owner)
  if (Predicate.isNull(peer)) return Option.none()
  const liveness = yield* Scope.actorLiveness(host, peer.pid, peer.start)
  if (liveness !== "gone") return Option.none()
  return Option.some({ op: "observe", id: row.id, owner: row.owner, generation: row.generation, liveness,
    evidence: Supply.ref("owner-gone", `${host.bootId}:${peer.pid}:${peer.start}`),
  } satisfies Input)
})

const inspectScope = Effect.fn("HostAdmission.inspectScope")(function* (
  host: Supply.BootHost, native: Journal.NativeJournal, row: Lease,
) {
  if (!active(row) || Option.isNone(row.binding)) return Option.none()
  const stored = yield* native.scope(row.binding.value)
  if (Option.isNone(stored)) return Option.none()
  const pin = stored.value
  const liveness = yield* Scope.scopeLiveness(host, pin)
  if (liveness === "gone") return Option.some<Input>({ op: "drain", id: row.id, generation: row.generation, binding: pin.ref,
    evidence: Supply.ref("drained", `${host.bootId}:${pin.ref}`),
  } satisfies Input)
  if ((yield* Scope.actorLiveness(host, pin.pid, pin.start)) !== "gone") return Option.none()
  const evidence = Supply.ref("launcher-gone", pin.ref)
  if (row.reason !== "owner-gone" || !Option.exists(row.evidence, (prior) => prior === evidence)) {
    const now = yield* Supply.clockOf(host)
    const holders = yield* Scope.descriptorHolders(host, pin.descriptor)
    const commands = holders.map(({ pid, start, command }) => ({ pid, start, command, inspect: `/bin/ps -p ${pid} -o pid=,lstart=,comm=` }))
    if (yield* native.hold(pin.ref, now, { liveness, holders: commands })) {
      // Do not put machine-local locators in the v1 response or holder rows.
      // This local diagnostic is for inspection, never a PID-based actuator.
      if (commands.length > 0) {
        const localEvidence = commands.map(({ pid, start, command, inspect }) => `${pid} start=${start} ${command}\n  ${inspect}`)
        yield* Console.error(`host-admit: ${row.id} remains held since boot-ms ${now}; inspect the current identity before any operator action:\n${localEvidence.join("\n")}`)
      }
    }
  }
  return Option.some<Input>({
    op: "observe", id: row.id, owner: row.owner, generation: row.generation, liveness: "gone", evidence,
  } satisfies Input)
})

const loop = Schedule.spaced(500)

export const open = Effect.fn("HostAdmission.open")(function* (config: Config) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const host = yield* Supply.bootHost()
  const foreground = foregroundOf(host)
  const filename = path.join(config.directory, "admission-v1.sqlite")
  const { ledger, holder, native } = yield* Journal.open(filename, host, host.kernel.now)
  const caller = yield* Scope.callerOf(host)
  yield* native.remember(caller.owner, caller.pid, caller.start)
  const target = yield* Supply.volumeOf(host, config.cwd).pipe(Effect.option)
  if (Option.isSome(target)) yield* native.volume(target.value.id, target.value.object)

  const cold = Effect.fn("HostAdmission.cold")(function* () {
    const now = yield* Supply.clockOf(host)
    return cut(now)
  })
  const measured = Effect.fn("HostAdmission.meteredScopes")(function* () {
    const state = yield* ledger.inspect()
    const live = Object.values(state.leases).filter(active)
    return yield* Effect.forEach(live, (row) => Effect.gen(function* () {
      if (Option.isNone(row.binding) || Option.isNone(row.admittedDemand)) return yield* fail("unqualified")
      const pin = yield* native.scope(row.binding.value)
      if (Option.isNone(pin) || Option.isNone(pin.value.cgroup)) return yield* fail("unqualified")
      return { binding: pin.value.ref, path: pin.value.cgroup.value, cpuMilli: row.admittedDemand.value.cpuMilli } satisfies Supply.MeteredScope
    }))
  })
  const measure = Effect.fn("HostAdmission.measure")(function* () {
    const now = yield* Supply.clockOf(host)
    const probe = Supply.ref("probe", `${caller.owner}:${host.kernel.core.symbols.getpid()}:${now}`)
    if (!(yield* native.probe(probe, now))) return cut(now)
    return yield* Effect.ensuring(
      Effect.gen(function* () {
        const mounts = yield* native.volumes()
        const locations = { linux: measured, darwin: () => Effect.succeed([]) }
        const scopes = yield* locations[host.platform]()
        return yield* Supply.observationOf(host, mounts, scopes)
      }).pipe(Effect.catchTag("AdmissionUnavailable", cold)),
      native.finish(probe).pipe(Effect.ignore),
    )
  })

  const inspect = Effect.fn("HostAdmission.reconcile")(function* (observation: Observation) {
    const state = yield* ledger.inspect()
    for (const row of Object.values(state.leases)) {
      if (row.state === "queued" || row.state === "granted") {
        const owner = yield* inspectOwner(host, native, row)
        if (Option.isSome(owner)) yield* ledger.transact(owner.value, cut(observation.now))
      } else if (active(row)) {
        const scope = yield* inspectScope(host, native, row)
        if (Option.isSome(scope)) yield* ledger.transact(scope.value, cut(observation.now))
        else {
          const owner = yield* inspectOwner(host, native, row)
          if (Option.isSome(owner)) yield* ledger.transact(owner.value, cut(observation.now))
        }
      }
    }
  })

  const step = Effect.fn("HostAdmission.step")(function* (input: Input) {
    yield* inspect(yield* cold())
    const observation = yield* measure()
    const now = yield* Supply.clockOf(host)
    return yield* ledger.transact(input, { ...observation, now })
  })

  const request = Effect.fn("HostAdmission.request")(function* (draft: Request, owner = caller.owner) {
    const principal = caller.principal
    const claimed = draft.principal
    if (claimed.kind !== principal.kind || claimed.scopeId !== principal.scopeId || claimed.epoch !== principal.epoch)
      return yield* fail("wrong-owner")
    return (yield* step({ op: "request", request: draft, owner })).reply
  })

  const status = Effect.fn("HostAdmission.status")(function* (id: string) {
    if (!id.startsWith(`${host.bootId}:`)) return yield* fail("stale")
    return (yield* step({ op: "status", id, owner: caller.owner })).reply
  })

  const waitForChange = (timeoutMs: number) => {
    const event = Stream.runHead(fs.watch(config.directory)).pipe(Effect.timeoutOption(timeoutMs), Effect.ignore)
    // SQLite's own observation writes also reach the watcher. Coalesce them
    // so competing local waiters cannot wake/measure in a tight loop.
    return Effect.all([event, Effect.sleep(125)], { concurrency: 2, discard: true })
  }

  const watch = Effect.fn("HostAdmission.watch")(function* (id: string, after: number) {
    const address = { id, owner: caller.owner }
    if (!id.startsWith(`${host.bootId}:`)) return yield* fail("stale")
    for (;;) {
      const found = yield* ledger.replay(address, after)
      if (found.length > 0) return found
      const current = yield* status(id)
      if (current.state === "refused") return yield* fail(current.reason)
      if (terminal(current.state)) return yield* ledger.replay(address, after)
      // Arm notification, then re-read to cover the publish/subscribe race.
      yield* Effect.raceFirst(
        waitForChange(500),
        ledger.replay(address, after).pipe(Effect.flatMap((events) => {
          if (events.length > 0) return Effect.void
          return Effect.never
        })),
      )
    }
  })

  const wait = Effect.fn("HostAdmission.awaitGrant")(function* (address: Address) {
    for (;;) {
      const { reply, state } = yield* step({ op: "status", ...address })
      if (terminal(reply.state)) return yield* fail(reply.reason)
      const row = state.leases[address.id]
      if (!row) return yield* fail("unknown-id")
      if (!granting(row)) return yield* fail("stale")
      if (row.state === "granted") return row
      yield* waitForChange(500)
    }
  })

  const supervised = Effect.fn("HostAdmission.supervised")(function* (
    row: Lease, pin: Scope.ProcessPin, fd: number, stopGroup: Effect.Effect<void, AdmissionUnavailable>,
    argv: ReadonlyArray<string>, environment?: Readonly<Record<string, string>>,
  ) {
    const fence = { id: row.id, generation: row.generation, binding: pin.ref }
    const control = yield* foregroundScope(host, foreground, (paused) => cold().pipe(
      Effect.flatMap((at) => ledger.transact({ op: "job-control", ...fence, paused }, at)), Effect.asVoid,
    ), config.onForeground ?? (() => {}))
    const work = yield* Scope.spawnOwned(Scope.payloadArgv(host, argv), config.cwd, environment, fd)
    let stopping = false
    const stop = Effect.suspend(() => {
      if (stopping) return Effect.void
      stopping = true
      if (host.platform === "darwin") return stopGroup.pipe(Effect.ignore)
      return Scope.stopOwnedCgroup(host, pin).pipe(Effect.catchTag("AdmissionUnavailable", () => work.stop))
    })
    const keep = Effect.gen(function* () {
      const now = yield* Supply.clockOf(host)
      const tick = yield* ledger.transact({ op: "renew", ...fence }, cut(now))
      if (tick.reply.state !== "running") yield* stop
    }).pipe(Effect.repeat(loop))
    return yield* work.exited.pipe(
      Effect.raceFirst(keep.pipe(Effect.andThen(Effect.never))),
      Effect.raceFirst(control),
      Effect.onError(() => stop),
    )
  })

  const claim = Effect.fn("HostAdmission.claim")(function* (
    row: Lease, args: ReadonlyArray<string>, environment?: Readonly<Record<string, string>>,
  ) {
    if (Option.isNone(row.admittedDemand) || args.length === 0) return yield* fail("invalid-request")
    const demand = row.admittedDemand.value
    const volume = yield* Supply.volumeOf(host, config.cwd)
    if (!demand.volumeReservations.some(({ volumeId }) => volumeId === volume.id)) return yield* fail("unknown-volume")
    return yield* Effect.scoped(Effect.gen(function* () {
      const location = yield* Scope.pinOf(host, row.id, row.generation, demand.cpuMilli, demand.memoryBytes, foreground)
      const watcher = yield* Scope.watchGroup(host, location)
      const attempt = yield* Effect.scoped(Effect.gen(function* () {
        const { fd, descriptor } = yield* Scope.armDescriptor(host, path.join(config.directory, `${location.ref}.lock`))
        const pin = { ...location, descriptor }
        yield* native.pin(pin)
        const { reply } = yield* step({ op: "claim", owner: row.owner, id: row.id, generation: row.generation, binding: pin.ref })
        return yield* runAfterClaim(reply, () => Effect.gen(function* () {
          yield* watcher.arm
          const code = yield* supervised(row, pin, fd, watcher.stop, args, environment)
          return { code, pin }
        }))
      }))
      if (Option.isNone(attempt)) return Option.none()
      const { code, pin } = attempt.value
      const drained = yield* Scope.scopeLiveness(host, pin)
      const fence = { id: row.id, generation: row.generation, binding: pin.ref }
      if (drained === "gone") {
        yield* watcher.disarm
        yield* ledger.transact({ op: "drain", ...fence, evidence: Supply.ref("descriptor-drained", pin.ref) }, yield* cold())
      } else {
        // EOF authorizes the in-group watchdog; escaped holders continue to
        // charge, with no PID-based signalling fallback.
        yield* ledger.transact({ op: "cancel", id: row.id, owner: row.owner }, yield* cold())
        yield* watcher.onLauncherExit
      }
      return Option.some(code)
    }))
  })

  const attach = Effect.fn("HostAdmission.attach")(function* (socket: string) {
    const offer = yield* Scope.takeOffer(host, socket)
    const { leases } = yield* ledger.inspect()
    return yield* attachGrant(offer, Option.fromNullishOr(leases[offer.id]), (row) => claim(row, offer.argv, offer.environment).pipe(
      Effect.map((code) => Option.getOrElse(code, () => 125)),
    ))
  })

  const linux = Effect.fn("HostAdmission.linux")(function* (row: Lease, argv: ReadonlyArray<string>) {
    if (Option.isNone(row.admittedDemand) || row.admittedDemand.value.memoryBytes === 0) return yield* fail("unqualified")
    const demand = row.admittedDemand.value
    const endpoint = yield* Scope.offerToService(host, {
      version: 1, id: row.id, generation: row.generation, owner: row.owner, argv, environment: Scope.localEnvironment(),
    })
    const helper = [config.executable, config.script, "internal-attach", endpoint]
    const proxy = yield* Scope.spawnOwned(Scope.systemdArgv({
      id: row.id, generation: row.generation, cwd: config.cwd, cpuMilli: demand.cpuMilli, memoryBytes: demand.memoryBytes, helper,
    }), config.cwd)
    const code = yield* proxy.exited.pipe(Effect.onInterrupt(() => proxy.stop))
    const observed = yield* step({ op: "status", id: row.id, owner: row.owner })
    const final = observed.state.leases[row.id]
    if (final && Option.isNone(final.binding)) {
      if (code === 125 && granting(final)) return Option.none()
      if (final.generation === row.generation) return yield* fail("unqualified")
    }
    return Option.some(code)
  })

  const begin = Effect.fn("HostAdmission.run")(function* (address: Address, args: ReadonlyArray<string>) {
    for (;;) {
      const row = yield* wait(address)
      const launch = { linux: () => Effect.scoped(linux(row, args)), darwin: () => claim(row, args) }
      const code = yield* launch[host.platform]()
      if (Option.isSome(code)) return code.value
      yield* waitForChange(500)
    }
  })

  const run = Effect.fn("HostAdmission.runCheck")(function* (
    demand: CheckDemand, args: ReadonlyArray<string>,
  ) {
    const now = yield* Supply.clockOf(host)
    if (Option.isNone(target)) return yield* fail("unknown-volume")
    const pid = host.kernel.core.symbols.getpid()
    const self = yield* Scope.processIdentity(host, pid)
    if (Option.isNone(self)) return yield* fail("unavailable")
    const owner = Supply.ref("waiter", `${host.bootId}:${self.value.pid}:${self.value.start}`)
    yield* native.remember(owner, self.value.pid, self.value.start)
    const draft: Request = {
      version: 1, requestId: Supply.ref("request", `${owner}:${now}`), principal: caller.principal,
      purpose: demand.purpose, tier: "standard", deadlineBootMs: now + POLICY.queueMs,
      demand: demandOnVolume(demand, target.value.id),
    }
    const queued = yield* request(draft, owner)
    if (Predicate.isNull(queued.id)) return yield* fail(queued.reason)
    const address = { id: queued.id, owner }
    return yield* begin(address, args).pipe(Effect.onError(() => cold().pipe(
      Effect.flatMap((now) => ledger.transact({ op: "cancel", ...address }, now)), Effect.ignore,
    )))
  })

  const hostStatus = Effect.fn("HostAdmission.hostStatus")(function* () {
    const { sample, now } = yield* measure()
    const state = yield* ledger.inspect()
    return {
      version: 1, hostId: host.hostId, bootId: host.bootId, nowBootMs: now, revision: state.revision, principal: caller.principal,
      defaultVolume: Option.getOrNull(Option.map(target, ({ id }) => id)),
      capabilities: { pressure: sample?.pressure ?? "unknown", controller: sample?.qualification ?? "unavailable", platform: host.platform },
      coresMilli: Option.getOrNull(Option.fromNullishOr(sample?.effectiveCpuMilli)),
      runnable: Option.getOrNull(Option.fromNullishOr(sample?.runnable)),
    }
  })

  return {
    hostStatus, request, status, watch, run, attach,
    put: Effect.fn("HostAdmission.observe")(function* (records: Parameters<typeof holder.putObservations>[1]) {
      return yield* holder.putObservations(caller.owner, records, yield* Supply.clockOf(host))
    }),
    list: holder.list,
    launch: Effect.fn("HostAdmission.launchExternal")(function* (id: string, args: ReadonlyArray<string>) {
      const address = { id, owner: caller.owner }
      const { state } = yield* ledger.transact({ op: "status", ...address }, yield* cold())
      const row = state.leases[id]
      // Do not expose demand for another principal's durable address.
      if (row?.owner === address.owner) {
        const observed = argvWidth(args, Scope.localEnvironment().GOMAXPROCS)
        const { width } = row.request.demand
        if (width === "unknown" || observed === "unknown" || observed > width) return yield* fail("unqualified")
      }
      return yield* begin(address, args)
    }),
    cancel: (id: string) => cold().pipe(Effect.flatMap((at) => ledger.transact({ op: "cancel", id, owner: caller.owner }, at)), Effect.map((next) => next.reply)),
    now: Clock.currentTimeMillis,
  }
})
