// @reads all
// @reads-reason computed read at mods/guard/process/admission.ts: textOf's fs.readFileString(file), served here by cgroup-fixture.ts's in-memory FileSystem, never the disk
// The review's probes (wb-admit2-findings-r1.md, B1 and B2) as laws:
// - one disk rule on both paths: with the volume in a fresh reading, a
//   request waits `disk` while free space or metadata is under what the
//   measured path requires; never granted into a full volume;
// - a volume under the disk floor is offered nothing, and a request on it
//   is refused with the reason status gives;
// - the caller's place (login session, user manager, transient scope)
//   never changes the envelope status and admission read.
import { describe } from "bun:test"
import { Effect, Option } from "effect"
import { expect, it } from "effect-bun-test"
import { hostOffer, initial, type Observation, transition } from "../admission.ts"
import { type Request } from "../admission-wire.ts"
import { type HostEnvelope, hostEnvelope, type Measurements, measureSupply, POLICY } from "../host-supply.ts"
import { CORE_KEYS, linuxEnvelope } from "./admission.ts"
import { run, USER, WORKBOX, withFiles } from "./cgroup-fixture.ts"

const GiB = 2 ** 30
const request = (bytes = 0): Request => ({
  version: 1, requestId: "r", principal: { kind: "external-runner", scopeId: "p", epoch: 1 },
  purpose: "check", tier: "standard", deadlineBootMs: POLICY.queueMs - 1 + 10_000,
  demand: { width: "unknown", cpuMilli: 1000, memoryBytes: GiB, ioClass: "idle", keys: [], volumeReservations: [{ volumeId: "v", bytes }] },
})
const observed = (envelope: HostEnvelope, freeBytes: number, metadataFreeBytes: number, capacityBytes = 106 * GiB): Observation => {
  const measurements: Measurements = {
    platform: "linux", effectiveCpuMilli: 16000, totalMemoryBytes: 64 * GiB, controllerAvailable: true, keys: CORE_KEYS,
    id: "s", hostCpuMilli: 16000, before: { idle: 0, total: 0, at: 9000 }, after: { idle: 900, total: 1000, at: 9500 },
    runnable: 1, memoryBytes: 50 * GiB, pressure: "clear", qualified: true, managed: [], protectedLowerBoundMilli: 0,
    volumes: { v: { capacityBytes, freeBytes, freeInodes: "dynamic", metadataFreeBytes, diskFloorBytes: POLICY.diskFloorBytes } },
  }
  return { now: 10_000, envelope, sample: Option.getOrThrow(measureSupply(measurements, envelope)) }
}
const unattestedWorkbox = Effect.map(run(WORKBOX, linuxEnvelope), (envelope) => ({ ...envelope, volumes: { v: 100 * GiB } }))
const measuredHost = hostEnvelope({ platform: "linux", effectiveCpuMilli: 16000, totalMemoryBytes: 64 * GiB, controllerAvailable: true,
  keys: CORE_KEYS, volumes: { v: { capacityBytes: 106 * GiB, diskFloorBytes: POLICY.diskFloorBytes } } })
const decide = (observation: Observation, bytes = 0) =>
  transition(initial("h", "b"), { op: "request", owner: "o", request: request(bytes) }, observation).reply

describe("one disk rule on both paths", () => {
  it.effect("a full volume (no free bytes, no free metadata) in a fresh reading waits `disk` on the capped path as on the measured one", () =>
    Effect.gen(function* () {
      const capped = decide(observed(yield* unattestedWorkbox, 0, 0))
      const sampled = decide(observed(measuredHost, 0, 0))
      expect({ state: capped.state, reason: capped.reason }).toEqual({ state: "queued", reason: "disk" })
      expect({ state: sampled.state, reason: sampled.reason }).toEqual({ state: "queued", reason: "disk" })
    }))

  it.effect("free data space with no metadata headroom waits too; room on both grants", () =>
    Effect.gen(function* () {
      const envelope = yield* unattestedWorkbox
      expect(decide(observed(envelope, 50 * GiB, 0)).reason).toBe("disk")
      expect(decide(observed(envelope, 50 * GiB, GiB)).state).toBe("granted")
    }))
})

