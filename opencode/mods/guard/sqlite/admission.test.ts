import { Effect, FileSystem, Option, Path, Result, Schema } from "effect"
import { test } from "bun:test"
import { expect, it } from "effect-bun-test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Admission, initial, type Input, transition, type Lease } from "../admission.ts"
import { owner, request, supply } from "../memory/admission-acceptance.ts"
import { POLICY } from "../host-supply.ts"
import { canonicalHolder, Holder, holderOf, NO_PROOF, UNKNOWN_OWNER, UNKNOWN_USAGE } from "../host-resources.ts"
import fixtures from "../fixtures/holder-v1.json"
import { open } from "./admission.ts"

const HOST = { hostId: "host-fixture", bootId: "boot-fixture" }
const persisted = Schema.fromJsonString(Admission)
const encode = Schema.encodeSync(persisted)
const decode = Schema.decodeUnknownSync(persisted)
const first = (id: string, cpu = 1000): Input => ({ op: "request", request: request(id, cpu), owner: owner(id) })

// Interval oracle: at any tick the allowed prefix of start-to-close
// intervals is determined by original arrival order, not call frequency.
const keys = ["a", "b", "c", "d", "e", "f", "g"]
const generated = (seed: number) => keys.map((id, i) => ({ id, weight: 1 + ((seed >> (i % 6)) & 1), exclusive: (seed + 3 * i) % 5 === 0 }))
const expectedPrefix = (remaining: ReadonlyArray<ReturnType<typeof generated>[number]>) => {
  let slots = 3
  const ready = []
  for (const row of remaining) {
    if (row.exclusive) {
      if (ready.length === 0) ready.push(row)
      break
    }
    if (row.weight > slots) break
    slots -= row.weight
    ready.push(row)
  }
  return ready
}

const openInterval = (row: Lease) => row.state === "running" || row.state === "draining" || row.state === "granted"
const oracle = (seed: number) => {
  const remaining = generated(seed)
  let state = initial("host", "boot")
  let now = 0
  const send = (input: Input) => {
    const next = transition(state, input, supply({ now, cores: 5 }))
    state = next.state
    return next.reply
  }
  const byRequest = (id: string) => Object.values(state.leases).find((row) => row.request.requestId === id)
  const post = ({ id, weight, exclusive }: (typeof remaining)[number]) =>
    send({ op: "request", request: request(id, weight * 1000, exclusive), owner: owner(id) })
  remaining.forEach(post)
  state = decode(encode(state))
  const retry = remaining[seed % keys.length]
  if (retry) {
    const original = byRequest(retry.id)
    expect(post(retry).id).toBe(original?.id || "expected-original-ticket")
  }
  expect(Object.keys(state.leases)).toHaveLength(keys.length)
  for (let wave = 0; remaining.length > 0 && wave < keys.length; wave++) {
    const wanted = expectedPrefix(remaining).map((row) => row.id)
    const held = Object.values(state.leases).filter(openInterval)
    expect(held.map((row) => row.request.requestId)).toEqual(wanted)
    for (const row of held)
      expect(send({ op: "claim", id: row.id, generation: row.generation, owner: row.owner, binding: `scope-${row.id}` }).state).toBe("running")
    for (const row of held) {
      const fence = { op: "drain", id: row.id, binding: `scope-${row.id}`, evidence: "drained" } as const
      expect(send({ ...fence, generation: row.generation + 1 }).reason).toBe("stale")
      expect(byRequest(row.request.requestId)?.state).toBe("running")
      expect(send({ ...fence, generation: row.generation }).state).toBe("released")
    }
    remaining.splice(0, wanted.length)
    now += 1
  }
  expect(remaining).toEqual([])
  expect(Object.values(state.leases).filter(openInterval)).toEqual([])
}

test("FIFO and exclusive drain match a weighted interval oracle over 64 histories, restart and repeat", () => {
  for (let seed = 0; seed < 64; seed++) oracle(seed)
})

