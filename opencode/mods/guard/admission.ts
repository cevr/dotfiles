import { Context, Effect, Option, Predicate, Result, Schema } from "effect"
import { Counter, Demand, normalizeRequest, OpaqueId, Phase, qualifiedForm, Reason, reply, Request, type Reply } from "./admission-wire.ts"
import { capacityOf, freeHostCpu, type HostEnvelope, POLICY, runnableLimit, type Supply, unattested, usableVolume } from "./host-supply.ts"

export const Lease = Schema.Struct({
  id: OpaqueId,
  ticket: Counter,
  generation: Counter,
  owner: OpaqueId,
  request: Request,
  state: Phase,
  reason: Reason,
  sequence: Counter,
  changedAt: Counter,
  binding: Schema.OptionFromNullOr(OpaqueId),
  evidence: Schema.OptionFromNullOr(OpaqueId),
  sampleId: Schema.OptionFromNullOr(OpaqueId),
  admittedDemand: Schema.OptionFromNullOr(Demand),
  expiresBootMs: Schema.OptionFromNullOr(Counter),
  hardDeadline: Schema.OptionFromNullOr(Counter),
})
export type Lease = typeof Lease.Type
export const Admission = Schema.Struct({
  version: Schema.Literal(1),
  hostId: OpaqueId,
  bootId: OpaqueId,
  revision: Counter,
  bootStartRevision: Counter,
  landBurst: Counter,
  leases: Schema.Record(OpaqueId, Lease),
})
export type Admission = typeof Admission.Type

export interface Address {
  readonly id: string
  readonly owner: string
}
interface Attempt {
  readonly id: string
  readonly generation: number
  readonly binding: string
}
export type Input =
  | { readonly op: "request"; readonly request: Request; readonly owner: string }
  | ({ readonly op: "status" | "cancel" } & Address)
  | ({ readonly op: "claim" } & Address & Attempt)
  | ({ readonly op: "renew" } & Attempt)
  | ({ readonly op: "job-control"; readonly paused: boolean } & Attempt)
  | ({ readonly op: "drain"; readonly evidence: string } & Attempt)
  | { readonly op: "observe"; readonly id: string; readonly owner: string; readonly generation: number; readonly liveness: "gone" | "unknown"; readonly evidence: string }
  | { readonly op: "advance" }

export interface Observation {
  readonly now: number
  readonly sample?: Supply
  readonly envelope?: HostEnvelope
}
interface Outcome {
  readonly state: Admission
  readonly reply: Reply
  readonly changes: ReadonlyArray<Lease>
}

export class AdmissionUnavailable extends Schema.TaggedError<AdmissionUnavailable>()("AdmissionUnavailable", {
  reason: Reason,
  storeVersion: Schema.optionalKey(Schema.Struct({ found: Counter, supported: Counter })),
}) {}

/** Persistence serializes each operation, including use of the sampled clock,
 * against all processes sharing the physical host; callers cannot write rows. */
export class LeaseLedger extends Context.Service<LeaseLedger, {
  readonly transact: (input: Input, observation: Observation) => Effect.Effect<Outcome, AdmissionUnavailable>
  readonly replay: (address: Address, after: number) => Effect.Effect<ReadonlyArray<Reply>, AdmissionUnavailable>
  readonly inspect: () => Effect.Effect<Admission, AdmissionUnavailable>
}>()("dotfiles-opencode/guard/LeaseLedger") {}

/** Only a trusted lifecycle feed, not a tool/CLI input. Native shell claims
 * stay process-owned until the fork supplies this authenticated identity. */
export interface ShellIdentity {
  readonly id: string
  readonly attempt: number
  readonly owner: string
  readonly ownerEpoch: number
}

export type ShellFact =
  | { readonly kind: "authorized"; readonly shell: ShellIdentity; readonly request: Request }
  | { readonly kind: "bound"; readonly shell: ShellIdentity; readonly binding: string }
  | { readonly kind: "terminal-owner"; readonly shell: ShellIdentity; readonly evidence: string }
  | { readonly kind: "ended"; readonly shell: ShellIdentity; readonly binding: string; readonly scope: "gone" | "live" | "unknown"; readonly evidence: string }
  | { readonly kind: "live" | "handoff" | "unknown"; readonly shell: ShellIdentity }

