// @reads all
// @reads-reason computed read at mods/guard/process/admission.ts: textOf's fs.readFileString(file), served here by cgroup-fixture.ts's in-memory FileSystem, never the disk
// One truth for every decider (wb-admit2-findings-r2.md, B3): only one
// host-admit samples at a time, so a decision may never rest on which
// process holds the sampler. What the host last measured (each volume, CPU,
// memory, with its time) is ledger state every caller reads alike:
// - safety: over generated interleavings of a sampler, callers without a
//   sample, a slow sampler (an older reading arriving late), a sampler whose
//   volume read timed out, claims, drains and long gaps (a crashed or
//   restarted sampler), no lease is granted or approved onto a resource the
//   latest recorded reading, within its bound, shows short;
// - liveness: when the latest reading shows room, the queue is served in
//   FIFO order by whichever caller steps next, sampler or not.
// The capped path (the workbox, unattested) and the measured one (the Mac)
// alike; the measured path also grants nothing it has not freshly measured.
import { describe, test } from "bun:test"
import { Effect, Option } from "effect"
import { expect, it } from "effect-bun-test"
import { type Admission, type Input, initial, type Lease, type Observation, transition } from "../admission.ts"
import { type Request, widthOf } from "../admission-wire.ts"
import { type HostEnvelope, hostEnvelope, type Measurements, measureSupply, POLICY, type Supply } from "../host-supply.ts"
import { CORE_KEYS, linuxEnvelope } from "./admission.ts"
import { run, WORKBOX } from "./cgroup-fixture.ts"

const GiB = 2 ** 30
const VOLUME = "v"
type Room = "room" | "short"
/** What one sample says: of the volume (or that its read failed), memory, CPU. */
interface Load {
  readonly disk: Room | "unread"
  readonly memory: Room
  readonly cpu: Room
}
const ROOM: Load = { disk: "room", memory: "room", cpu: "room" }
/** `yes` when `cond` holds, else `no`. */
const either = <A>(cond: boolean, yes: A, no: A): A => Option.getOrElse(Option.liftPredicate(yes, () => cond), () => no)
const ONE = Option.getOrThrow(widthOf(1))

const request = (id: string, now: number): Request => ({
  version: 1, requestId: id, principal: { kind: "external-runner", scopeId: "p", epoch: 1 },
  purpose: "check", tier: "standard", deadlineBootMs: now + POLICY.queueMs - 1,
  demand: { width: ONE, cpuMilli: 1000, memoryBytes: GiB, ioClass: "idle", keys: [], volumeReservations: [{ volumeId: VOLUME, bytes: 0 }] },
})

const VOLUMES = {
  room: { [VOLUME]: { capacityBytes: 106 * GiB, freeBytes: 90 * GiB, freeInodes: "dynamic", metadataFreeBytes: 4 * GiB, diskFloorBytes: POLICY.diskFloorBytes } },
  short: { [VOLUME]: { capacityBytes: 106 * GiB, freeBytes: 0, freeInodes: "dynamic", metadataFreeBytes: 0, diskFloorBytes: POLICY.diskFloorBytes } },
  unread: {},
} satisfies Record<Load["disk"], Measurements["volumes"]>
const sampleOf = (envelope: HostEnvelope, at: number, id: string, load: Load): Supply => {
  const measurements: Measurements = {
    platform: either(envelope.needsMemoryReservation, "linux", "darwin"),
    effectiveCpuMilli: 16000, totalMemoryBytes: 64 * GiB, controllerAvailable: true, keys: CORE_KEYS,
    id, hostCpuMilli: 16000, before: { idle: 0, total: 0, at: at - 500 },
    after: { idle: { room: 900, short: 0 }[load.cpu], total: 1000, at },
    runnable: 1, memoryBytes: { room: 50 * GiB, short: GiB }[load.memory], pressure: "clear", qualified: true, managed: [], protectedLowerBoundMilli: 0,
    volumes: VOLUMES[load.disk],
  }
  const attested = Option.match(Option.fromNullishOr(envelope.attestation), {
    onNone: () => measurements, onSome: (attestation): Measurements => ({ ...measurements, attestation }),
  })
  return Option.getOrThrow(measureSupply(attested, envelope))
}