test("an impossible request has no ticket; a full-width request can run and cannot starve its successor", () => {
  const at = supply({ cores: 12 })
  const huge = request("huge", 1000, true)
  const refused = transition(initial("host", "boot"), {
    op: "request", owner: owner("huge"), request: {
      ...huge, demand: { ...huge.demand, memoryBytes: 40 * 2 ** 30 },
    },
  }, at)
  expect(refused.reply.state).toBe("refused")
  expect(refused.reply.id).toBeNull()
  expect(Object.values(refused.state.leases)).toEqual([])
  const candidate = request("large")
  const full = transition(refused.state, {
    op: "request", owner: owner("large"), request: { ...candidate, demand: { ...candidate.demand, width: "unknown" } },
  }, at)
  expect(full.reply.state).toBe("granted")
  expect(full.reply.admittedDemand?.cpuMilli).toBe(10_000)
  const younger = transition(full.state, first("younger"), at)
  expect(younger.reply.state).toBe("queued")
  const now = transition(younger.state, { op: "cancel", id: full.reply.id || "missing", owner: owner("large") }, at)
  expect(now.state.leases[younger.reply.id || "missing"]?.state).toBe("granted")
})

test("a whole-pool request cannot be skipped by another volume or land; half free is sufficient to claim", () => {
  const empty = initial("host", "boot")
  const outside = (milli: number, now: number) => supply({ cores: 12, now, overrides: { outsideNoncriticalMilli: milli } })
  const first = request("full")
  const full = transition(empty, { op: "request", owner: owner("full"), request: {
    ...first, demand: { ...first.demand, width: "unknown" },
  } }, outside(5001, 1))
  expect(full.reply.reason).toBe("outside-busy")
  const busy = supply({ cores: 12, now: 2, overrides: { runnable: 12, outsideNoncriticalMilli: 7500 } })
  const fullAddress = { op: "status", id: full.reply.id || "missing", owner: owner("full") } as const
  expect(transition(full.state, fullAddress, busy).reply.reason).toBe("outside-busy")
  const peer = request("peer")
  const younger = transition(full.state, { op: "request", owner: owner("peer"), request: {
    ...peer, purpose: "land-check", demand: { ...peer.demand, volumeReservations: [{ volumeId: "volume-b", bytes: 0 }] },
  } }, outside(5001, 2))
  expect(younger.reply.reason).toBe("fifo")
  const id = full.reply.id || "missing"
  const granted = transition(younger.state, { op: "status", id, owner: owner("full") }, outside(5000, 3))
  expect(granted.reply.state).toBe("granted")
  expect(granted.reply.admittedDemand?.cpuMilli).toBe(10_000)
  const running = transition(granted.state, { op: "claim", id, owner: owner("full"), generation: 1, binding: "scope" }, outside(5000, 4))
  expect(running.reply.state).toBe("running")
  const released = transition(running.state, { op: "drain", id, generation: 1, binding: "scope", evidence: "gone" }, outside(5000, 5))
  expect(released.state.leases[younger.reply.id || "missing"]?.state).toBe("granted")
  for (const trace of [[9999, 7500, 5001, 5000], [8500, 4000], [5001, 9500, 5001, 1200]]) {
    let state = full.state
    for (const [i, busy] of trace.entries()) {
      const tick = transition(state, { op: "status", id, owner: owner("full") }, outside(busy, i + 2))
      if (busy > 5000) expect(tick.reply.reason).toBe("outside-busy")
      else expect(tick.reply.reason).toBe("granted")
      state = tick.state
    }
  }
})

test("a persisted waiter made impossible by the host envelope stops fencing its younger peer", () => {
  const unavailable = supply({ overrides: { pressure: "hold" }, now: 1 })
  const legacy = request("legacy")
  const queued = transition(initial("host", "boot"), { op: "request", owner: owner("legacy"), request: {
    ...legacy, demand: { ...legacy.demand, memoryBytes: 10 * 2 ** 30, width: "unknown" },
  } }, unavailable)
  expect(queued.reply.state).toBe("queued")
  const quiet = supply({ now: 2 })
  const envelope = { ...quiet.envelope, memoryBytes: 8 * 2 ** 30 }
  const resumed = transition(queued.state, first("younger"), { ...quiet, envelope, sample: { ...quiet.sample, envelope } })
  expect(resumed.state.leases[queued.reply.id || "missing"]?.state).toBe("refused")
  expect(resumed.state.leases[queued.reply.id || "missing"]?.reason).toBe("memory-limit")
  expect(resumed.reply.state).toBe("granted")
})