export const shellFact = (state: Admission, fact: ShellFact): Option.Option<Input> => {
  const { shell } = fact
  const owner = `${shell.owner}:${shell.ownerEpoch}:${shell.attempt}`
  if (fact.kind === "authorized") return Option.some({
    op: "request", owner,
    request: { ...fact.request, requestId: shell.id, principal: { kind: "native-shell", scopeId: shell.owner, epoch: shell.ownerEpoch } },
  })
  const row = Object.values(state.leases).find((row) =>
    row.owner === owner && row.request.requestId === shell.id &&
    row.request.principal.kind === "native-shell" && row.request.principal.epoch === shell.ownerEpoch)
  if (!row) return Option.none()
  if (fact.kind === "bound") return Option.some({ op: "claim", id: row.id, owner, generation: row.generation, binding: fact.binding })
  if (fact.kind === "terminal-owner") return Option.some({
    op: "observe", id: row.id, owner, generation: row.generation, liveness: "gone", evidence: fact.evidence,
  })
  if (fact.kind === "ended" && fact.scope === "gone") return Option.some({
    op: "drain", id: row.id, generation: row.generation, binding: fact.binding, evidence: fact.evidence,
  })
  return Option.none()
}

export const initial = (hostId: string, bootId: string, revision = 0): Admission =>
  ({ version: 1, hostId, bootId, revision, bootStartRevision: revision, landBurst: 0, leases: {} })

const held = (lease: Lease) => lease.state === "granted" || lease.state === "running" || lease.state === "draining"
const exclusive = (lease: Lease) => lease.request.purpose === "exclusive-check"
const liveAttempt = (lease: Lease) => lease.state === "running" || lease.state === "draining"
const overlap = (a: Lease, b: Lease) => a.request.demand.keys.some((key) => b.request.demand.keys.includes(key))
const sharesVolume = (a: Lease, b: Lease) =>
  a.request.demand.volumeReservations.some((volume) => b.request.demand.volumeReservations.some((v) => v.volumeId === volume.volumeId))

const refusalDetails = (state: Phase, reason: Reason) => {
  if (state === "refused") return { qualifiedForm: qualifiedForm(reason) }
  return {}
}

export const receipt = (state: Pick<Admission, "hostId" | "bootId">, row: Lease): Reply => reply({
  version: 1,
  hostId: state.hostId,
  bootId: state.bootId,
  id: Option.some(row.id),
  sequence: row.sequence,
  state: row.state,
  reason: row.reason,
  sampleId: row.sampleId,
  admittedDemand: row.admittedDemand,
  expiresBootMs: row.expiresBootMs,
  ...refusalDetails(row.state, row.reason),
})

const refusal = (state: Admission, reason: Reason): Reply => reply({
  version: 1, hostId: state.hostId, bootId: state.bootId, id: Option.none(), sequence: state.revision,
  state: "refused", reason, sampleId: Option.none(), admittedDemand: Option.none(), expiresBootMs: Option.none(),
  qualifiedForm: qualifiedForm(reason),
})

const fresh = ({ now, sample }: Observation): Result.Result<Supply, Reason> => {
  if (!sample) return Result.fail("unavailable")
  if (sample.at > now || now - sample.at > POLICY.freshnessMs) return Result.fail("stale-sample")
  if (sample.qualification === "unqualified") return Result.fail("unqualified")
  if (sample.runnable >= runnableLimit(sample) || sample.pressure === "hold") return Result.fail("pressure")
  return Result.succeed(sample)
}

const terminal = (state: "released" | "expired" | "cancelled" | "refused", reason: Reason): Partial<Lease> => ({
  state, reason, admittedDemand: Option.none(), expiresBootMs: Option.none(), hardDeadline: Option.none(),
})

const liveCharge = (row: Lease, sample: Supply) =>
  Math.max(Option.match(row.admittedDemand, { onSome: ({ cpuMilli }) => cpuMilli, onNone: () => 0 }),
    sample.managed.find((use) => Option.exists(row.binding, (binding) => use.binding === binding))?.measuredCpuMilli ?? 0)

type Ceiling = { readonly limit: number; readonly used: number; readonly added: number; readonly reason: Reason }
const ceiling = (limit: number, added: number, reason: Reason, used = 0): Ceiling => ({ limit, added, reason, used })
const fits = (ceilings: ReadonlyArray<Ceiling>): Option.Option<Reason> =>
  Option.map(Option.fromNullishOr(ceilings.find(({ limit, used, added }) => used + added > limit)), ({ reason }) => reason)