const workbox = Effect.map(run(WORKBOX, linuxEnvelope), (envelope): HostEnvelope => ({ ...envelope, volumes: { [VOLUME]: 100 * GiB } }))
const mac = hostEnvelope({
  platform: "darwin", effectiveCpuMilli: 16000, totalMemoryBytes: 64 * GiB, controllerAvailable: true, keys: CORE_KEYS,
  volumes: { [VOLUME]: { capacityBytes: 106 * GiB, diskFloorBytes: POLICY.diskFloorBytes } },
})
const leaseOf = (state: Admission, id: string) => Option.fromNullishOr(state.leases[id])
const phase = (state: Admission, id: string) => Option.match(leaseOf(state, id), {
  onNone: () => ({ state: "missing", reason: "missing" }), onSome: ({ state, reason }) => ({ state: String(state), reason: String(reason) }),
})
const onlyId = (state: Admission) => Object.keys(state.leases)[0] ?? ""

describe("the r2 probe: a caller that lost the sampler slot", () => {
  it.effect("on the capped path, a fresh full reading still holds the lease 200 ms later for a caller with no sample", () =>
    Effect.gen(function* () {
      const envelope = yield* workbox
      const sample = sampleOf(envelope, 9500, "s1", { ...ROOM, disk: "short" })
      const first = transition(initial("h", "b"), { op: "request", owner: "o", request: request("r", 10_000) }, { now: 10_000, envelope, sample })
      expect({ state: first.reply.state, reason: first.reply.reason }).toEqual({ state: "queued", reason: "disk" })
      const id = onlyId(first.state)
      // measure() returned cut(now) to the loser; attest() added the envelope.
      const second = transition(first.state, { op: "status", id, owner: "o" }, { now: 10_200, envelope })
      expect(phase(second.state, id)).toEqual({ state: "queued", reason: "disk" })
      // A newer reading with room serves the queue; the full one, once
      // older than the bound with nothing newer, is unmeasured and admits.
      const roomy = transition(second.state, { op: "status", id, owner: "o" },
        { now: 11_000, envelope, sample: sampleOf(envelope, 10_900, "s2", ROOM) })
      expect(phase(roomy.state, id).state).toBe("granted")
      const aged = transition(second.state, { op: "status", id, owner: "o" }, { now: 9500 + POLICY.readingMs + 1, envelope })
      expect(phase(aged.state, id).state).toBe("granted")
    }))

  it.effect("a timed-out volume read is no new fact: the last full reading keeps holding", () =>
    Effect.gen(function* () {
      const envelope = yield* workbox
      const first = transition(initial("h", "b"), { op: "request", owner: "o", request: request("r", 10_000) },
        { now: 10_000, envelope, sample: sampleOf(envelope, 9500, "s1", { ...ROOM, disk: "short" }) })
      const id = onlyId(first.state)
      const later = transition(first.state, { op: "status", id, owner: "o" },
        { now: 30_000, envelope, sample: sampleOf(envelope, 29_900, "s2", { ...ROOM, disk: "unread" }) })
      expect(phase(later.state, id)).toEqual({ state: "queued", reason: "disk" })
    }))

  test("on the measured path (the Mac), a caller with no sample decides on the host's fresh reading, and a slow sampler's older reading never overrides a newer one", () => {
    const sampled = transition(initial("h", "b"), { op: "request", owner: "o", request: request("r", 10_000) },
      { now: 10_000, sample: sampleOf(mac, 9900, "s1", ROOM) })
    const id = onlyId(sampled.state)
    const generation = Option.match(leaseOf(sampled.state, id), { onNone: () => -1, onSome: (row) => row.generation })
    expect(phase(sampled.state, id).state).toBe("granted")
    // The claim step of a process that lost the sampler slot.
    const claimed = transition(sampled.state, { op: "claim", id, owner: "o", generation, binding: "b1" }, { now: 10_300, envelope: mac })
    expect(phase(claimed.state, id).state).toBe("running")
    const full = transition(sampled.state, { op: "request", owner: "o", request: request("r2", 10_400) },
      { now: 10_400, sample: sampleOf(mac, 10_350, "s2", { ...ROOM, memory: "short" }) })
    const slow = transition(full.state, { op: "advance" }, { now: 10_500, sample: sampleOf(mac, 10_000, "s0", ROOM) })
    const second = Object.values(slow.state.leases).find((lease) => lease.request.requestId === "r2")
    expect({ state: second?.state, reason: second?.reason }).toEqual({ state: "queued", reason: "memory" })
  })
})

/** mulberry32: each run replays its seed. */
const random = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
const pick = <A>(next: () => number, items: readonly [A, ...ReadonlyArray<A>]): A => items[Math.floor(next() * items.length)] ?? items[0]
const pickRow = (next: () => number, rows: ReadonlyArray<Lease>) => Option.fromNullishOr(rows[Math.floor(next() * rows.length)])