const memoryRequest = (name: string, gib: number): Input => {
  const draft = request(name)
  return { op: "request", owner: owner(name), request: { ...draft, demand: { ...draft.demand, memoryBytes: gib * 2 ** 30 } } }
}
test("shared memory is reserved under every ceiling through claim and drain", () => {
  const gib = 2 ** 30
  for (const [physical, controller, fresh] of [[24, 6, 24], [6, 24, 24], [24, 24, 7], [6, 9, 12], [10, 10, 8]]) {
    if (!physical || !controller || !fresh) continue
    const at = supply({ cores: 12 })
    const envelope = { ...at.envelope, memoryBytes: physical * gib, containedMemoryBytes: controller * gib }
    const observation = { ...at, envelope, sample: { ...at.sample, envelope, memoryBytes: fresh * gib } }
    const a = transition(initial("host", "boot"), memoryRequest("a", 4), observation)
    expect(a.reply.state).toBe("granted")
    const aId = a.reply.id ?? "missing"
    const bound = transition(a.state, { op: "claim", id: aId, generation: 1, owner: owner("a"), binding: "scope-a" }, observation)
    expect(bound.reply.state).toBe("running")
    const b = transition(bound.state, memoryRequest("b", 4), observation)
    expect(b.reply.state).toBe("queued")
    expect(b.reply.reason).toBe("memory")
    const bId = b.reply.id ?? "missing"
    const failed = transition(b.state, { op: "claim", id: bId, generation: 1, owner: owner("b"), binding: "scope-b" }, observation)
    expect(failed.reply.reason).toBe("stale")
    const cancelled = transition(failed.state, { op: "cancel", id: aId, owner: owner("a") }, observation)
    expect(cancelled.state.leases[bId]?.state).toBe("queued")
    const released = transition(cancelled.state, { op: "drain", id: aId, generation: 1, binding: "scope-a", evidence: "drained" }, observation)
    expect(released.state.leases[bId]?.state).toBe("granted")
  }
})

