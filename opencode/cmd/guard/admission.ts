import { Array as Arr, Clock, Console, Deferred, Effect, FileSystem, Option, Path, Predicate, Schedule, Stream } from "effect"
import { AdmissionUnavailable, type Address, hostOffer, type Input, type Lease, type Observation, sharedView, type View, volumeStatus } from "@dotfiles/opencode-guard/admission"
import { type Reason, type Request, type Width } from "@dotfiles/opencode-guard/admission-wire"
import { argvModel, demandOnVolume, enforceDeclaredWidth, type CheckDemand } from "@dotfiles/opencode-guard/check-demand"
import { capacityOf, POLICY, unattested } from "@dotfiles/opencode-guard/host-supply"
import * as Supply from "@dotfiles/opencode-guard/process/admission"
import * as Scope from "@dotfiles/opencode-guard/process/launchers"
import type { ScopeProbe } from "@dotfiles/opencode-guard/process/scope-probe"
import { attachGrant, runAfterClaim } from "@dotfiles/opencode-guard/process/linux-controller"
import { foregroundOf, foregroundScope, INTERRUPT_GRACE_MS, type ForegroundInterrupt } from "@dotfiles/opencode-guard/process/terminal"
import * as Journal from "@dotfiles/opencode-guard/sqlite/admission"

const fail = (reason: ConstructorParameters<typeof AdmissionUnavailable>[0]["reason"]) => new AdmissionUnavailable({ reason })
/** A refusal that names its own cause beside its v1 reason. */
const refuse = (reason: ConstructorParameters<typeof AdmissionUnavailable>[0]["reason"], detail: string) =>
  new AdmissionUnavailable({ reason, detail })
const active = (lease: Lease) => lease.state === "running" || lease.state === "draining"
const granting = (lease: Lease) => lease.state === "queued" || lease.state === "granted"
const terminal = (state: string) => ["released", "expired", "cancelled", "refused"].includes(state)
const cut = (now: number): Observation => ({ now })
const envelopeOf = (observation: Observation) => observation.envelope ?? observation.sample?.envelope
/** The controller `host status --json` names, and why when it cannot
 * attest one: the file that was missing or out of range. */
/** Why a command cannot run under a lease of `demand` where no controller
 * enforces its width: a width option that is not a positive integer, or a
 * tool model wider than the lease (or unknown, against a numeric lease).
 * Each refusal names the command, its width and the lease's. */
export const widthMismatch = (demand: Pick<Lease["request"]["demand"], "width" | "cpuMilli">, args: ReadonlyArray<string>,
  model: { readonly width: number | "unknown" | "full" | "invalid"; readonly advice: string }): Option.Option<AdmissionUnavailable> => {
  const command = Option.getOrElse(Option.fromNullishOr(args[0]), () => "the command")
  if (model.width === "invalid") return Option.some(refuse("invalid-width", `${command}: its width option is not a positive integer`))
  // An unknown model under a numeric lease: the lease's declared width is
  // the truth (a script, an unmodeled tool). Only a model that proves the
  // tool wider than the lease, or the whole host, is a mismatch.
  if (Predicate.isNumber(demand.width) && (model.width === "full" ||
    (Predicate.isNumber(model.width) && model.width * 1000 > Math.max(demand.width * 1000, demand.cpuMilli))))
    return Option.some(refuse("unqualified", `${command}'s width by its tool model is ${String(model.width)}, ` +
      `not within the lease's width ${demand.width}: lease it at that width, or pass the tool a width within it (${model.advice})`))
  return Option.none()
}

