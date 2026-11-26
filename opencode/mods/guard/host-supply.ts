import { Option, Predicate } from "effect"
import type { Purpose } from "./admission-wire.ts"

/** Boot-local monotonic measurements. A poll is one coherent host interval,
 * not a minute-old load average and not the count of slots we granted. */
export interface Ticks {
  readonly total: number
  readonly idle: number
  readonly at: number
}

export interface ManagedUse {
  readonly binding: string
  readonly measuredCpuMilli: number
  readonly enforcedCpuMilli: number
}

export interface Volume {
  readonly capacityBytes: number
  readonly freeBytes: number
  readonly freeInodes: number | "dynamic"
  readonly metadataFreeBytes: number
  readonly diskFloorBytes: number
}

/** What a Linux host's cgroup tree proves. `enforced`: the workload slice
 * and its protected siblings carry every required limit. `unattested`: one
 * of them is missing, named by `file` and `why`; heavy commands then run
 * under the fixed concurrency cap (`POLICY.unattestedSlots`) in the guard's
 * nice + user scope launcher. `io` says whether this kernel weighs IO
 * (any cgroup has `io.weight`); without it admission rests on CPU and memory. */
export type Attestation =
  | { readonly controller: "enforced"; readonly io: "weighted" | "unavailable" }
  | { readonly controller: "unattested"; readonly io: "weighted" | "unavailable"; readonly file: string; readonly why: string }

/** A quiet-host witness, independent of ticks, PSI and free memory/disk.
 * These are ceilings of the currently attested configuration, not claims.
 * No `attestation` (the Mac, and every enforced host before it was read)
 * is the measured, attested path. */
export interface HostEnvelope {
  readonly cpuMilli: number
  readonly memoryBytes: number
  readonly containedMemoryBytes?: number
  readonly needsMemoryReservation: boolean
  readonly volumes: Readonly<Record<string, number>>
  readonly keys: ReadonlyArray<string>
  readonly purposes: ReadonlyArray<Purpose>
  readonly attestation?: Attestation
}

export const unattested = (envelope?: HostEnvelope) => envelope?.attestation?.controller === "unattested"

export interface Supply {
  readonly id: string
  readonly at: number
  readonly effectiveCpuMilli: number
  readonly containedCpuMilli?: number
  readonly outsideNoncriticalMilli: number
  readonly protectedCpuMilli: number
  readonly memoryBytes: number
  readonly pressure: "clear" | "degraded" | "hold"
  readonly qualification: "enforced" | "advisory" | "unattested" | "unqualified"
  readonly runnable: number
  readonly managed: ReadonlyArray<ManagedUse>
  readonly volumes: Readonly<Record<string, Volume>>
  readonly keys: ReadonlyArray<string>
  readonly envelope: HostEnvelope
  readonly interval?: { readonly before: Ticks; readonly after: Ticks }
}

export interface Measurements {
  readonly id: string
  readonly platform: "darwin" | "linux"
  readonly before: Ticks
  readonly after: Ticks
  readonly effectiveCpuMilli: number
  readonly containedCpuMilli?: number
  readonly hostCpuMilli: number
  readonly runnable: number
  readonly memoryBytes: number
  readonly totalMemoryBytes: number
  readonly containedMemoryBytes?: number
  readonly controllerAvailable: boolean
  readonly pressure: Supply["pressure"]
  readonly qualified: boolean
  readonly managed: ReadonlyArray<ManagedUse>
  readonly protectedLowerBoundMilli: number
  readonly volumes: Supply["volumes"]
  readonly keys: Supply["keys"]
  readonly attestation?: Attestation
}