test("generated reservation histories preserve static and fresh limits", () => {
  const gib = 2 ** 30
  for (let index = 0; index < 40; index += 1) {
    const physical = 5 + index % 9
    const controller = 5 + index % 13
    const fresh = 6 + index % 11
    const disk = 3 + index % 7
    const diskFree = 2 + index % 8
    const cpuFree = 4 + index % 7
    const at = supply({ cores: 12, overrides: { outsideNoncriticalMilli: 1000 * (10 - cpuFree) } })
    const envelope = { ...at.envelope, memoryBytes: physical * gib, containedMemoryBytes: controller * gib,
      volumes: { "volume-a": disk * gib }, needsMemoryReservation: true }
    const volumes = { "volume-a": { capacityBytes: 24 * gib, freeBytes: (6 + diskFree) * gib,
      diskFloorBytes: 6 * gib, metadataFreeBytes: gib, freeInodes: 10_000 } }
    const observation = { ...at, envelope, sample: { ...at.sample, envelope, volumes, memoryBytes: fresh * gib } }
    let state = initial("host", "boot")
    const send = (input: Input) => {
      state = transition(state, input, observation).state
      const reserves = Object.values(state.leases).filter(openInterval).flatMap((row) => Option.toArray(row.admittedDemand))
      const memory = reserves.map((d) => d.memoryBytes / gib)
      expect(memory.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(Math.min(physical, controller, fresh - 1))
      expect(Math.max(0, ...memory)).toBeLessThanOrEqual(12)
      expect(reserves.reduce((sum, d) => sum + d.cpuMilli, 0)).toBeLessThanOrEqual(cpuFree * 1000)
      expect(reserves.flatMap((d) => d.volumeReservations).reduce((sum, v) => sum + v.bytes / gib, 0))
        .toBeLessThanOrEqual(Math.min(disk, diskFree))
    }
    for (let each = 1; each <= 8; each += 1) {
      const name = `memory-${each}`
      const draft = request(name, 1000 * (1 + (index + each) % 3))
      send({ op: "request", owner: owner(name), request: { ...draft, demand: {
        ...draft.demand, memoryBytes: (1 + (index * each) % 16) * gib,
        volumeReservations: [{ volumeId: "volume-a", bytes: (1 + (index + each * 3) % 5) * gib }],
      } } })
      for (const row of Object.values(state.leases)) {
        const { id, owner, generation } = row
        const binding = `scope-${id}`
        if (row.state === "granted") send({ op: "claim", id, owner, generation, binding })
        if (row.state === "running" && (index + each + row.ticket) % 2 === 0) send({ op: "cancel", id, owner })
        if (row.state === "draining" && (index + each + row.ticket) % 3 === 0) send({ op: "drain", id, generation, binding, evidence: "gone" })
      }
    }
  }
})

test("the fresh claim cannot use a grant after aggregate controller memory contracted", () => {
  const observation = supply({ cores: 12, overrides: { memoryBytes: 24 * 2 ** 30 } })
  const a = transition(initial("host", "boot"), memoryRequest("first", 4), observation)
  const b = transition(a.state, memoryRequest("second", 4), observation)
  expect(b.reply.state).toBe("granted")
  const envelope = { ...observation.envelope, containedMemoryBytes: 6 * 2 ** 30 }
  const tightened = { ...observation, envelope, sample: { ...observation.sample, envelope } }
  const claim = transition(b.state, {
    op: "claim", id: b.reply.id ?? "missing", owner: owner("second"), binding: "second-scope", generation: 1,
  }, tightened)
  expect(claim.reply.state).toBe("queued")
  expect(claim.reply.reason).toBe("memory")
  const released = transition(claim.state, { op: "cancel", id: a.reply.id ?? "missing", owner: owner("first") }, tightened)
  expect(released.state.leases[b.reply.id ?? "missing"]?.state).toBe("granted")
})

test("queued work expires at its deadline, and growing the pool cannot overtake a live whole-pool hold", () => {
  const draft = request("whole")
  const start: Input = { op: "request", owner: owner("whole"), request: {
    ...draft, deadlineBootMs: 10, demand: { ...draft.demand, width: "unknown" },
  } }
  const busy = supply({ cores: 8, now: 1, overrides: { outsideNoncriticalMilli: 5000 } })
  const waiting = transition(initial("host", "boot"), start, busy)
  const id = waiting.reply.id ?? "missing"
  const status = { op: "status", id, owner: owner("whole") } as const
  expect(transition(waiting.state, status, { ...busy, now: 9 }).reply.state).toBe("queued")
  expect(transition(waiting.state, status, { ...busy, now: 10 }).reply.reason).toBe("deadline")
  const half = supply({ cores: 8, now: 2 })
  const grant = transition(waiting.state, status, half)
  const running = transition(grant.state, { op: "claim", id, generation: 1, owner: owner("whole"), binding: "scope" }, half)
  expect(running.reply.state).toBe("running")
  const grown = supply({ cores: 16, now: 3 })
  const peer = transition(running.state, first("later"), grown)
  expect(peer.reply.state).toBe("queued")
  const after = transition(peer.state, { op: "drain", id, generation: 1, binding: "scope", evidence: "gone" }, grown)
  expect(after.state.leases[peer.reply.id ?? "missing"]?.state).toBe("granted")
})

const witness = (cores: number, exclusive: boolean, width: ReturnType<typeof request>["demand"]["width"],
  volume: string, memoryBytes: number, bytes: number) => {
  const blocked = supply({ cores, now: 1, overrides: { pressure: "hold" } })
  const quiet = supply({ cores, now: 2 })
  const draft = request("candidate", 1000, exclusive)
  const input: Input = { op: "request", owner: owner("candidate"), request: {
    ...draft, demand: { ...draft.demand, width, memoryBytes, volumeReservations: [{ volumeId: volume, bytes }] },
  } }
  const result = transition(initial("host", "boot"), input, blocked)
  if (volume === "unmounted" || memoryBytes > POLICY.maxRequestMemoryBytes || bytes >= 64 * 2 ** 30) {
    expect(result.reply.state).toBe("refused")
    expect(result.reply.id).toBeNull()
    return
  }
  expect(result.reply.state).toBe("queued")
  const witnessed = transition(result.state, { op: "advance" }, quiet)
  const row = witnessed.state.leases[result.reply.id || "missing"]
  expect(row?.state).toBe("granted")
  const expected = Math.min(quiet.envelope.cpuMilli, Number(width) * 1000 || quiet.envelope.cpuMilli)
  expect(Option.getOrUndefined(row?.admittedDemand ?? Option.none())?.cpuMilli).toBe(expected)
}

test("all queued demands have an empty-host grant witness, for shared and exclusive classes", () => {
  const widths = ["unknown", "full", request("candidate", 1000).demand.width, request("candidate", 40_000).demand.width] as const
  for (const cores of [3, 8, 12]) for (const exclusive of [false, true]) {
    for (const width of widths) for (const volume of ["volume-a", "volume-b", "unmounted"]) {
      for (const memory of [2 ** 30, 40 * 2 ** 30]) for (const bytes of [0, 64 * 2 ** 30]) {
        witness(cores, exclusive, width, volume, memory, bytes)
      }
    }
  }
})

test("a visible job-control stop holds the exact generation, with a bounded resume", () => {
  const at = supply({ cores: 3 })
  const start = transition(initial("host", "boot"), first("terminal"), at)
  const id = start.reply.id || "missing"
  const binding = "terminal-fence"
  const generation = 1
  const claimed = transition(start.state, { op: "claim", id, generation, binding, owner: owner("terminal") }, at)
  const after = supply({ cores: 3, now: POLICY.maxRunningMs - 100 })
  const stop = { op: "job-control", id, generation, binding, paused: true } as const
  const paused = transition(claimed.state, stop, at)
  const blocked = transition(paused.state, first("queued"), supply({ now: POLICY.supervisionMs + 1, cores: 3 }))
  expect(blocked.reply.state).toBe("queued")
  expect(blocked.state.leases[id]?.reason).toBe("stopped")
  expect(transition(blocked.state, { ...stop, paused: false, generation: 2 }, after).reply.reason).toBe("stale")
  const resumed = transition(blocked.state, { ...stop, paused: false }, after)
  expect(resumed.reply.reason).toBe("running")
  expect(resumed.reply.expiresBootMs).toBe(POLICY.maxRunningMs)
})

test("blocked disk and key demand leave a different volume and key available; runnable pressure is host-wide", () => {
  const at = supply({ cores: 16 })
  const first = request("a")
  const unavailable = { ...first, demand: { ...first.demand, keys: ["device-a"], volumeReservations: [{ volumeId: "volume-a", bytes: 20 * 2 ** 30 }] } }
  const independent = { ...request("b"), demand: { ...first.demand, keys: ["device-b"], volumeReservations: [{ volumeId: "volume-b", bytes: 0 }] } }
  const parked = transition(initial("host", "boot"), { op: "request", request: unavailable, owner: owner("a") }, at)
  expect(parked.reply.reason).toBe("disk")
  const second = { op: "request", request: independent, owner: owner("b") } as const
  expect(transition(parked.state, second, at).reply.state).toBe("granted")
  expect(transition(parked.state, second, supply({ cores: 32, overrides: { runnable: 25 } })).reply.reason).toBe("pressure")
})

test("bounded land priority yields to the older normal request, and never jumps an exclusive waiter", () => {
  let state = initial("host", "boot")
  const ready = supply({ cores: 6, overrides: { pressure: "degraded" } })
  const held = { now: 0, envelope: ready.envelope }
  for (const id of ["check", "land-a", "land-b", "land-c", "exclusive", "land-d"]) {
    const draft = request(id, 1000, id === "exclusive")
    let purpose = draft.purpose
    if (id.startsWith("land-")) purpose = "land-check"
    state = transition(state, { op: "request", owner: owner(id), request: { ...draft, purpose } }, held).state
  }
  const actual: string[] = []
  for (let i = 0; i < 6; i++) {
    state = transition(state, { op: "advance" }, ready).state
    const open = Object.values(state.leases).find((row) => row.state === "granted")
    if (!open) break
    actual.push(open.request.requestId)
    state = transition(state, { op: "cancel", id: open.id, owner: open.owner }, ready).state
  }
  expect(actual).toEqual(["land-a", "land-b", "check", "land-c", "exclusive", "land-d"])
})

it.effect("holder v1 matches the cross-language canonical bytes", () =>
  Effect.gen(function* () {
    const disk = yield* Schema.decodeUnknownEffect(Holder)(fixtures.fixtures.disk)
    expect(canonicalHolder(disk)).toBe(fixtures.normalized.disk)
  }),
)

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "lease-journal-" })
  const folder = yield* fs.realPath(scratch)
  const file = path.join(folder, "fixture.sqlite")
  const a = yield* open(file, HOST)
  const b = yield* open(file, HOST)
  return { a, b, file }
})

