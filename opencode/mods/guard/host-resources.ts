import { Context, Effect, Option, Order, Predicate, Schema } from "effect"
import { Counter, OpaqueId, Version } from "./admission-wire.ts"
import { AdmissionUnavailable } from "./admission.ts"

const id = Schema.OptionFromNullOr(OpaqueId)
const count = Schema.OptionFromNullOr(Counter)
const Owner = Schema.Struct({
  class: Schema.Literals(["agent", "human", "system", "service", "unknown"]),
  authorityId: id, repoId: id, runId: id, laneId: id, unitId: id, round: count,
  sessionId: id, sessionEpoch: id, callId: id, jobId: id,
})
const Proof = Schema.Struct({
  kind: Schema.Literals(["none", "owner-terminal", "backend-quiescent"]),
  issuerId: id, evidenceRef: id, epoch: count, validUntilBootMs: count,
})
const Port = Schema.Struct({
  transport: Schema.Literals(["tcp", "udp"]), endpointRef: OpaqueId,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
})
const HolderModel = Schema.Struct({
  version: Version,
  hostId: OpaqueId, bootId: OpaqueId, resourceId: OpaqueId, incarnation: OpaqueId, holderId: OpaqueId, revision: count,
  kind: Schema.Literals(["process-tree", "server", "listener", "service-unit", "container", "device-session", "browser-scope", "workspace", "snapshot", "trash", "cache", "build-output", "log", "file-set"]),
  owner: Owner,
  relation: Schema.Literals(["controller", "borrower", "observation"]),
  parentResourceId: id,
  dependsOn: Schema.Array(OpaqueId),
  placement: Schema.Struct({ volumeId: id, objectRef: id, confinementRef: id }),
  lease: Schema.OptionFromNullOr(Schema.Struct({ id: OpaqueId, generation: Counter })),
  usage: Schema.Struct({
    cpuMilli: count, cpuWindowMs: count, memoryBytes: count,
    memoryBasis: Schema.OptionFromNullOr(Schema.Literals(["pss", "footprint", "rss", "cgroup"])),
    allocatedBytes: count, exclusiveBytes: count, sharedBytes: count, extentGroupRef: id,
    ports: Schema.OptionFromNullOr(Schema.Array(Port)), deviceSlots: count,
  }),
  observedAtMs: Counter, sampleBootMs: Counter, lastUseAtMs: count,
  coverage: Schema.Literals(["complete", "partial", "unknown"]),
  state: Schema.Literals(["starting", "live", "awaiting", "handoff", "draining", "terminal", "unknown"]),
  proof: Proof,
  protection: Schema.Literals(["protected", "eligible-class", "unknown"]),
  producerId: OpaqueId, producerSeq: Counter,
})
export const holderOf = Schema.encodeSync(HolderModel)
export const Holder = Schema.toEncoded(HolderModel)
export type Holder = typeof Holder.Type

export const UNKNOWN_OWNER: typeof Owner.Type = {
  class: "unknown", authorityId: Option.none(), repoId: Option.none(), runId: Option.none(), laneId: Option.none(),
  unitId: Option.none(), round: Option.none(), sessionId: Option.none(), sessionEpoch: Option.none(), callId: Option.none(), jobId: Option.none(),
}
export const NO_PROOF: typeof Proof.Type = {
  kind: "none", issuerId: Option.none(), evidenceRef: Option.none(), epoch: Option.none(), validUntilBootMs: Option.none(),
}
export const UNKNOWN_USAGE: typeof HolderModel.Type["usage"] = {
  cpuMilli: Option.none(), cpuWindowMs: Option.none(), memoryBytes: Option.none(), memoryBasis: Option.none(),
  allocatedBytes: Option.none(), exclusiveBytes: Option.none(), sharedBytes: Option.none(), extentGroupRef: Option.none(),
  ports: Option.none(), deviceSlots: Option.none(),
}

const portKey = (port: typeof Port.Type) => `${port.transport}:${port.endpointRef}:${String(port.port).padStart(5, "0")}`

export const normalizeHolder = (record: Holder): Holder => ({
  ...record,
  dependsOn: [...new Set(record.dependsOn)].toSorted(),
  usage: {
    ...record.usage,
    ports: Option.getOrNull(Option.map(Option.fromNullishOr(record.usage.ports), (ports) =>
      [...new Map(ports.map((port) => [portKey(port), port])).entries()]
        .toSorted(([a], [b]) => Order.String(a, b)).map(([, port]) => port))),
  },
})

/** Observation claims can supply measurement IDs and charge, never authority or proof. */
export const trustedObservation = (row: Holder): boolean =>
  row.relation === "observation" && Predicate.isNull(row.lease) && Predicate.isNull(row.placement.confinementRef) &&
  row.protection === "unknown" && row.state === "unknown" && Predicate.isNull(row.usage.exclusiveBytes) &&
  row.proof.kind === "none" && [row.proof.issuerId, row.proof.evidenceRef, row.proof.epoch, row.proof.validUntilBootMs].every(Predicate.isNull) &&
  row.owner.class === "unknown" && Object.entries(row.owner).every(([key, value]) => key === "class" || Predicate.isNull(value))

export interface HolderPage {
  readonly version: 1
  readonly hostId: string
  readonly bootId: string
  readonly revision: number
  readonly complete: boolean
  readonly next: Holder["revision"]
  readonly records: ReadonlyArray<Holder>
}

export class HolderJournal extends Context.Service<HolderJournal, {
  readonly putObservations: (producerId: string, records: ReadonlyArray<Holder>, nowBootMs: number) => Effect.Effect<ReadonlyArray<Holder>, AdmissionUnavailable>
  readonly list: (after: number, at?: number) => Effect.Effect<HolderPage, AdmissionUnavailable>
}>()("dotfiles-opencode/guard/HolderJournal") {}

const stringOf = Schema.encodeSync(Schema.fromJsonString(Schema.String))
const numberOf = Schema.encodeSync(Schema.fromJsonString(Counter))
const jsonOf = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const encoded = Schema.encodeSync(Holder)

const canonicalValue = (value: Schema.Json): string => {
  if (Predicate.isNull(value) || Predicate.isBoolean(value)) return jsonOf(value)
  if (Predicate.isNumber(value)) return numberOf(value)
  if (Predicate.isString(value)) return stringOf(value)
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`
  return `{${Object.entries(value).toSorted(([a], [b]) => Order.String(a, b))
    .map(([key, item]) => `${stringOf(key)}:${canonicalValue(item)}`).join(",")}}`
}

/** JSON Canonicalization Scheme for the restricted v1 domain (safe ints and printable opaque strings). */
export const canonicalHolder = (value: Holder): string => canonicalValue(encoded(normalizeHolder(value)))