type Path = "capped" | "measured"
type Caller = "sampler" | "loser" | "slow" | "timed-out"
interface Reading {
  readonly at: number
  readonly load: Load
}
/** The model: the newest reading delivered to any transaction, whichever
 * process carried it, and the newest reading of the volume. A tie goes to
 * the later delivery. */
interface Truth {
  readonly sample: Option.Option<Reading>
  readonly volume: Option.Option<{ readonly at: number; readonly room: Room }>
}
const newer = <A extends { readonly at: number }>(old: Option.Option<A>, next: A) =>
  Option.some(Option.match(old, { onNone: () => next, onSome: (prior) => either(next.at >= prior.at, next, prior) }))
const witness = (truth: Truth, reading: Reading): Truth => ({
  sample: newer(truth.sample, reading),
  volume: Option.match(Option.liftPredicate(reading.load.disk, (disk): disk is Room => disk !== "unread"), {
    onNone: () => truth.volume, onSome: (room) => newer(truth.volume, { at: reading.at, room }),
  }),
})
const within = (now: number, bound: number) => <A extends { readonly at: number }>(value: Option.Option<A>) =>
  Option.filter(value, ({ at }) => at <= now && now - at <= bound)

type Verdict = "short" | "room" | "unmeasured"
/** What the latest recorded reading says of the resources a lease takes. */
const VERDICT: Record<Path, (truth: Truth, now: number) => Verdict> = {
  capped: (truth, now) => Option.match(within(now, POLICY.readingMs)(truth.volume), { onNone: () => "unmeasured", onSome: ({ room }) => room }),
  measured: (truth, now) => {
    const sample = within(now, POLICY.freshnessMs)(truth.sample)
    const volume = within(now, POLICY.freshnessMs)(truth.volume)
    if (Option.isNone(sample) || Option.isNone(volume)) return "unmeasured"
    return either([sample.value.load.memory, sample.value.load.cpu, volume.value.room].includes("short"), "short", "room")
  },
}
const SLOTS: Record<Path, number> = { capped: POLICY.unattestedSlots, measured: POLICY.slots }

const held = (state: Lease["state"]) => state === "granted" || state === "running" || state === "draining"

/** One generated step: who calls, what it carries, and what it asks. */
interface Step {
  readonly caller: Caller
  readonly carried: Option.Option<Reading>
  readonly input: Input
  readonly cold: boolean
}
const loadOf = (next: () => number, path: Path, caller: Caller): Load => {
  const resource = () => either(path === "measured", pick(next, ["room", "room", "room", "short"] as const), "room")
  return { disk: either(caller === "timed-out", "unread", pick(next, ["room", "room", "short"] as const)), memory: resource(), cpu: resource() }
}
/** What a step asks, and whether it runs from cold() (no envelope). */
interface Asked {
  readonly input: Input
  readonly cold: boolean
}
const inputOf = (next: () => number, state: Admission, now: number, serial: () => number): Asked => {
  const rows = Object.values(state.leases)
  const of = (phases: ReadonlyArray<Lease["state"]>) => pickRow(next, rows.filter((row) => phases.includes(row.state)))
  const advance: Asked = { input: { op: "advance" }, cold: false }
  switch (pick(next, ["request", "request", "status", "advance", "claim", "claim", "drain"] as const)) {
    case "request": return { input: { op: "request", owner: "o", request: request(`r${serial()}`, now) }, cold: false }
    case "status": return Option.match(of(["queued"]), { onNone: () => advance, onSome: (row) => ({ input: { op: "status", id: row.id, owner: row.owner }, cold: false }) })
    case "claim": return Option.match(of(["granted"]), {
      onNone: () => advance,
      onSome: (row) => ({ input: { op: "claim", id: row.id, owner: row.owner, generation: row.generation, binding: `b${serial()}` }, cold: false }),
    })
    case "drain": return Option.match(of(["running", "draining"]), {
      onNone: () => advance,
      // A drain is recorded from cold(): no sample, no envelope.
      onSome: (row) => ({ input: { op: "drain", id: row.id, generation: row.generation, binding: Option.getOrElse(row.binding, () => ""), evidence: `e${serial()}` }, cold: true }),
    })
    case "advance": return advance
  }
}
const observationOf = (envelope: HostEnvelope, now: number, step: Step, serial: () => number): Observation => {
  if (step.cold) return { now }
  return Option.match(step.carried, {
    onNone: () => ({ now, envelope }),
    onSome: (reading) => ({ now, envelope, sample: sampleOf(envelope, reading.at, `s${serial()}`, reading.load) }),
  })
}