it.scoped("two SQLite connections share FIFO, replay and generation-fenced drain", () =>
  Effect.gen(function* () {
    const { a, b } = yield* fixture
    const at = supply({ cores: 3 })
    const holder = yield* a.ledger.transact(first("a"), at)
    const queued = yield* b.ledger.transact(first("b"), at)
    expect(holder.reply.state).toBe("granted")
    expect(queued.reply.state).toBe("queued")
    const id = holder.reply.id ?? "missing"
    const asker = { id, owner: owner("a") }
    yield* b.ledger.transact({ ...asker, op: "claim", binding: "scope-a", generation: 1 }, at)
    const blocked = yield* a.ledger.transact({ ...asker, op: "observe", generation: 1, liveness: "gone", evidence: "owner-retired" }, at)
    expect(blocked.reply.state).toBe("draining")
    yield* b.ledger.transact({ op: "drain", id, binding: "scope-a", generation: 2, evidence: "old-epoch" }, at)
    expect((yield* b.ledger.transact({ ...asker, op: "status" }, at)).reply.state).toBe("draining")
    const freed = yield* a.ledger.transact({ op: "drain", id, binding: "scope-a", generation: 1, evidence: "scope-empty" }, at)
    expect(freed.reply.state).toBe("released")
    const replay = yield* b.ledger.replay({ id: queued.reply.id ?? "missing", owner: owner("b") }, queued.reply.sequence)
    expect(replay.map((event) => event.state)).toEqual(["granted"])
    expect(yield* a.ledger.replay({ ...asker, owner: "not-a" }, 0)).toEqual([])
  }).pipe(Effect.provide(BunServices.layer)),
)