const reserved = (holds: ReadonlyArray<Lease>, quantify: (demand: Demand) => number) =>
  holds.reduce((sum, lease) => sum + Option.getOrElse(Option.map(lease.admittedDemand, quantify), () => 0), 0)
const bytesOn = (demand: Demand, volumeId: string) =>
  demand.volumeReservations.find((item) => item.volumeId === volumeId)?.bytes ?? 0
const staticCeilings = (demand: Demand, limit: HostEnvelope, holds: ReadonlyArray<Lease>, memoryReason: Reason) => {
  const memory = reserved(holds, (d) => d.memoryBytes)
  const controller = limit.containedMemoryBytes ?? limit.memoryBytes
  return [
    ceiling(demand.memoryBytes, Number(limit.needsMemoryReservation), "memory-limit"),
    ceiling(POLICY.maxRequestMemoryBytes, demand.memoryBytes, "memory-limit"),
    ceiling(limit.memoryBytes, demand.memoryBytes, memoryReason, memory),
    ceiling(controller, demand.memoryBytes, memoryReason, memory),
    ceiling(limit.cpuMilli, demand.cpuMilli, "capacity", reserved(holds, (d) => d.cpuMilli)),
    ...demand.volumeReservations.map(({ volumeId, bytes }) =>
      ceiling(limit.volumes[volumeId] ?? -1, bytes, "disk-limit", reserved(holds, (d) => bytesOn(d, volumeId)))),
    ...demand.keys.map((key) => ceiling(1, 1, "resource", reserved(holds, (d) => Number(d.keys.includes(key))))),
  ]
}

const volumeCeiling = (demand: Demand, sample: Supply, holds: ReadonlyArray<Lease>, volumeId: string) => {
  const volume = sample.volumes[volumeId]
  if (!volume || !usableVolume(volume)) return ceiling(-1, 0, "disk")
  return ceiling(volume.freeBytes - Math.max(volume.diskFloorBytes, POLICY.diskFloorBytes),
    bytesOn(demand, volumeId), "disk", reserved(holds, (d) => bytesOn(d, volumeId)))
}
const slots = { clear: POLICY.slots, degraded: 1, hold: 0 }
const wholePoolFloor = (sample: Supply) => Math.ceil(sample.envelope.cpuMilli * POLICY.wholePoolFreeFraction)
const wholeCpuCeilings = (sample: Supply, hasHold: boolean) =>
  [ceiling(0, Number(hasHold), "whole-pool-held"), ceiling(capacityOf(sample), wholePoolFloor(sample), "outside-busy")]
const cpuCeilings = (demand: Demand, holds: ReadonlyArray<Lease>, sample: Supply) => {
  if (demand.cpuMilli === sample.envelope.cpuMilli) return wholeCpuCeilings(sample, holds.length > 0)
  const cpu = holds.reduce((sum, row) => sum + liveCharge(row, sample), 0)
  return [ceiling(freeHostCpu(sample), demand.cpuMilli, "capacity", cpu)]
}
const liveCeilings = (entry: Lease, demand: Demand, holds: ReadonlyArray<Lease>, sample: Supply) => {
  const exclusiveHold = holds.some((row) => exclusive(row) || exclusive(entry))
  const wholeHold = holds.some((row) => Option.exists(row.admittedDemand, (held) => held.width === "full"))
  return [
    ...cpuCeilings(demand, holds, sample),
    ceiling(0, Number(exclusiveHold || wholeHold), "capacity"),
    ...demand.volumeReservations.map(({ volumeId }) => volumeCeiling(demand, sample, holds, volumeId)),
    ceiling(slots[sample.pressure], 1, "capacity", holds.length),
    ceiling(sample.memoryBytes - POLICY.reserveMemoryBytes, demand.memoryBytes, "memory", reserved(holds, (d) => d.memoryBytes)),
  ]
}
const budgetReason = (entry: Lease, demand: Demand, holds: ReadonlyArray<Lease>, sample: Supply) =>
  fits([...liveCeilings(entry, demand, holds, sample), ...staticCeilings(demand, sample.envelope, holds, "memory")])

export const cpuDemand = (demand: Demand, maximum: number) => {
  if (!Predicate.isNumber(demand.width)) return maximum
  return Math.min(maximum, Math.max(demand.cpuMilli, demand.width * 1000))
}

