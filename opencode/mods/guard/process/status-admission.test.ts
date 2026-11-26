// @reads all
// @reads-reason computed read at mods/guard/process/admission.ts: textOf's fs.readFileString(file), served here by cgroup-fixture.ts's in-memory FileSystem, never the disk
// Status and admission are one decision: whatever `host status --json`
// offers (hostOffer: its classes, maximumCpuMilli, maximumMemoryBytes,
// resourceKeys and defaultVolume), a request asked within it is queued or
// granted, never refused. Checked over generated hosts (Linux and the Mac;
// attested, unattested and controllerless; with and without a fresh sample,
// under pressure, with the volume's sample missing) and on the workbox's
// own tree.
import { describe } from "bun:test"
import { Effect, Option } from "effect"
import { expect, it } from "effect-bun-test"
import { hostOffer, initial, type Observation, transition } from "../admission.ts"
import { type Request, widthOf } from "../admission-wire.ts"
import { type Attestation, CHECK_PROFILE, hostEnvelope, type Measurements, measureSupply, POLICY } from "../host-supply.ts"
import { CORE_KEYS, linuxEnvelope } from "./admission.ts"
import { run, WORKBOX } from "./cgroup-fixture.ts"

const GiB = 2 ** 30
const VOLUME = "volume-a"
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
const pickFrom = <A>(next: () => number, items: readonly [A, ...ReadonlyArray<A>]): A =>
  items[Math.floor(next() * items.length)] ?? items[0]
const upTo = (next: () => number, maximum: number) => Math.floor(next() * (maximum + 1))

/** One generated host and what it observes at `now`. */
const generatedHost = (next: () => number): Observation => {
  const platform = pickFrom(next, ["linux", "darwin"] as const)
  const attestations: readonly [Option.Option<Attestation>, ...ReadonlyArray<Option.Option<Attestation>>] = [
    Option.none(), Option.some({ controller: "enforced", io: "unavailable" }),
    Option.some({ controller: "unattested", io: "unavailable", file: "agentwork.slice", why: "generated" }),
  ]
  const attestation = Option.flatMap(Option.liftPredicate(platform, (p) => p === "linux"), () => pickFrom(next, attestations))
  const effectiveCpuMilli = pickFrom(next, [1000, 2000, 2500, 4000, 16_000] as const)
  const contained = pickFrom(next, [Option.none(), ...[0, 500, 1000, 3000, 8000].map(Option.some)] as const)
  const totalMemoryBytes = pickFrom(next, [GiB / 2, GiB, 3 * GiB, 8 * GiB, 64 * GiB] as const)
  const containedMemory = pickFrom(next, [Option.none(), ...[0, 2 * GiB, 6 * GiB, 52 * GiB].map(Option.some)] as const)
  const keys = CORE_KEYS.filter(() => next() < 0.8)
  const raw = Object.assign(
    {
      platform, effectiveCpuMilli, totalMemoryBytes, controllerAvailable: next() < 0.8, keys,
      volumes: { [VOLUME]: { capacityBytes: POLICY.diskFloorBytes + upTo(next, 100) * GiB, diskFloorBytes: POLICY.diskFloorBytes } },
    },
    Option.match(contained, { onNone: () => ({}), onSome: (containedCpuMilli) => ({ containedCpuMilli }) }),
    Option.match(containedMemory, { onNone: () => ({}), onSome: (containedMemoryBytes) => ({ containedMemoryBytes }) }),
    Option.match(attestation, { onNone: () => ({}), onSome: (found) => ({ attestation: found }) }),
  )
  const envelope = hostEnvelope(raw)
  const now = 10_000
  const kind = pickFrom(next, ["envelope", "sample", "stale", "no-volume"] as const)
  if (kind === "envelope") return { now, envelope }
  const sampled = {
    [VOLUME]: {
      capacityBytes: raw.volumes[VOLUME].capacityBytes, freeBytes: upTo(next, 50) * GiB, freeInodes: "dynamic" as const,
      metadataFreeBytes: upTo(next, 4) * GiB, diskFloorBytes: POLICY.diskFloorBytes,
    },
  }
  const measurements: Measurements = {
    ...raw, id: "sample", hostCpuMilli: effectiveCpuMilli,
    before: { idle: 0, total: 0, at: now - 1000 }, after: { idle: upTo(next, 1000), total: 1000, at: now - 500 },
    runnable: upTo(next, 40), memoryBytes: upTo(next, totalMemoryBytes), pressure: pickFrom(next, ["clear", "degraded", "hold"] as const),
    qualified: next() < 0.8, managed: [], protectedLowerBoundMilli: 0,
    volumes: Option.match(Option.liftPredicate(kind, (k) => k === "no-volume"), { onNone: () => sampled, onSome: () => ({}) }),
  }
  const sample = measureSupply(measurements, envelope)
  if (Option.isNone(sample)) return { now, envelope }
  const at = now + POLICY.freshnessMs * 2 * Number(kind === "stale")
  return { now: at, envelope, sample: sample.value }
}