it.scoped("an aged reading and a changed canonical disk floor do not start a reserved attempt", () =>
  Effect.gen(function* () {
    const { a, b } = yield* fixture
    const before = supply({ now: 1 })
    const at = (freeBytes: number, now: number) => supply({ now,
      overrides: { volumes: { "volume-a": { capacityBytes: 64 * 2 ** 30, freeBytes, freeInodes: 10_000, metadataFreeBytes: 2 ** 30, diskFloorBytes: 6 * 2 ** 30 } } } })
    const reserved = yield* a.ledger.transact(first("a"), at(6 * 2 ** 30, 1))
    expect(reserved.reply.state).toBe("granted")
    const id = reserved.reply.id ?? "missing"
    const claim = { op: "claim", id, generation: 1, owner: owner("a"), binding: "scope" } as const
    const stale = yield* b.ledger.transact(claim, { ...before, now: 2500 })
    expect(stale.reply).toMatchObject({ state: "queued", reason: "stale-sample" })
    const below = yield* b.ledger.transact({ op: "status", id, owner: owner("a") }, at(5 * 2 ** 30, 2600))
    expect(below.reply).toMatchObject({ state: "queued", reason: "disk" })
    const regroup = yield* a.ledger.transact({ op: "status", id, owner: owner("a") }, at(7 * 2 ** 30, 3000))
    expect(regroup.reply.state).toBe("granted")
    expect((yield* b.ledger.transact(claim, at(7 * 2 ** 30, 3050))).reply.reason).toBe("stale")
    expect((yield* b.ledger.transact({ ...claim, generation: 2 }, at(7 * 2 ** 30, 3100))).reply.state).toBe("running")
  }).pipe(Effect.provide(BunServices.layer)),
)

const observation = (seq: number): Holder => holderOf({
  version: 1, ...HOST, resourceId: `resource-${seq}`, incarnation: "incarnation", holderId: `holder-${seq}`,
  revision: Option.none(), kind: "file-set", owner: UNKNOWN_OWNER, relation: "observation", parentResourceId: Option.none(),
  dependsOn: ["key-b", "key-a", "key-b"], placement: { volumeId: Option.some("volume-a"), objectRef: Option.some("object"), confinementRef: Option.none() },
  lease: Option.none(), usage: UNKNOWN_USAGE, observedAtMs: 10_000, sampleBootMs: 1, lastUseAtMs: Option.none(),
  coverage: "partial", state: "unknown", proof: NO_PROOF, protection: "unknown", producerId: "scanner", producerSeq: seq,
})

it.scoped("holder updates pin a revision and scanner forgery rolls back the whole batch", () =>
  Effect.gen(function* () {
    const { a, b, file } = yield* fixture
    const [old] = yield* a.holder.putObservations("scanner", [observation(1), observation(1)], 2)
    expect(old?.dependsOn).toEqual(["key-a", "key-b"])
    expect(yield* b.holder.putObservations("scanner", [observation(1)], 2)).toEqual([old])
    const forged: Holder = { ...observation(3), state: "terminal" }
    const denied = yield* Effect.result(a.holder.putObservations("scanner", [observation(2), forged], 2))
    expect(Result.isFailure(denied)).toBe(true)
    const before = yield* a.holder.list(0)
    expect(before.records).toEqual([old])
    yield* b.holder.putObservations("scanner", [observation(2)], 3)
    expect(yield* a.holder.list(0, before.revision)).toEqual(before)
    expect((yield* b.holder.list(0)).records).toHaveLength(2)
    const rebooted = yield* open(file, { ...HOST, bootId: "boot-next" })
    const after = yield* rebooted.holder.list(0)
    expect(after.records).toEqual([])
    expect(after.revision).toBeGreaterThan(before.revision)
  }).pipe(Effect.provide(BunServices.layer)),
)