const demandWithin = (entry: Lease, envelope: HostEnvelope): Demand => {
  const { demand } = entry.request
  const cpuMilli = cpuDemand(demand, envelope.cpuMilli)
  // Once a whole-pool claim starts it stays exclusive until drain, even
  // if the pool later expands. Keep the literal model in request.demand.
  if (cpuMilli === envelope.cpuMilli) return { ...demand, width: "full" as const, cpuMilli }
  return { ...demand, cpuMilli }
}
const checkedDemand = (entry: Lease, sample: Supply): Demand => demandWithin(entry, sample.envelope)

/** An unattested host (no workload controller to measure against) admits
 * by a fixed rule instead: at most `POLICY.unattestedSlots` held leases,
 * exclusive and whole-pool checks alone, each resource key once, and the
 * envelope's CPU and memory as reservations. No sample is needed. */
const fixedCeilings = (entry: Lease, demand: Demand, holds: ReadonlyArray<Lease>, limit: HostEnvelope) => {
  const alone = holds.length > 0 && (exclusive(entry) || demand.width === "full" ||
    holds.some((row) => exclusive(row) || Option.exists(row.admittedDemand, (held) => held.width === "full")))
  return [
    ceiling(POLICY.unattestedSlots, 1, "capacity", holds.length),
    ceiling(0, Number(alone), "capacity"),
    ...staticCeilings(demand, limit, holds, "memory"),
  ]
}
const envelopeOf = (observation: Observation) => observation.envelope ?? observation.sample?.envelope
const fixedLimit = (observation: Observation) => Option.filter(Option.fromNullishOr(envelopeOf(observation)), unattested)

const feasibility = (request: Request, limit: HostEnvelope): Option.Option<Reason> => {
  const { demand } = request
  if (!limit.purposes.includes(request.purpose) || limit.cpuMilli <= 0) return Option.some("unsupported-class")
  if (demand.keys.some((key) => !limit.keys.includes(key))) return Option.some("unknown-key")
  if (demand.volumeReservations.some(({ volumeId }) => !Object.hasOwn(limit.volumes, volumeId))) return Option.some("unknown-volume")
  return fits(staticCeilings({ ...demand, cpuMilli: cpuDemand(demand, limit.cpuMilli) }, limit, [], "memory-limit"))
}

const requestText = Schema.encodeSync(Schema.fromJsonString(Request))
const sameRequest = (a: Request, b: Request) => requestText(a) === requestText(b)

const validRequest = (request: Request, now: number) => {
  const { demand } = request
  const maxCpu = { small: 1000, standard: POLICY.maxRequestCpuMilli }
  return request.deadlineBootMs > now && request.deadlineBootMs - now <= POLICY.queueMs &&
    demand.cpuMilli > 0 && demand.cpuMilli <= maxCpu[request.tier] &&
    demand.keys.length <= 16 &&
    demand.volumeReservations.length > 0 && demand.volumeReservations.length <= 16 &&
    new Set(demand.volumeReservations.map((v) => v.volumeId)).size === demand.volumeReservations.length
}

interface Transaction {
  readonly rows: () => ReadonlyArray<Lease>
  readonly nextTicket: () => number
  readonly get: (id: string) => Option.Option<Lease>
  readonly update: (row: Lease, patch: Partial<Lease>) => Lease
}

const expire = (tx: Transaction, now: number) => {
  for (const row of tx.rows()) {
    if (row.state === "queued" && now >= row.request.deadlineBootMs) tx.update(row, terminal("expired", "deadline"))
    if (!Option.exists(row.expiresBootMs, (expires) => now >= expires)) continue
    if (row.state === "granted") tx.update(row, terminal("expired", "expired-grant"))
    if (row.state === "running") tx.update(row, { state: "draining", reason: "scope-live", expiresBootMs: Option.none() })
  }
}

const requalify = (tx: Transaction, observation: Observation) => {
  const limit = observation.envelope ?? observation.sample?.envelope
  if (!limit) return
  for (const row of tx.rows()) {
    if (row.state !== "granted" && row.state !== "queued") continue
    const problem = feasibility(row.request, limit)
    if (Option.isSome(problem)) tx.update(row, terminal("refused", problem.value))
  }
}

const wholePool = (row: Lease, sample: Supply) => cpuDemand(row.request.demand, sample.envelope.cpuMilli) === sample.envelope.cpuMilli
const sharesFrontier = (older: Lease, newer: Lease, sample: Supply) =>
  wholePool(older, sample) || wholePool(newer, sample) ||
  exclusive(older) || exclusive(newer) || overlap(older, newer) || sharesVolume(older, newer) ||
  older.reason === "capacity" || older.reason === "memory" || older.reason === "fifo"

