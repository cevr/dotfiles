// @reads all
// @reads-reason computed read at mods/guard/process/admission.ts: textOf's fs.readFileString(file), served here by cgroup-fixture.ts's in-memory FileSystem, never the disk
// The laws of admission on Linux cgroup trees (fixtures in cgroup-fixture.ts):
// - on any generated tree, admission never refuses for a missing capability;
// - an unattested host admits under the fixed cap: never more than
//   POLICY.unattestedSlots held leases, strict FIFO (none starves), and a
//   dead holder's lease is reclaimed;
// - a host that attests is never downgraded.
import { describe } from "bun:test"
import { Effect, Option } from "effect"
import { expect, it } from "effect-bun-test"
import { type Admission, initial, type Input, type Lease, transition } from "../admission.ts"
import { type Request, widthOf } from "../admission-wire.ts"
import { type HostEnvelope, POLICY } from "../host-supply.ts"
import { linuxBudget, linuxEnvelope } from "./admission.ts"
import { PROVISIONED, run, type Tree, WORKBOX, withoutFiles } from "./cgroup-fixture.ts"

const GiB = 2 ** 30
/** A seeded generator (mulberry32): each run replays its seed. */
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
const pick = <A>(next: () => number, items: ReadonlyArray<A>): Option.Option<A> =>
  Option.fromNullishOr(items[Math.floor(next() * items.length)])
const either = <A>(chance: boolean, yes: A, no: A) => [no, yes][Number(chance)] ?? no

const withVolume = (envelope: HostEnvelope): HostEnvelope => ({ ...envelope, volumes: { "volume-a": 100 * GiB } })
const request = (id: string, now: number, cpuMilli: number, purpose: Request["purpose"] = "check"): Request => ({
  version: 1, requestId: id, principal: { kind: "external-runner", scopeId: id, epoch: 1 },
  purpose, tier: "standard", deadlineBootMs: now + POLICY.queueMs - 1,
  demand: { width: Option.getOrElse(widthOf(Math.ceil(cpuMilli / 1000)), () => "unknown" as const), cpuMilli, memoryBytes: 4 * GiB, ioClass: "idle", keys: [],
    volumeReservations: [{ volumeId: "volume-a", bytes: 0 }] },
})
const held = (state: Admission) => Object.values(state.leases).filter((row) =>
  row.state === "granted" || row.state === "running" || row.state === "draining")
const ended = (state: Admission) => Object.values(state.leases).every((row) => row.state === "released" || row.state === "expired")

/** Which of a tree's files its attestation rests on, each found by removing it alone. */
const requiredOf = (tree: Tree) => Effect.gen(function* () {
  const required = new Set<string>()
  for (const file of Object.keys(tree.files)) {
    const { attestation } = yield* run(withoutFiles(tree, new Set([file])), linuxBudget)
    if (attestation.controller === "unattested") required.add(file)
  }
  return required
})

describe("on any generated cgroup tree", () => {
  it.effect("a missing capability never refuses; the host is attested exactly when nothing required is missing", () =>
    Effect.gen(function* () {
      const files = Object.keys(PROVISIONED.files)
      const required = yield* requiredOf(PROVISIONED)
      expect(required.size).toBeGreaterThan(10)
      const next = random(20261125)
      for (let round = 0; round < 200; round++) {
        const gone = new Set(files.filter(() => next() < 0.15))
        const lostSlice = next() < 0.1
        const tree: Tree = { ...withoutFiles(PROVISIONED, gone), slices: either(lostSlice, {}, PROVISIONED.slices) }
        const { attestation } = yield* run(tree, linuxBudget)
        const missing = [...gone].filter((file) => required.has(file))
        if (missing.length === 0 && !lostSlice) expect(attestation).toEqual({ controller: "enforced", io: "unavailable" })
        else expect(attestation.controller).toBe("unattested")
        if (attestation.controller === "unattested" && !lostSlice) expect(missing).toContain(attestation.file)
        const envelope = withVolume(yield* run(tree, linuxEnvelope))
        expect(envelope.cpuMilli).toBeGreaterThan(0)
        const { reply } = transition(initial("host", "boot"), { op: "request", owner: "owner", request: request("one", 0, 1000) }, { now: 0, envelope })
        expect(reply.state).not.toBe("refused")
        if (attestation.controller === "unattested") expect(reply.state).toBe("granted")
      }
    }))

  it.effect("a host that attests is never downgraded by anything outside its requirements", () =>
    Effect.gen(function* () {
      const next = random(7)
      const choose = (items: ReadonlyArray<string>) => Option.getOrElse(pick(next, items), () => "")
      for (let round = 0; round < 50; round++) {
        const extra = Object.fromEntries(Array.from({ length: 1 + Math.floor(next() * 8) }, (_, i) => [
          `/fixture/sys/fs/cgroup/${choose(["system.slice", "user.slice", "init.scope"])}/decoy-${round}-${i}.scope/${choose(["cpu.max", "memory.max", "cpuset.cpus.effective", "io.max"])}`,
          choose(["max\n", "100000 100000\n", "0-3\n", ""]),
        ]))
        const tree: Tree = { slices: PROVISIONED.slices, files: { ...PROVISIONED.files, ...extra } }
        expect((yield* run(tree, linuxBudget)).attestation).toEqual({ controller: "enforced", io: "unavailable" })
        expect((yield* run(tree, linuxEnvelope)).cpuMilli).toBe(12_000)
      }
    }))
})

