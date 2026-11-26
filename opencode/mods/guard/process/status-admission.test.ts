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
import { Effect, Option, Result } from "effect"
import { expect, it } from "effect-bun-test"
import { hostOffer, initial, type Observation, transition } from "../admission.ts"
import { type Request, widthOf } from "../admission-wire.ts"
import { type Attestation, CHECK_PROFILE, hostEnvelope, type Measurements, measureSupply, POLICY } from "../host-supply.ts"
import { CORE_KEYS, linuxEnvelope } from "./admission.ts"
import { run, WORKBOX, withFiles } from "./cgroup-fixture.ts"
import { dfFreeInodes, volumeReading } from "./readings.ts"

const GiB = 2 ** 30
const PURPOSES = ["check", "land-check", "vm", "inventory", "exclusive-check"] as const
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
    Option.none(), Option.some({ controller: "enforced", io: "unavailable" }), Option.some({ controller: "enforced", io: "weighted" }),
    Option.some({ controller: "unattested", io: "unavailable", file: "agentwork.slice", why: "generated" }),
    Option.some({ controller: "unattested", io: "weighted", file: "agentwork.slice", why: "generated" }),
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
      // From an empty volume through one under its floor, at it, and above.
      volumes: { [VOLUME]: { capacityBytes: pickFrom(next, [0, GiB, POLICY.diskFloorBytes - 1, POLICY.diskFloorBytes,
        POLICY.diskFloorBytes + upTo(next, 100) * GiB] as const), diskFloorBytes: POLICY.diskFloorBytes } },
    },
    Option.match(contained, { onNone: () => ({}), onSome: (containedCpuMilli) => ({ containedCpuMilli }) }),
    Option.match(containedMemory, { onNone: () => ({}), onSome: (containedMemoryBytes) => ({ containedMemoryBytes }) }),
    Option.match(attestation, { onNone: () => ({}), onSome: (found) => ({ attestation: found }) }),
  )
  const envelope = hostEnvelope(raw)
  const now = 10_000
  const kind = pickFrom(next, ["no-envelope", "envelope", "sample", "sample", "stale", "no-volume"] as const)
  if (kind === "no-envelope") return { now }
  if (kind === "envelope") return { now, envelope }
  // The volume as the Linux readings give it, by filesystem kind: btrfs
  // (dynamic inodes, its own metadata budget), ext4 and an unknown kind
  // (df's inode count, metadata as free space); free space and metadata
  // from none at all.
  const capacityBytes = raw.volumes[VOLUME].capacityBytes
  const freeBytes = Math.min(capacityBytes, pickFrom(next, [0, POLICY.diskFloorBytes, upTo(next, 50) * GiB] as const))
  const fsKind = pickFrom(next, ["btrfs", "ext2/ext3", "zz-unknown"] as const)
  const metadata = pickFrom(next, [0, upTo(next, 4) * GiB] as const)
  const volume = volumeReading({
    fsKind, capacityBytes, freeBytes, diskFloorBytes: POLICY.diskFloorBytes,
    inodes: dfFreeInodes(`Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/x 9 0 ${pickFrom(next, [0, 10, 900_000] as const)} 0% /x`, "df -ki /x"),
    btrfsUsage: Option.some({ text: `Metadata,DUP: Size:${metadata + GiB}, Used:${GiB} (50.00%)`, command: "btrfs filesystem usage -b /x" }),
  })
  const sampled = { [VOLUME]: Result.getOrThrow(volume) }
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
      volumeReservations: [{ volumeId: Option.getOrElse(offer.defaultVolume, () => VOLUME),
        bytes: pickFrom(next, [0, Math.min(1, offer.maximumDiskBytes), upTo(next, offer.maximumDiskBytes), offer.maximumDiskBytes] as const) }],
    },
  }
}

describe("status and admission agree", () => {
  it.effect("on 4000 generated hosts, an offered class asked within the offer is queued or granted; one not offered is refused with the reason status gives", () =>
    Effect.sync(() => {
      const next = random(20261126)
      const disagree: Array<{ readonly host: number; readonly purpose: string; readonly offered: string; readonly reply: string }> = []
      const seen = new Set<string>()
      let asked = 0
      for (let host = 0; host < 4000; host++) {
        const observation = generatedHost(next)
        const offer = hostOffer(observation, Option.some(VOLUME))
        for (const purpose of PURPOSES) {
          asked++
          const request = requestWithin(next, offer, purpose, observation.now, asked)
          const { reply } = transition(initial("host", "boot"), { op: "request", owner: "owner", request }, observation)
          const offered = Option.match(Option.fromNullishOr(offer.withheld[purpose]), { onNone: () => "offered", onSome: (why) => `refused ${why}` })
          const got = Option.match(Option.liftPredicate(reply.state, (state) => state === "refused"), {
            onNone: () => "offered", onSome: () => `refused ${reply.reason}` })
          seen.add(`${offered.split(" ")[0]}:${["none", "bytes"][Number((request.demand.volumeReservations[0]?.bytes ?? 0) > 0)]}`)
          seen.add(offered)
          if (offered !== got) disagree.push({ host, purpose, offered, reply: `${reply.state} ${reply.reason}` })
        }
      }
      expect(disagree.slice(0, 5)).toEqual([])
      // The generator reached every branch the law speaks of.
      expect([...seen].sort()).toEqual(expect.arrayContaining([
        "offered", "offered:bytes", "offered:none", "refused disk-limit", "refused unavailable", "refused unknown-key", "refused unsupported-class",
      ]))
    }))

  it.effect("on the workbox's tree, from any caller's place and any volume size, status and admission agree", () =>
    Effect.gen(function* () {
      const places = [
        "0::/user.slice/user-1000.slice/session-11124.scope\n",
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u7.service\n",
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1.scope\n",
      ] as const
      const next = random(7)
      const disagree: Array<string> = []
      for (const place of places) {
        const envelope = yield* run(withFiles(WORKBOX, { "/fixture/proc/self/cgroup": place }), linuxEnvelope)
        for (let round = 0; round < 50; round++) {
          const observation = { now: 0, envelope: { ...envelope, volumes: { [VOLUME]: pickFrom(next, [-1, 0, GiB, 100 * GiB] as const) } } }
          const offer = hostOffer(observation, Option.some(VOLUME))
          for (const purpose of PURPOSES) {
            const request = requestWithin(next, offer, purpose, 0, round)
            const { reply } = transition(initial("host", "boot"), { op: "request", owner: "owner", request }, observation)
            const expected = Option.getOrElse(Option.fromNullishOr(offer.withheld[purpose]), () => "offered")
            const got = Option.match(Option.liftPredicate(reply.state, (state) => state === "refused"), {
              onNone: () => "offered", onSome: () => reply.reason })
            if (expected !== got) disagree.push(`${place.trim()} ${purpose}: status ${expected}, admission ${reply.state} ${reply.reason}`)
          }
        }
      }
      expect(disagree.slice(0, 5)).toEqual([])
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