const requestedBeforeExclusive = (queue: ReadonlyArray<Lease>) => {
  const exclusiveAt = queue.findIndex(exclusive)
  if (exclusiveAt < 0) return queue
  return queue.slice(0, exclusiveAt)
}

const preferredLand = (queue: ReadonlyArray<Lease>, headroom: number, holds: ReadonlyArray<Lease>, sample: Supply) =>
  requestedBeforeExclusive(queue).filter((row, i, prefix) =>
    row.request.purpose === "land-check" &&
    prefix.slice(0, i).some((earlier) => earlier.request.purpose !== "land-check") &&
    !wholePool(row, sample) &&
    !prefix.slice(0, i).some((earlier) => wholePool(earlier, sample) || overlap(earlier, row)) &&
    Option.isNone(budgetReason(row, checkedDemand(row, sample), holds, sample)),
  ).slice(0, headroom)

const queuedFor = (tx: Transaction, row: Lease, reason: Reason, sampleId: Lease["sampleId"]) => {
  if (row.reason === reason) return row
  return tx.update(row, { reason, sampleId })
}

const atFrontier = (row: Lease, older: ReadonlyArray<Lease>, holds: ReadonlyArray<Lease>, sample: Supply) => {
  if (older.some((entry) => sharesFrontier(entry, row, sample))) return Option.some<Reason>("fifo")
  return budgetReason(row, checkedDemand(row, sample), holds, sample)
}

const grant = (tx: Transaction, row: Lease, demand: Demand, sampleId: Lease["sampleId"], now: number) => tx.update(row, {
  state: "granted", generation: row.generation + 1, reason: "granted", sampleId,
  admittedDemand: Option.some(demand),
  expiresBootMs: Option.some(Math.min(row.request.deadlineBootMs, now + POLICY.launchMs)),
})

/** Strict FIFO under the fixed cap: once one queued lease waits, every
 * later one waits behind it, so none starves. */
const allocateFixed = (tx: Transaction, now: number, limit: HostEnvelope) => {
  let waiting = false
  for (const row of tx.rows().filter((entry) => entry.state === "queued")) {
    if (waiting) {
      queuedFor(tx, row, "fifo", Option.none())
      continue
    }
    const demand = demandWithin(row, limit)
    const reason = fits(fixedCeilings(row, demand, tx.rows().filter(held), limit))
    if (Option.isSome(reason)) {
      waiting = true
      queuedFor(tx, row, reason.value, Option.none())
    } else grant(tx, row, demand, Option.none(), now)
  }
  return 0
}

const allocate = (tx: Transaction, observation: Observation, landBurst: number) => {
  const { sample, now } = observation
  const fixed = fixedLimit(observation)
  if (Option.isSome(fixed)) return allocateFixed(tx, now, fixed.value)
  const available = fresh(observation)
  const queue = tx.rows().filter((row) => row.state === "queued")
  if (Result.isFailure(available)) {
    const sampleId = Option.fromNullishOr(sample?.id)
    const hasHold = tx.rows().some(held)
    for (const row of queue) {
      if (available.failure === "pressure" && sample && wholePool(row, sample)) {
        queuedFor(tx, row, Option.getOrElse(fits(wholeCpuCeilings(sample, hasHold)), () => "pressure" as const), sampleId)
      } else queuedFor(tx, row, available.failure, sampleId)
    }
    return landBurst
  }
  const supply = available.success
  const waiting: Lease[] = []
  const prioritized = preferredLand(queue, Math.max(0, POLICY.landBurst - landBurst), tx.rows().filter(held), supply)
  let burst = landBurst
  for (const row of [...prioritized, ...queue.filter((row) => !prioritized.includes(row))]) {
    const reason = atFrontier(row, waiting, tx.rows().filter(held), supply)
    if (Option.isSome(reason)) {
      waiting.push(queuedFor(tx, row, reason.value, Option.some(supply.id)))
      continue
    }
    if (prioritized.includes(row)) burst += 1
    else if (row.request.purpose !== "land-check") burst = 0
    grant(tx, row, checkedDemand(row, supply), Option.some(supply.id), now)
  }
  return burst
}