/** A request a client builds from the offer alone, as `check run` does:
 * the class's profile, a width, memory and keys within what status says. */
const requestWithin = (next: () => number, offer: ReturnType<typeof hostOffer>, purpose: Request["purpose"], now: number, i: number): Request => {
  const cores = Math.max(1, Math.floor(offer.maximumCpuMilli / 1000))
  const width = pickFrom(next, ["unknown", "full", ...[1, 2, cores].map((n) => Option.getOrElse(widthOf(n), () => "unknown" as const))] as const)
  return {
    version: 1, requestId: `request-${i}`, principal: { kind: "external-runner", scopeId: "peer", epoch: 1 },
    purpose, tier: "standard", deadlineBootMs: now + POLICY.queueMs - 1,
    demand: {
      width, cpuMilli: CHECK_PROFILE[purpose].cpuMilli, ioClass: "idle",
      memoryBytes: Math.max(Number(offer.maximumMemoryBytes > 0), upTo(next, offer.maximumMemoryBytes)),
      keys: offer.resourceKeys.filter(() => next() < 0.3),
      volumeReservations: [{ volumeId: Option.getOrElse(offer.defaultVolume, () => VOLUME), bytes: 0 }],
    },
  }
}

describe("status and admission agree", () => {
  it.effect("on 2000 generated hosts, every offered class asked within the offer is queued or granted", () =>
    Effect.sync(() => {
      const next = random(20261126)
      const refused: Array<{ readonly host: number; readonly purpose: string; readonly reason: string }> = []
      let asked = 0
      for (let host = 0; host < 2000; host++) {
        const observation = generatedHost(next)
        const offer = hostOffer(observation, Option.some(VOLUME))
        for (const purpose of offer.offeredClasses) {
          asked++
          const request = requestWithin(next, offer, purpose, observation.now, asked)
          const { reply } = transition(initial("host", "boot"), { op: "request", owner: "owner", request }, observation)
          if (reply.state === "refused") refused.push({ host, purpose, reason: reply.reason })
        }
      }
      expect(refused).toEqual([])
      expect(asked).toBeGreaterThan(2000)
    }))

  it.effect("the workbox's own tree offers every class, and a check of each is granted", () =>
    Effect.gen(function* () {
      const envelope = { ...(yield* run(WORKBOX, linuxEnvelope)), volumes: { [VOLUME]: 100 * GiB } }
      const observation = { now: 0, envelope }
      const offer = hostOffer(observation, Option.some(VOLUME))
      expect(offer.offeredClasses).toEqual(["check", "land-check", "vm", "inventory", "exclusive-check"])
      for (const purpose of offer.offeredClasses) {
        const request = requestWithin(random(1), offer, purpose, 0, 1)
        const { reply } = transition(initial("host", "boot"), { op: "request", owner: "owner", request }, observation)
        expect({ purpose, state: reply.state }).toEqual({ purpose, state: "granted" })
      }
    }))
})