/** What status says of the launcher: the probe's own result, never a guess. */
export const probeText = (probe: ScopeProbe) => {
  switch (probe.kind) {
    case "scope": return { launcher: "nice + user scope", through: "the guard's nice + user scope launcher" }
    case "none": return { launcher: "nice", through: `nice alone: no user scope for this caller (${probe.why})` }
    case "timed-out": return { launcher: "undecided",
      through: `nice, with a user scope where each launch's own probe answers: this probe timed out after ${probe.afterMs} ms` }
  }
}
const controllerOf = (observation: Observation, launcher: Option.Option<Effect.Success<ReturnType<typeof Scope.groupLauncher>>>) => {
  const attestation = envelopeOf(observation)?.attestation
  // Only a Linux host reads its cgroup tree; the Mac's answer is unchanged.
  const io = Option.match(Option.fromNullishOr(attestation), { onNone: () => ({}), onSome: ({ io }) => ({ io }) })
  if (attestation?.controller === "unattested") {
    const probe = Option.getOrElse(Option.map(launcher, ({ scope }) => scope), (): ScopeProbe => ({ kind: "scope" }))
    const { launcher: kind, through } = probeText(probe)
    return {
      ...io, controller: "unattested", file: attestation.file, why: attestation.why,
      admission: `fixed cap: ${POLICY.unattestedSlots} heavy leases at a time, FIFO, through ${through}`,
      launcher: kind,
    }
  }
  return { ...io, controller: observation.sample?.qualification ?? "unavailable" }
}
const supplyReport = (observation: Observation) => Option.map(Option.fromNullishOr(observation.sample), (sample) => ({
  hostCpuMilli: sample.effectiveCpuMilli, managedCpuMilli: sample.envelope.cpuMilli,
  freeManagedCpuMilli: capacityOf(sample), outsideNoncriticalMilli: sample.outsideNoncriticalMilli,
  pressure: sample.pressure, qualification: sample.qualification, runnable: sample.runnable,
  interval: Option.getOrNull(Option.map(Option.fromNullishOr(sample.interval), ({ before, after }) => ({
    before: { ...before }, after: { ...after },
  }))),
}))
const wholePoolStatus = (reason: Reason, observation: Observation) => {
  if (reason === "granted") return "granted"
  if (reason === "whole-pool-held") return "waiting for running checks to end"
  if (reason === "fifo") return "waiting for older checks in FIFO order"
  const { sample } = observation
  if (sample && reason === "outside-busy") {
    return `host busy outside the lease: ${sample.outsideNoncriticalMilli / 1000} of ${sample.effectiveCpuMilli / 1000} cores in use`
  }
  return `waiting (${reason})`
}
const warnFull = (width: Width, advice: string, observation: Observation, reason: Reason) => {
  const maximum = observation.envelope?.cpuMilli ?? observation.sample?.envelope.cpuMilli ?? 0
  const status = wholePoolStatus(reason, observation)
  if (width === "unknown") return Console.error(`host-admit: no verified tool width; whole managed CPU pool: ${status}. ${advice}`)
  if (width === "full") return Console.error(`host-admit: tool uses host width; whole managed CPU pool: ${status}. ${advice}`)
  if (width * 1000 > maximum) return Console.error(`host-admit: width ${width} clamped to ${maximum} mCPU; whole managed CPU pool: ${status}.`)
  if (width * 1000 === maximum) return Console.error(`host-admit: whole managed CPU pool: ${status}. ${advice}`)
  return Effect.void
}
/** The lease whose owner is the nearest ancestor of this process, if any:
 * a check run inside it is that lease (re-entrant), never a second
 * request queued behind it. */
export const enclosing = (ancestors: ReadonlyArray<number>, owners: ReadonlyArray<{ readonly row: Lease; readonly pid: Option.Option<number> }>) =>
  Option.fromNullishOr(ancestors.values().map((ancestor) => owners.find(({ pid }) => Option.contains(pid, ancestor))).find(Predicate.isNotUndefined)?.row)
const widthText = (row: Lease) => String(Option.getOrElse(Option.map(row.admittedDemand, ({ width }) => width), () => row.request.demand.width))
const describeWait = (width: Width, advice: string) => {
  let reported = false
  return (observation: Observation, reason: Reason) => {
    if (reported) return Effect.void
    // A losing probe slot or stale sample cannot diagnose the host. Wait
    // for the first sampled decision rather than printing a misleading
    // line and its replacement. The journal still tracks every change.
    if (reason === "unavailable" || reason === "stale-sample" || reason === "unqualified") return Effect.void
    reported = true
    return warnFull(width, advice, observation, reason)
  }
}