export const POLICY = {
  diskFloorBytes: 6 * 2 ** 30,
  minFreeInodes: 1024,
  minMetadataBytes: 64 * 2 ** 20,
  reserveCpuMilli: 2000,
  reserveMemoryBytes: 2 ** 30,
  freshnessMs: 2000,
  // How long the host's last reading of a volume binds the capped
  // (unattested) path. A reading that shows a volume short stops new leases
  // on it until a newer reading shows room or this bound passes; only then,
  // with no recent reading anywhere on the host, is the volume unmeasured
  // and admitted under the cap. A failed or timed-out read is no new fact.
  // Waiters re-sample about every 500 ms, so a freed volume shows room
  // within a sample of any successful read.
  readingMs: 60_000,
  queueMs: 60 * 60_000,
  launchMs: 5000,
  supervisionMs: 15_000,
  maxRunningMs: 6 * 60 * 60_000,
  runnableLimit: 24,
  slots: 3,
  landBurst: 2,
  maxRequestCpuMilli: 4000,
  // Below half the managed pool, unmanaged work is already keeping the host
  // busy; starting a whole-host check would only add contention.
  wholePoolFreeFraction: 0.5,
  maxRequestMemoryBytes: 12 * 2 ** 30,
  // An unattested Linux host runs heavy leases in FIFO order, at most this
  // many at a time, whatever the measured load: no controller proves more.
  unattestedSlots: 3,
} as const

const GiB = 2 ** 30
export const CHECK_PROFILE = {
  check: { cpuMilli: 1000, memoryBytes: 4 * GiB },
  "land-check": { cpuMilli: 2000, memoryBytes: 4 * GiB },
  vm: { cpuMilli: 2000, memoryBytes: 8 * GiB },
  inventory: { cpuMilli: 1000, memoryBytes: 2 * GiB },
  "exclusive-check": { cpuMilli: 1000, memoryBytes: 4 * GiB },
} as const
const purposes: ReadonlyArray<Purpose> = ["check", "land-check", "vm", "inventory", "exclusive-check"]
type EnvelopeMeasurements = Pick<Measurements, "platform" | "effectiveCpuMilli" | "containedCpuMilli" |
  "totalMemoryBytes" | "containedMemoryBytes" | "controllerAvailable" | "keys" | "attestation"> & {
  readonly volumes: Readonly<Record<string, Pick<Volume, "capacityBytes" | "diskFloorBytes">>>
}

export const hostEnvelope = (raw: EnvelopeMeasurements): HostEnvelope => {
  const cpu = Math.max(0, raw.effectiveCpuMilli - POLICY.reserveCpuMilli)
  // A missing controller is a degraded mode, not a refusal: an unattested
  // host still offers every class, under the fixed cap.
  const offered = raw.controllerAvailable || raw.attestation?.controller === "unattested"
  const envelope: HostEnvelope = {
    cpuMilli: Math.min(cpu, raw.containedCpuMilli ?? cpu),
    memoryBytes: Math.max(0, raw.totalMemoryBytes - POLICY.reserveMemoryBytes),
    needsMemoryReservation: raw.platform === "linux",
    volumes: Object.fromEntries(Object.entries(raw.volumes).map(([id, volume]) =>
      [id, volume.capacityBytes - Math.max(volume.diskFloorBytes, POLICY.diskFloorBytes)])),
    keys: raw.keys,
    purposes: purposes.filter(() => offered && cpu > 0),
  }
  const attested = Option.match(Option.fromNullishOr(raw.attestation), {
    onNone: () => envelope, onSome: (attestation) => ({ ...envelope, attestation }),
  })
  if (Predicate.isNumber(raw.containedMemoryBytes)) return { ...attested, containedMemoryBytes: raw.containedMemoryBytes }
  return attested
}

export const maximumRequestMemory = (envelope: HostEnvelope) =>
  Math.min(POLICY.maxRequestMemoryBytes, envelope.memoryBytes, envelope.containedMemoryBytes ?? envelope.memoryBytes)