const sameGrant = (row: Lease, demand: Demand) =>
  Option.exists(row.admittedDemand, (granted) => granted.cpuMilli === demand.cpuMilli && granted.width === demand.width)
const approveFixed = (tx: Transaction, row: Lease, limit: HostEnvelope): Result.Result<{ demand: Demand; sampleId: Lease["sampleId"] }, Reason> => {
  const demand = demandWithin(row, limit)
  if (!sameGrant(row, demand)) return Result.fail("capacity")
  const reason = fits(fixedCeilings(row, demand, tx.rows().filter((r) => r.id !== row.id && held(r)), limit))
  if (Option.isSome(reason)) return Result.fail(reason.value)
  return Result.succeed({ demand, sampleId: Option.none() })
}
const approveClaim = (tx: Transaction, row: Lease, observation: Observation) => {
  const fixed = fixedLimit(observation)
  if (Option.isSome(fixed)) return approveFixed(tx, row, fixed.value)
  return Result.flatMap(fresh(observation), (sample) => {
    const demand = checkedDemand(row, sample)
    if (!sameGrant(row, demand)) return Result.fail("capacity" as const)
    const other = tx.rows().filter((r) => r.id !== row.id && held(r))
    const reason = budgetReason(row, demand, other, sample)
    if (Option.isSome(reason)) return Result.fail(reason.value)
    return Result.succeed({ demand, sampleId: Option.some(sample.id) })
  })
}

const claim = (tx: Transaction, row: Lease, input: Extract<Input, { op: "claim" }>, observation: Observation): Option.Option<Reason> => {
  if (row.generation !== input.generation || row.state !== "granted") return Option.some("stale")
  // A binding names a single native incarnation for this boot, even after
  // release. Its appearance on a second offer cannot authorize a second exec.
  if (tx.rows().some(({ binding }) => Option.contains(binding, input.binding))) return Option.some("stale")
  const decision = approveClaim(tx, row, observation)
  if (Result.isFailure(decision)) {
    tx.update(row, { state: "queued", reason: decision.failure, admittedDemand: Option.none(),
      expiresBootMs: Option.none(), sampleId: Option.fromNullishOr(observation.sample?.id) })
  } else {
    const { demand, sampleId } = decision.success
    tx.update(row, {
      state: "running", reason: "running", binding: Option.some(input.binding), admittedDemand: Option.some(demand), sampleId,
      expiresBootMs: Option.some(observation.now + POLICY.supervisionMs), hardDeadline: Option.some(observation.now + POLICY.maxRunningMs),
    })
  }
  return Option.none()
}

const matches = (row: Lease, input: Attempt) =>
  row.generation === input.generation && Option.exists(row.binding, (binding) => binding === input.binding) && liveAttempt(row)

const cancel = (tx: Transaction, row: Lease) => {
  if (row.state === "running") tx.update(row, { state: "draining", reason: "cancelled", expiresBootMs: Option.none() })
  else if (row.state === "queued" || row.state === "granted") tx.update(row, terminal("cancelled", "cancelled"))
}

const observe = (tx: Transaction, row: Lease, input: Extract<Input, { op: "observe" }>): Option.Option<Reason> => {
  if (row.generation !== input.generation) return Option.some("stale")
  if (input.liveness === "unknown") return Option.none()
  if (row.state === "draining" && row.reason === "owner-gone" && Option.exists(row.evidence, (evidence) => evidence === input.evidence))
    return Option.none()
  const evidence = Option.some(input.evidence)
  if (liveAttempt(row)) tx.update(row, { state: "draining", reason: "owner-gone", evidence, expiresBootMs: Option.none() })
  else if (row.state === "queued" || row.state === "granted") tx.update(row, { ...terminal("cancelled", "owner-gone"), evidence })
  return Option.none()
}

const renew = (tx: Transaction, row: Lease, now: number) => {
  const { hardDeadline, expiresBootMs } = row
  if (row.state !== "running" || Option.isNone(hardDeadline) || Option.isNone(expiresBootMs)) return
  if (expiresBootMs.value - now >= POLICY.supervisionMs / 2 || now >= hardDeadline.value) return
  tx.update(row, { expiresBootMs: Option.some(Math.min(now + POLICY.supervisionMs, hardDeadline.value)) })
}