export interface Config {
  readonly cwd: string
  readonly directory: string
  readonly executable: string
  readonly script: string
  readonly onInterrupt?: (handler: Option.Option<ForegroundInterrupt>) => void
  readonly beforeResume?: Effect.Effect<void>
  readonly sample?: (host: Supply.BootHost, target: Option.Option<string>) =>
    Effect.Effect<Observation, AdmissionUnavailable, FileSystem.FileSystem>
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
/** How often a waiting check looks again: woken by a ledger change, but
 * never sooner than `floorMs` after its last look. */
export const WAITER = { floorMs: 1000, ceilingMs: 5000 } as const

export const open = Effect.fn("HostAdmission.open")(function* (config: Config) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const host = yield* Supply.bootHost()
  const foreground = foregroundOf(host)
  const filename = path.join(config.directory, "admission-v1.sqlite")
  const { ledger, bind, holder, native } = yield* Journal.open(filename, host, host.kernel.now)
  const caller = yield* Scope.callerOf(host)
  yield* native.remember(caller.owner, caller.pid, caller.start)
  const target = yield* Supply.volumeIdentity(config.cwd).pipe(Effect.option)
  if (Option.isSome(target)) yield* native.volume(target.value.id, target.value.object)

  const cold = Effect.fn("HostAdmission.cold")(function* () {
    const now = yield* Supply.clockOf(host)
    return cut(now)
  })
  const measured = Effect.fn("HostAdmission.meteredScopes")(function* () {
    const state = yield* ledger.inspect()
    const live = Object.values(state.leases).filter(active)
    const scopes = yield* Effect.forEach(live, (row) => Effect.gen(function* () {
      if (Option.isNone(row.binding) || Option.isNone(row.admittedDemand))
        return yield* refuse("unqualified", `lease ${row.id} is ${row.state} without a binding or an admitted demand`)
      const pin = yield* native.scope(row.binding.value)
      if (Option.isNone(pin)) return yield* refuse("unqualified", `lease ${row.id}'s binding has no scope record in this ledger`)
      // A group-placed attempt (claimed while the host was unattested) has
      // no cgroup to meter: its CPU counts as outside load, and its grant
      // stays reserved, so the sample only grows more careful.
      const demand = row.admittedDemand.value
      return Option.map(pin.value.cgroup, (path) => ({ binding: pin.value.ref, path, cpuMilli: demand.cpuMilli }) satisfies Supply.MeteredScope)
    }))
    return Arr.getSomes(scopes)
  })
  const measure = Effect.fn("HostAdmission.measure")(function* () {
    if (config.sample) return yield* config.sample(host, Option.map(target, ({ id }) => id))
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
  const attest = Effect.fn("HostAdmission.attest")(function* (observation: Observation) {
    if (observation.envelope || observation.sample?.envelope) return observation
    const mounts = yield* native.volumes()
    const limit = yield* Supply.envelopeOf(host, mounts).pipe(Effect.option)
    if (Option.isNone(limit)) return observation
    return { ...observation, envelope: limit.value }
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

  const supplyForStep = Effect.fn("HostAdmission.supplyForStep")(function* () {
    yield* inspect(yield* cold())
    const observation = yield* measure()
    const verified = yield* attest(observation)
    const now = yield* Supply.clockOf(host)
    return { ...verified, now }
  })
  const step = Effect.fn("HostAdmission.step")(function* (input: Input) {
    const observation = yield* supplyForStep()
    // The caller reads back the host's readings, not only its own sample:
    // what it explains and launches by is what the ledger decided by.
    const result = yield* ledger.transact(input, observation)
    // Read the clock after the transaction: another process may have
    // recorded a newer sample than this caller's `now` while it waited.
    const now = yield* Supply.clockOf(host)
    return { ...result, observation: sharedView(result.state, { ...observation, now }) }
  })

  const request = Effect.fn("HostAdmission.request")(function* (draft: Request, owner = caller.owner) {
    const principal = caller.principal
    const claimed = draft.principal
    if (claimed.kind !== principal.kind || claimed.scopeId !== principal.scopeId || claimed.epoch !== principal.epoch)
      return yield* fail("wrong-owner")
    return yield* step({ op: "request", request: draft, owner })
  })

  const status = Effect.fn("HostAdmission.status")(function* (id: string) {
    if (!id.startsWith(`${host.bootId}:`)) return yield* fail("stale")
    return (yield* step({ op: "status", id, owner: caller.owner })).reply
  })

  const waitForChange = (timeoutMs: number, floorMs = 125) => {
    const event = Stream.runHead(fs.watch(config.directory)).pipe(Effect.timeoutOption(timeoutMs), Effect.ignore)
    // SQLite's own observation writes also reach the watcher. Coalesce them
    // so competing local waiters cannot wake/measure in a tight loop.
    return Effect.all([event, Effect.sleep(floorMs)], { concurrency: 2, discard: true })
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

  // A waiter sleeps (case 6: eight waiters, each re-measuring the host on
  // every other's write, spun about a core). Between full steps it only
  // reads its own row, woken by a ledger change at most every
  // WAITER.floorMs; another caller's step grants it, and a full step comes
  // at least every WAITER.ceilingMs to sample and serve the queue.
  const sleepWhileQueued = Effect.fn("HostAdmission.sleepWhileQueued")(function* (id: string) {
    const start = yield* Supply.clockOf(host)
    for (;;) {
      const now = yield* Supply.clockOf(host)
      if (now - start >= WAITER.ceilingMs) return
      yield* waitForChange(WAITER.ceilingMs - (now - start), WAITER.floorMs)
      const { leases } = yield* ledger.inspect()
      if (leases[id]?.state !== "queued") return
    }
  })

  const wait = Effect.fn("HostAdmission.awaitGrant")(function* (address: Address, explain: ReturnType<typeof describeWait>) {
    for (;;) {
      const { reply, state, observation } = yield* step({ op: "status", ...address })
      if (terminal(reply.state)) return yield* fail(reply.reason)
      yield* explain(observation, reply.reason)
      const row = state.leases[address.id]
      if (!row) return yield* fail("unknown-id")
      if (!granting(row)) return yield* fail("stale")
      if (row.state === "granted") return { row, observation }
      yield* sleepWhileQueued(address.id)
    }
  })

  const supervised = Effect.fn("HostAdmission.supervised")(function* (
    row: Lease, pin: Scope.ProcessPin, fd: number, stopGroup: Effect.Effect<void, AdmissionUnavailable>,
    argv: ReadonlyArray<string>, environment?: Readonly<Record<string, string>>,
  ) {
    const fence = { id: row.id, generation: row.generation, binding: pin.ref }
    const interrupted = yield* Deferred.make<void>()
    const control = yield* foregroundScope(host, foreground, (paused) => cold().pipe(
      Effect.flatMap((at) => ledger.transact({ op: "job-control", ...fence, paused }, at)), Effect.asVoid,
    ), config.onInterrupt ?? (() => {}), interrupted, config.beforeResume)
    const payload = yield* Option.match(pin.cgroup, {
      onSome: () => Effect.succeed(Scope.payloadArgv(host, argv)),
      onNone: () => Scope.groupPayloadArgv(host, argv),
    })
    const work = yield* Scope.spawnOwned(payload, config.cwd, environment, fd)
    let stopping = false
    const stop = Effect.suspend(() => {
      if (stopping) return Effect.void
      stopping = true
      if (Option.isNone(pin.cgroup)) return stopGroup.pipe(Effect.ignore)
      return Scope.stopOwnedCgroup(host, pin).pipe(Effect.catchTag("AdmissionUnavailable", () => work.stop))
    })
    const escalate = Effect.gen(function* () {
      yield* Deferred.await(interrupted)
      yield* Effect.sleep(INTERRUPT_GRACE_MS)
      yield* stop
      return yield* Effect.never
    })
    const keep = Effect.gen(function* () {
      const now = yield* Supply.clockOf(host)
      const tick = yield* ledger.transact({ op: "renew", ...fence }, cut(now))
      if (tick.reply.state !== "running") yield* stop
    }).pipe(Effect.repeat(loop))
    const code = yield* Effect.raceAllFirst([
      work.exited, escalate, keep.pipe(Effect.andThen(Effect.never)), control,
    ]).pipe(Effect.onError(() => stop))
    if (Deferred.isDoneUnsafe(interrupted) && !stopping) return 130
    return code
  })

  const claim = Effect.fn("HostAdmission.claim")(function* (
    row: Lease, args: ReadonlyArray<string>, placement: Scope.Placement, environment?: Readonly<Record<string, string>>,
  ) {
    if (Option.isNone(row.admittedDemand) || args.length === 0) return yield* fail("invalid-request")
    const demand = row.admittedDemand.value
    // Which volume the attempt runs on, not how full it is: free space was
    // the ledger's decision at admission. Re-sampling here made a launch
    // depend on a read that status and admission never needed (btrfs
    // metadata on the workbox).
    const volume = yield* Supply.volumeIdentity(config.cwd)
    if (!demand.volumeReservations.some(({ volumeId }) => volumeId === volume.id)) return yield* fail("unknown-volume")
    return yield* Effect.scoped(Effect.gen(function* () {
      const location = yield* Scope.pinOf(host, row.id, row.generation, demand.cpuMilli, demand.memoryBytes, foreground, placement)
      const watcher = yield* Scope.watchGroup(host, location)
      const attempt = yield* Effect.scoped(Effect.gen(function* () {
        const { fd, descriptor } = yield* Scope.armDescriptor(host, path.join(config.directory, `${location.ref}.lock`))
        const pin = { ...location, descriptor }
        const { reply } = yield* bind(row, pin, yield* supplyForStep())
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
    return yield* attachGrant(offer, Option.fromNullishOr(leases[offer.id]), (row) => claim(row, offer.argv, "cgroup", offer.environment).pipe(
      Effect.map((code) => Option.getOrElse(code, () => 125)),
    ))
  })

  const linux = Effect.fn("HostAdmission.linux")(function* (row: Lease, argv: ReadonlyArray<string>) {
    if (Option.isNone(row.admittedDemand) || row.admittedDemand.value.memoryBytes === 0)
      return yield* refuse("unqualified", `lease ${row.id} has no memory reservation, and a cgroup launch caps memory by it`)
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
      if (final.generation === row.generation)
        return yield* refuse("unqualified", `systemd-run --user (unit for lease ${row.id}) exited ${code} before its helper bound the lease`)
    }
    return Option.some(code)
  })

  const begin = Effect.fn("HostAdmission.run")(function* (
    address: Address, args: ReadonlyArray<string>, explain: ReturnType<typeof describeWait>,
  ) {
    for (;;) {
      const { row, observation } = yield* wait(address, explain)
      // An unattested host has no workload slice to offer a unit in: the
      // attempt stays in this process's own group, under the guard's
      // heavy launcher, as on the Mac.
      const placement = Scope.placementOf(host, !unattested(envelopeOf(observation)))
      const launch = { cgroup: () => Effect.scoped(linux(row, args)), group: () => claim(row, args, "group") }
      const code = yield* launch[placement]()
      if (Option.isSome(code)) return code.value
      yield* waitForChange(500)
    }
  })

  // Re-entrancy (host-admit-queue, case 6): a check run from inside a lease's
  // own process tree (a guard-wrapped line that calls host-admit itself)
  // would wait behind the lease that is its own ancestor, forever. It is
  // that lease: it runs under it, with no second request.
  const enclosingLease = Effect.fn("HostAdmission.enclosingLease")(function* (pid: number) {
    const ancestors = yield* Scope.ancestorsOf(host, pid)
    const { leases } = yield* ledger.inspect()
    const owners = yield* Effect.forEach(Object.values(leases).filter((row) => !terminal(row.state)), (row) =>
      native.peer(row.owner).pipe(Effect.map((peer) => ({ row, pid: Option.map(Option.fromNullishOr(peer), (found) => found.pid) }))))
    return enclosing(ancestors, owners)
  })
  const inside = Effect.fn("HostAdmission.inside")(function* (row: Lease, args: ReadonlyArray<string>) {
    if (!active(row)) return yield* refuse("invalid-request",
      `this check runs inside lease :${row.ticket}, which is ${row.state}: a request from its own process tree would wait on itself`)
    yield* Console.error(`host-admit: runs inside lease :${row.ticket} (width ${widthText(row)}), which its own process tree holds: no second request`)
    const work = yield* Scope.spawnOwned(args, config.cwd)
    return yield* work.exited.pipe(Effect.onInterrupt(() => work.stop))
  })

  const run = Effect.fn("HostAdmission.runCheck")(function* (
    demand: CheckDemand, args: ReadonlyArray<string>, advice: string, imposed: boolean,
  ) {
    const now = yield* Supply.clockOf(host)
    if (Option.isNone(target)) return yield* fail("unknown-volume")
    const pid = host.kernel.core.symbols.getpid()
    const within = yield* enclosingLease(pid)
    if (Option.isSome(within)) return yield* inside(within.value, args)
    const self = yield* Scope.processIdentity(host, pid)
    if (Option.isNone(self)) return yield* new AdmissionUnavailable({ reason: "unavailable", detail: `cannot read this process's identity (pid ${pid})` })
    const owner = Supply.ref("waiter", `${host.bootId}:${self.value.pid}:${self.value.start}`)
    yield* native.remember(owner, self.value.pid, self.value.start)
    let reservation = demandOnVolume(demand, target.value.id)
    if (imposed && host.platform === "linux") reservation = enforceDeclaredWidth(reservation)
    const draft: Request = {
      version: 1, requestId: Supply.ref("request", `${owner}:${now}`), principal: caller.principal,
      purpose: demand.purpose, tier: "standard", deadlineBootMs: now + POLICY.queueMs,
      demand: reservation,
    }
    const { reply: queued, observation } = yield* request(draft, owner)
    if (Predicate.isNull(queued.id)) return yield* fail(queued.reason)
    const explain = describeWait(demand.width, advice)
    yield* explain(observation, queued.reason)
    const address = { id: queued.id, owner }
    return yield* begin(address, args, explain).pipe(Effect.onError(() => cold().pipe(
      Effect.flatMap((now) => ledger.transact({ op: "cancel", ...address }, now)), Effect.ignore,
    )))
  })

  // A declared width is a scope cap only where the Linux controller
  // attests; an unattested host models the tool's width as the Mac does.
  const enforcedWidth = Effect.suspend(() => {
    if (host.platform !== "linux") return Effect.succeed(false)
    return cold().pipe(Effect.flatMap(attest), Effect.map((observation) => !unattested(envelopeOf(observation))))
  })

  // What the host's readings say of the executing volume, by the rule
  // admission decides by, whichever process read it; with no reading, the
  // read that failed. Every caller prints the same answer.
  const diskOf = Effect.fn("HostAdmission.diskOf")(function* (view: View): Effect.fn.Return<Readonly<Record<string, string | number>>, never, FileSystem.FileSystem> {
    if (Option.isNone(target)) return { disk: "unknown-volume" }
    const reading = volumeStatus(view, target.value.id)
    const unread = { admit: "the capped path admits under its cap", wait: "leases on it wait" }[reading.unread]
    switch (reading.kind) {
      // The disk rule's own words: a full volume makes every lease wait `disk`.
      case "full": return { disk: "full", diskWhy: `${reading.why}; leases on it wait (disk)`, diskReadAgoMs: reading.ageMs }
      case "room": return { disk: "measured", diskReadAgoMs: reading.ageMs }
      case "expired": return { disk: "unmeasured", diskReadAgoMs: reading.ageMs,
        diskWhy: `the host's last reading of it is ${reading.ageMs} ms old, past its ${reading.boundMs} ms bound; ${unread}` }
      case "none": break
    }
    if (!view.sample) return { disk: "unsampled" }
    const why = yield* Supply.volumeOf(host, config.cwd).pipe(
      Effect.as("no sample this boot has read it; a second read could"),
      Effect.catchTag("AdmissionUnavailable", ({ detail }) => Effect.succeed(detail ?? "unreadable")))
    return { disk: "unmeasured", diskWhy: why }
  })

  const hostStatus = Effect.fn("HostAdmission.hostStatus")(function* () {
    // Status records its own sample, if it won the slot, then answers from
    // the host's readings: a caller that lost the slot says what the
    // sampler would. `advance` also serves the queue on those readings.
    const own = yield* measure().pipe(Effect.flatMap(attest))
    const { state } = yield* ledger.transact({ op: "advance" }, own)
    // The clock after the transaction, as in `step`: a reading is never newer than `now`.
    const observation = sharedView(state, { ...own, now: yield* Supply.clockOf(host) })
    const { sample, now } = observation
    const offer = hostOffer(observation, Option.map(target, ({ id }) => id))
    // What a group-placed launch adds to nice for this caller, probed as
    // the launch probes it: a caller with no user manager on its bus runs
    // niced without a scope, and status says so.
    let launcher = Option.none<Effect.Success<ReturnType<typeof Scope.groupLauncher>>>()
    if (host.platform === "linux" && unattested(envelopeOf(observation))) launcher = Option.some(yield* Scope.groupLauncher())
    return {
      version: 1, hostId: host.hostId, bootId: host.bootId, nowBootMs: now, revision: state.revision, principal: caller.principal,
      defaultVolume: Option.getOrNull(offer.defaultVolume),
      capabilities: { pressure: sample?.pressure ?? "unknown", ...controllerOf(observation, launcher), ...(yield* diskOf(observation)), platform: host.platform },
      coresMilli: Option.getOrNull(Option.fromNullishOr(sample?.effectiveCpuMilli)),
      // How old the host's newest sample is, whoever took it.
      sampleAgoMs: Option.getOrNull(Option.map(Option.fromNullishOr(sample), ({ at }) => now - at)),
      runnable: Option.getOrNull(Option.fromNullishOr(sample?.runnable)),
      maximumCpuMilli: offer.maximumCpuMilli,
      freeManagedCpuMilli: Option.getOrNull(Option.map(Option.fromNullishOr(sample), capacityOf)),
      outsideNoncriticalMilli: Option.getOrNull(Option.fromNullishOr(sample?.outsideNoncriticalMilli)),
      maximumMemoryBytes: offer.maximumMemoryBytes,
      maximumDiskBytes: offer.maximumDiskBytes,
      offeredClasses: offer.offeredClasses,
      withheldClasses: offer.withheld,
      resourceKeys: offer.resourceKeys,
    }
  })

  return {
    enforcedWidth,
    hostStatus, request: (draft: Request) => request(draft).pipe(Effect.map(({ reply, observation }) => ({
      ...reply, supply: Option.getOrNull(supplyReport(observation)),
    }))), status, watch, run, attach,
    put: Effect.fn("HostAdmission.observe")(function* (records: Parameters<typeof holder.putObservations>[1]) {
      return yield* holder.putObservations(caller.owner, records, yield* Supply.clockOf(host))
    }),
    list: holder.list,
    launch: Effect.fn("HostAdmission.launchExternal")(function* (id: string, args: ReadonlyArray<string>) {
      const address = { id, owner: caller.owner }
      const { state, observation, reply } = yield* step({ op: "status", ...address })
      const row = state.leases[id]
      // Do not expose demand for another principal's durable address.
      if (!row || row.owner !== address.owner || terminal(reply.state)) return yield* fail(reply.reason)
      const { demand } = row.request
      let advice = "On Linux the applied scope CPU controller enforces the reservation."
      if (!(yield* enforcedWidth)) {
        const model = argvModel(args, Scope.localEnvironment())
        const mismatch = widthMismatch(demand, args, model)
        if (Option.isSome(mismatch)) return yield* mismatch.value
        advice = model.advice
      }
      const explain = describeWait(demand.width, advice)
      yield* explain(observation, reply.reason)
      return yield* begin(address, args, explain)
    }),
    cancel: (id: string) => cold().pipe(Effect.flatMap((at) => ledger.transact({ op: "cancel", id, owner: caller.owner }, at)), Effect.map((next) => next.reply)),
    now: Clock.currentTimeMillis,
  }
})