interface Checked {
  readonly path: Path
  readonly seed: number
  readonly step: number
  readonly now: number
  readonly verdict: Verdict
  readonly count: (key: string) => void
}
/** Safety: nothing onto a resource the latest reading shows short; the
 * measured path also takes nothing it has not freshly measured. */
const checkSafety = (before: Admission, after: Admission, { caller, input }: Step, at: Checked) => {
  for (const row of Object.values(after.leases)) {
    const prior = before.leases[row.id]?.state
    const admitted = (row.state === "granted" && prior !== "granted") || (row.state === "running" && prior !== "running")
    if (!admitted) continue
    at.count(`${at.path}:${row.state}:${at.verdict}:${caller}`)
    const where = { path: at.path, step: at.step, seed: at.seed, caller, op: input.op, verdict: at.verdict, lease: row.state }
    expect(where).not.toMatchObject({ verdict: "short" })
    if (at.path === "measured") expect(where).not.toMatchObject({ verdict: "unmeasured" })
  }
}
/** Liveness: with room (or, capped, nothing recent to say otherwise),
 * whoever stepped served the queue: none waits while a slot is free, and a
 * grant claimed within its launch window is approved. */
const checkLiveness = (before: Admission, after: Admission, { caller, input, cold }: Step, at: Checked) => {
  const servable = at.verdict === "room" || (at.path === "capped" && at.verdict === "unmeasured")
  if (cold || !servable) return
  const rows = Object.values(after.leases)
  const holding = rows.filter((row) => held(row.state)).length
  const where = { path: at.path, step: at.step, seed: at.seed, caller, op: input.op, verdict: at.verdict, holding }
  at.count(`${at.path}:served-by:${caller}`)
  if (rows.some((row) => row.state === "queued")) expect(where).toMatchObject({ holding: SLOTS[at.path] })
  if (input.op !== "claim") return
  const window = Option.flatMap(leaseOf(before, input.id), (row) => row.expiresBootMs)
  if (Option.exists(window, (until) => at.now < until)) expect({ ...where, claimed: phase(after, input.id).state }).toMatchObject({ claimed: "running" })
}

const interleave = (path: Path, envelope: HostEnvelope, seed: number, count: (key: string) => void) => {
  const next = random(seed)
  let state = initial("h", "b")
  let truth: Truth = { sample: Option.none(), volume: Option.none() }
  let now = 10_000
  let serial = 0
  const nextSerial = () => ++serial
  for (let index = 0; index < 80; index++) {
    now += pick(next, [50, 120, 300, 700, 2500, 2500, POLICY.readingMs + 1_000] as const)
    const caller = pick(next, ["sampler", "sampler", "loser", "loser", "loser", "slow", "timed-out"] as const satisfies ReadonlyArray<Caller>)
    const load = loadOf(next, path, caller)
    const at = now - either(caller === "slow", pick(next, [600, 1200, 1900] as const), pick(next, [0, 40, 200] as const))
    const asked = inputOf(next, state, now, nextSerial)
    const carried = Option.filter(Option.some({ at, load }), () => caller !== "loser" && !asked.cold)
    const step: Step = { caller, carried, ...asked }
    truth = Option.match(carried, { onNone: () => truth, onSome: (reading) => witness(truth, reading) })
    const before = state
    state = transition(state, step.input, observationOf(envelope, now, step, nextSerial)).state
    const checked = { path, seed, step: index, now, verdict: VERDICT[path](truth, now), count }
    checkSafety(before, state, step, checked)
    checkLiveness(before, state, step, checked)
  }
}

describe("one truth over generated interleavings", () => {
  it.effect("no grant or approval onto a resource the latest reading shows short; with room the queue is served whoever steps", () =>
    Effect.gen(function* () {
      const capped = yield* workbox
      const seen = new Map<string, number>()
      const count = (key: string) => seen.set(key, (seen.get(key) ?? 0) + 1)
      for (let seed = 1; seed <= 250; seed++) {
        interleave("capped", capped, 20261127 + seed, count)
        interleave("measured", mac, 30261127 + seed, count)
      }
      // The run reached each case that matters: grants and approvals by a
      // caller with no sample, on both paths; the capped path admitting an
      // unmeasured (aged-out) volume; the queue served by a non-sampler.
      for (const key of ["capped:granted:room:loser", "capped:running:room:loser", "capped:granted:unmeasured:loser",
        "measured:granted:room:loser", "measured:running:room:loser", "capped:served-by:loser", "measured:served-by:loser",
        "capped:granted:room:timed-out", "measured:granted:room:slow"])
        expect({ key, seen: (seen.get(key) ?? 0) > 0 }).toEqual({ key, seen: true })
    }))
})