const act = (tx: Transaction, row: Lease, input: Exclude<Input, { op: "request" | "advance" }>, observation: Observation): Option.Option<Reason> => {
  if ("owner" in input && row.owner !== input.owner) return Option.some("wrong-owner")
  switch (input.op) {
    case "claim": return claim(tx, row, input, observation)
    case "observe": return observe(tx, row, input)
    case "status": return Option.none()
    case "cancel":
      cancel(tx, row)
      return Option.none()
    case "drain":
      if (!matches(row, input)) return Option.some("stale")
      tx.update(row, { ...terminal("released", "scope-drained"), evidence: Option.some(input.evidence) })
      return Option.none()
    case "renew":
      if (!matches(row, input)) return Option.some("stale")
      renew(tx, row, observation.now)
      return Option.none()
    case "job-control":
      if (!matches(row, input) || row.state !== "running") return Option.some("stale")
      if (input.paused) tx.update(row, { reason: "stopped", expiresBootMs: Option.none() })
      else if (Option.exists(row.hardDeadline, (at) => at <= observation.now)) cancel(tx, row)
      else {
        const next = observation.now + POLICY.supervisionMs
        const until = Math.min(next, Option.getOrElse(row.hardDeadline, () => next))
        tx.update(row, { reason: "running", expiresBootMs: Option.some(until) })
      }
      return Option.none()
  }
}

const register = (tx: Transaction, bootId: string, input: Extract<Input, { op: "request" }>, observation: Observation): Result.Result<string, Reason> => {
  const request = normalizeRequest(input.request)
  const known = tx.rows().find((row) => row.request.requestId === request.requestId && row.owner === input.owner)
  if (known) {
    if (sameRequest(known.request, request)) return Result.succeed(known.id)
    return Result.fail("invalid-request")
  }
  if (!validRequest(request, observation.now)) return Result.fail("invalid-request")
  const limit = observation.envelope ?? observation.sample?.envelope
  if (!limit) return Result.fail("unavailable")
  const problem = feasibility(request, limit)
  if (Option.isSome(problem)) return Result.fail(problem.value)
  const ticket = tx.nextTicket()
  const id = `${bootId}:${ticket}`
  tx.update({
    id, ticket, generation: 0, owner: input.owner, request,
    state: "queued", reason: "queued", sequence: 0, changedAt: observation.now, binding: Option.none(),
    evidence: Option.none(), sampleId: Option.none(), admittedDemand: Option.none(),
    expiresBootMs: Option.none(), hardDeadline: Option.none(),
  }, {})
  return Result.succeed(id)
}

const apply = (tx: Transaction, bootId: string, input: Input, observation: Observation): Result.Result<string, Reason> => {
  if (input.op === "request") return register(tx, bootId, input, observation)
  if (input.op === "advance") return Result.fail("unknown-id")
  const row = tx.get(input.id)
  if (Option.isNone(row)) return Result.fail("unknown-id")
  const error = act(tx, row.value, input, observation)
  if (Option.isSome(error)) return Result.fail(error.value)
  return Result.succeed(input.id)
}

const respond = (tx: Transaction, state: Admission, result: Result.Result<string, Reason>): Reply => {
  if (Result.isFailure(result)) return refusal(state, result.failure)
  return Option.match(tx.get(result.success), { onNone: () => refusal(state, "unknown-id"), onSome: (row) => receipt(state, row) })
}

export const transition = (state: Admission, input: Input, observation: Observation): Outcome => {
  let revision = state.revision
  const leases = new Map(Object.entries(state.leases))
  const changes: Lease[] = []
  const tx: Transaction = {
    rows: () => [...leases.values()].toSorted((a, b) => a.ticket - b.ticket),
    nextTicket: () => revision + 1,
    get: (id) => Option.fromNullishOr(leases.get(id)),
    update: (row, patch) => {
      const next = { ...row, ...patch, sequence: ++revision, changedAt: observation.now }
      leases.set(next.id, next)
      changes.push(next)
      return next
    },
  }
  expire(tx, observation.now)
  requalify(tx, observation)
  const result = apply(tx, state.bootId, input, observation)
  let landBurst = state.landBurst
  // Under the fixed cap any observation with its envelope decides: a lease
  // waits on the ledger alone, never on a sample.
  if (observation.sample || input.op === "request" || input.op === "advance" || Option.isSome(fixedLimit(observation)))
    landBurst = allocate(tx, observation, landBurst)
  const next = { ...state, revision, landBurst, leases: Object.fromEntries(leases) }
  return { state: next, reply: respond(tx, next, result), changes }
}