/** One random schedule on the fixed cap: requests arrive, holders claim,
 * finish, die or let their grant lapse, every step checked against the cap
 * and FIFO order; then no more arrive and every holder ends. */
const schedule = (envelope: HostEnvelope, seed: number) => {
  const next = random(seed)
  let state = initial("host", "boot")
  let now = 0
  let made = 0
  let peak = 0
  const step = (input: Input) => {
    now += 50 + Math.floor(next() * 400)
    const outcome = transition(state, input, { now, envelope })
    state = outcome.state
    const holding = held(state)
    peak = Math.max(peak, holding.length)
    expect(holding.length).toBeLessThanOrEqual(POLICY.unattestedSlots)
    if (holding.some((row) => row.request.purpose === "exclusive-check")) expect(holding.length).toBe(1)
    for (const row of outcome.changes.filter((change) => change.state === "granted"))
      expect(Object.values(state.leases).filter((other) => other.ticket < row.ticket && other.state === "queued")).toEqual([])
  }
  const bindingOf = (row: Lease) => Option.getOrElse(row.binding, () => "")
  // A granted lease is claimed, or its launcher dies before claiming and the grant lapses.
  const granted = (row: Lease) => {
    if (next() < 0.8) return step({ op: "claim", id: row.id, owner: row.owner, generation: row.generation, binding: `bind-${row.id}-${row.generation}` })
    now += POLICY.launchMs
    return step({ op: "advance" })
  }
  // A running lease finishes, or its owner dies: observed gone, then its scope drained.
  const running = (row: Lease) => {
    if (next() < 0.7) return step({ op: "drain", id: row.id, generation: row.generation, binding: bindingOf(row), evidence: "done" })
    return step({ op: "observe", id: row.id, owner: row.owner, generation: row.generation, liveness: "gone", evidence: "dead" })
  }
  const actions = {
    granted, running,
    draining: (row: Lease) => step({ op: "drain", id: row.id, generation: row.generation, binding: bindingOf(row), evidence: "drained" }),
  } as const
  const act = (found: Option.Option<Lease>) => Option.match(found, {
    onNone: () => step({ op: "advance" }),
    onSome: (row) => {
      if (row.state === "granted" || row.state === "running" || row.state === "draining") actions[row.state](row)
    },
  })
  for (let i = 0; i < 300; i++) {
    if (made < 60 && next() < 0.4) {
      const purpose = either<Request["purpose"]>(next() < 0.1, "exclusive-check", "check")
      step({ op: "request", owner: `owner-${made}`, request: request(`r${made}`, now, 1000 * (1 + Math.floor(next() * 4)), purpose) })
      made += 1
    } else act(pick(next, held(state)))
  }
  for (let i = 0; i < 2000 && !ended(state); i++) act(Option.fromNullishOr(held(state)[0]))
  return { state, made, peak }
}

describe("the fixed cap on an unattested host", () => {
  it.effect("the workbox's tree admits three heavy leases at once and queues the rest in FIFO order", () =>
    Effect.gen(function* () {
      const envelope = withVolume(yield* run(WORKBOX, linuxEnvelope))
      let state = initial("host", "boot")
      const replies = Array.from({ length: 5 }, (_, i) => {
        const next = transition(state, { op: "request", owner: `owner-${i}`, request: request(`r${i}`, 0, 1000) }, { now: 0, envelope })
        state = next.state
        return next.reply.state
      })
      expect(replies).toEqual(["granted", "granted", "granted", "queued", "queued"])
      expect(Object.values(state.leases).map((row) => row.reason)).toEqual(["granted", "granted", "granted", "capacity", "fifo"])
    }))

  it.effect("random schedules: never four held, grants in ticket order, dead holders reclaimed, every request served", () =>
    Effect.gen(function* () {
      const envelope = withVolume(yield* run(WORKBOX, linuxEnvelope))
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const { state, made, peak } = schedule(envelope, seed)
        // No starvation: every request ran and drained, or its grant lapsed unclaimed; none timed out queued.
        expect(ended(state)).toBe(true)
        expect(Object.values(state.leases).map((row) => row.reason).filter((reason) => reason !== "scope-drained" && reason !== "expired-grant")).toEqual([])
        expect(Object.keys(state.leases).length).toBe(made)
        expect(peak).toBe(POLICY.unattestedSlots)
      }
    }))
})