const nonnegative = (n: number) => Number.isSafeInteger(n) && n >= 0
const ticksValid = ({ idle, total, at }: Ticks) => [idle, total, at].every(nonnegative) && idle <= total
const managedValid = ({ measuredCpuMilli, enforcedCpuMilli }: ManagedUse) =>
  [measuredCpuMilli, enforcedCpuMilli].every(nonnegative) && measuredCpuMilli <= enforcedCpuMilli

const activeQualification = { darwin: "advisory", linux: "enforced" } as const
const qualificationOf = (raw: Measurements, credit: Option.Option<number>): Supply["qualification"] => {
  if (raw.attestation?.controller === "unattested") return "unattested"
  return Option.match(credit, { onNone: () => "unqualified", onSome: () => activeQualification[raw.platform] })
}
export const measureSupply = (raw: Measurements, envelope = hostEnvelope(raw)): Option.Option<Supply> => {
  const { before, after } = raw
  const total = after.total - before.total
  const idle = after.idle - before.idle
  if (!ticksValid(before) || !ticksValid(after) || total <= 0 || idle < 0 || idle > total) return Option.none()
  if (after.at <= before.at || after.at - before.at > POLICY.freshnessMs) return Option.none()
  if (![raw.effectiveCpuMilli, raw.hostCpuMilli, raw.runnable, raw.memoryBytes, raw.protectedLowerBoundMilli].every(nonnegative)) return Option.none()
  if (raw.effectiveCpuMilli === 0 || raw.effectiveCpuMilli > raw.hostCpuMilli) return Option.none()
  if (Predicate.isNotUndefined(raw.containedCpuMilli) && !nonnegative(raw.containedCpuMilli)) return Option.none()
  const measured = Math.ceil(((total - idle) / total) * raw.hostCpuMilli)
  const managed = raw.managed.reduce((sum, use) => sum + use.measuredCpuMilli, 0)
  const joined = new Set(raw.managed.map((use) => use.binding)).size === raw.managed.length
  const qualifies = raw.qualified && joined && raw.managed.every(managedValid) && managed + raw.protectedLowerBoundMilli <= measured
  const credit = Option.liftPredicate(managed + raw.protectedLowerBoundMilli, () => qualifies)
  const contain = Option.fromNullishOr(raw.containedCpuMilli)
  const base: Supply = {
    id: raw.id,
    at: after.at,
    effectiveCpuMilli: raw.effectiveCpuMilli,
    outsideNoncriticalMilli: Math.max(0, measured - Option.getOrElse(credit, () => 0)),
    protectedCpuMilli: POLICY.reserveCpuMilli,
    memoryBytes: raw.memoryBytes,
    pressure: raw.pressure,
    qualification: qualificationOf(raw, credit),
    runnable: raw.runnable,
    managed: Option.match(credit, { onNone: () => [], onSome: () => raw.managed }),
    volumes: raw.volumes,
    keys: raw.keys, envelope, interval: { before, after },
  }
  if (Option.isSome(contain)) return Option.some({ ...base, containedCpuMilli: contain.value })
  return Option.some(base)
}

export const capacityOf = (sample: Supply): number =>
  Math.min(sample.envelope.cpuMilli, freeHostCpu(sample))

export const freeHostCpu = (sample: Supply): number =>
  Math.max(0, sample.effectiveCpuMilli - sample.protectedCpuMilli - sample.outsideNoncriticalMilli)

export const runnableLimit = (sample: Supply) =>
  Math.min(POLICY.runnableLimit, Math.max(1, Math.floor(sample.effectiveCpuMilli / 1000)))

export const usableVolume = (volume: Volume): boolean =>
  [volume.capacityBytes, volume.freeBytes, volume.metadataFreeBytes, volume.diskFloorBytes].every(nonnegative) &&
  volume.freeBytes <= volume.capacityBytes &&
  (volume.freeInodes === "dynamic" || (nonnegative(volume.freeInodes) && volume.freeInodes >= POLICY.minFreeInodes)) &&
  volume.metadataFreeBytes >= POLICY.minMetadataBytes
