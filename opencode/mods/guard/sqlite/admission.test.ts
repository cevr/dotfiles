import { Effect, FileSystem, Option, Path, Result, Schema } from "effect"
import { test } from "bun:test"
import { expect, it } from "effect-bun-test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Admission, initial, type Input, transition, type Lease } from "../admission.ts"
import { owner, request, supply } from "../memory/admission-acceptance.ts"
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
  const ready = supply({ cores: 3 })
  const held = { now: 0 }
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
      overrides: { volumes: { "volume-a": { freeBytes, freeInodes: 10_000, metadataFreeBytes: 2 ** 30, diskFloorBytes: 6 * 2 ** 30 } } } })
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