describe("a volume under the disk floor", () => {
  it.effect("is offered nothing, and a request on it is refused with the reason status gives", () =>
    Effect.gen(function* () {
      const envelope = { ...(yield* run(WORKBOX, linuxEnvelope)), volumes: { v: 4 * GiB - POLICY.diskFloorBytes } }
      const offer = hostOffer({ now: 0, envelope }, Option.some("v"))
      const reply = decide({ now: 10_000, envelope })
      expect(offer.offeredClasses).toEqual([])
      expect(offer.maximumDiskBytes).toBe(0)
      expect({ state: reply.state, reason: String(reply.reason) }).toEqual({ state: "refused", reason: String(offer.withheld.check) })
      expect(offer.withheld.check).toBe("disk-limit")
    }))
})

describe("the disk rule over generated readings", () => {
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
  it.effect("both paths decide alike from a reading: full waits `disk`, room grants; no reading admits capped and waits measured", () =>
    Effect.gen(function* () {
      const capped = yield* unattestedWorkbox
      const next = random(20261126)
      const seen = new Set<string>()
      for (let round = 0; round < 2000; round++) {
        const freeBytes = pick(next, [0, 1, POLICY.diskFloorBytes - 1, POLICY.diskFloorBytes, POLICY.diskFloorBytes + GiB, 90 * GiB] as const)
        const metadataFreeBytes = pick(next, [0, POLICY.minMetadataBytes - 1, POLICY.minMetadataBytes, 4 * GiB] as const)
        const bytes = pick(next, [0, 1, GiB, 50 * GiB] as const)
        const read = pick(next, ["reading", "no-volume", "stale", "aged", "no-sample"] as const)
        const forBoth = (envelope: HostEnvelope): Observation => {
          const full = observed(envelope, freeBytes, metadataFreeBytes)
          if (read === "no-sample") return { now: full.now, envelope }
          if (read === "stale") return { ...full, now: full.now + POLICY.freshnessMs * 2 }
          if (read === "aged") return { ...full, now: full.now + POLICY.readingMs + 1 }
          if (read === "no-volume" && full.sample) return { ...full, sample: { ...full.sample, volumes: {} } }
          return full
        }
        const room = freeBytes - POLICY.diskFloorBytes >= bytes && metadataFreeBytes >= POLICY.minMetadataBytes
        const fixed = decide(forBoth(capped), bytes)
        const sampled = decide(forBoth(measuredHost), bytes)
        seen.add(`${read}:${room}`)
        const byRoom = pick(() => Number(room) / 2, ["disk", "granted"] as const)
        const expected = {
          reading: { capped: byRoom, measured: byRoom },
          // No reading of the volume: the capped path admits under its cap
          // (status says unsampled/unmeasured); the measured path waits.
          "no-volume": { capped: "granted", measured: "disk" },
          // Past freshness the measured path waits; the capped path holds to
          // the host's last reading until `readingMs`, then (aged) the
          // volume is unmeasured and admits (wb-admit2-findings-r2.md, B3).
          stale: { capped: byRoom, measured: "stale-sample" },
          aged: { capped: "granted", measured: "stale-sample" },
          "no-sample": { capped: "granted", measured: "unavailable" },
        }[read]
        expect({ read, room, bytes, freeBytes, metadataFreeBytes, capped: String(fixed.reason), measured: String(sampled.reason) })
          .toEqual({ read, room, bytes, freeBytes, metadataFreeBytes, ...expected })
        expect([fixed.state, sampled.state].includes("refused")).toBe(false)
      }
      expect(seen.size).toBe(10)
    }))
})

describe("the caller's place", () => {
  // A transient scope with its own limits (the guard's heavy launcher sets
  // MemoryMax=12G) inside the user's slice, beside a login session.
  const transient = `${USER}/app.slice/run-r1.scope`
  const places = {
    session: "0::/user.slice/user-1000.slice/session-1.scope\n",
    manager: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u7.service\n",
    transient: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1.scope\n",
  }
  it.effect("a login session, a user-manager service and a transient scope read one envelope", () =>
    Effect.gen(function* () {
      const tree = withFiles(WORKBOX, { [`${transient}/memory.max`]: `${12 * GiB}\n`, [`${transient}/cpu.max`]: "200000 100000\n" })
      const envelopes = []
      for (const cgroup of Object.values(places)) envelopes.push(yield* run(withFiles(tree, { "/fixture/proc/self/cgroup": cgroup }), linuxEnvelope))
      expect(envelopes[1]).toEqual(envelopes[0])
      expect(envelopes[2]).toEqual(envelopes[0])
    }))
})
