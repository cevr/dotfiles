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
export const HolderOwner = Schema.toEncoded(Owner)
export type HolderOwner = typeof HolderOwner.Type
export const HolderPlacement = Schema.toEncoded(HolderModel.fields.placement)
export const HolderUsage = Schema.toEncoded(HolderModel.fields.usage)
export const HolderKind = HolderModel.fields.kind

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
export const EMPTY_USAGE = Schema.encodeSync(HolderModel.fields.usage)(UNKNOWN_USAGE)
export const EMPTY_PROOF = Schema.encodeSync(Proof)(NO_PROOF)
export const EMPTY_OWNER = Schema.encodeSync(Owner)(UNKNOWN_OWNER)
export const EMPTY_PLACEMENT = Schema.encodeSync(HolderModel.fields.placement)({
  volumeId: Option.none(), objectRef: Option.none(), confinementRef: Option.none(),
})
const fromOwner = Schema.decodeSync(Owner)
const fromPlacement = Schema.decodeSync(HolderModel.fields.placement)
const fromUsage = Schema.decodeSync(HolderModel.fields.usage)

type ControllerDraft = Pick<Holder, "hostId" | "bootId" | "resourceId" | "incarnation" | "holderId" |
  "kind" | "owner" | "dependsOn" | "placement" | "usage" | "coverage" | "protection"> & {
    readonly parentResourceId: Option.Option<string>
  }
export const controllerDraft = (draft: ControllerDraft): Holder => normalizeHolder(holderOf({
  ...draft, version: 1, revision: Option.none(), owner: fromOwner(draft.owner),
  relation: "controller", lease: Option.none(), placement: fromPlacement(draft.placement), usage: fromUsage(draft.usage),
  observedAtMs: 0, sampleBootMs: 0, lastUseAtMs: Option.none(), state: "starting", proof: NO_PROOF,
  producerId: "arbiter", producerSeq: 0,
}))

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

const FullSnapshot = Symbol("FullHolderSnapshot")
export interface HolderSnapshot extends HolderPage {
  readonly [FullSnapshot]: true
  readonly complete: true
}

export const ResourceRef = Schema.Struct({
  hostId: OpaqueId, bootId: OpaqueId, resourceId: OpaqueId, incarnation: OpaqueId,
  holderId: OpaqueId, revision: Counter,
})
export type ResourceRef = typeof ResourceRef.Type

export const resourceRef = (row: Holder): Option.Option<ResourceRef> =>
  Option.map(Option.fromNullishOr(row.revision), (revision) => ({
    hostId: row.hostId, bootId: row.bootId, resourceId: row.resourceId,
    incarnation: row.incarnation, holderId: row.holderId, revision,
  }))

export const sameResource = (a: Pick<Holder, "resourceId" | "incarnation">, b: Pick<Holder, "resourceId" | "incarnation">) =>
  a.resourceId === b.resourceId && a.incarnation === b.incarnation

/** A journal ref is a read fence, never a capability. Consumers must not
 * interpret the absence of a row on a partial/paged view as release. */
export const resourceHolders = (page: HolderSnapshot, ref: ResourceRef): Option.Option<ReadonlyArray<Holder>> => {
  if (page.bootId !== ref.bootId || page.hostId !== ref.hostId || ref.revision > page.revision) return Option.none()
  // Journal pages are ordered by revision. Later scanner activity on a
  // retired incarnation cannot make that incarnation current again.
  const controller = page.records.findLast((row) => row.resourceId === ref.resourceId && row.relation === "controller")
  if (controller && controller.incarnation !== ref.incarnation) return Option.none()
  const rows = page.records.filter((row) => sameResource(row, ref))
  if (!rows.some((row) => row.holderId === ref.holderId && row.revision === ref.revision)) return Option.none()
  return Option.some(rows)
}

export class HolderJournal extends Context.Service<HolderJournal, {
  readonly putObservations: (producerId: string, records: ReadonlyArray<Holder>, nowBootMs: number) => Effect.Effect<ReadonlyArray<Holder>, AdmissionUnavailable>
  readonly list: (after: number, at?: number) => Effect.Effect<HolderPage, AdmissionUnavailable>
}>()("dotfiles-opencode/guard/HolderJournal") {}

export const readHolderSnapshot = Effect.fn("HolderJournal.snapshot")(function* (journal: HolderJournal["Service"]) {
  let page = yield* journal.list(0)
  const { hostId, bootId, revision } = page
  const records = [...page.records]
  for (let i = 1; !page.complete; i++) {
    if (i >= 128 || Predicate.isNull(page.next)) return yield* new AdmissionUnavailable({ reason: "unavailable" })
    const after = page.next
    page = yield* journal.list(after, revision)
    if (page.hostId !== hostId || page.bootId !== bootId || page.revision !== revision ||
      (!page.complete && (Predicate.isNull(page.next) || page.next <= after))) return yield* new AdmissionUnavailable({ reason: "stale" })
    records.push(...page.records)
  }
  return HolderSnapshotValue(page, records)
})

const HolderSnapshotValue = (page: HolderPage, records: ReadonlyArray<Holder>): HolderSnapshot =>
  ({ ...page, records, complete: true, [FullSnapshot]: true })

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

/** Attribution is separate from eligibility. Prefer a controller's charge;
 * borrower rows never charge, and identical native extent groups contribute
 * one measured estimate, not a sum of each observation's copy. */
export const storageCharges = (records: ReadonlyArray<Holder>) => {
  const perOrigin = new Map<string, Holder>()
  for (const row of records) {
    if (row.relation === "borrower") continue
    const key = `${row.resourceId}/${row.incarnation}`
    const old = perOrigin.get(key)
    if (!old || row.relation === "controller" || (old.relation === "observation" && row.producerSeq > old.producerSeq)) perOrigin.set(key, row)
  }
  const charges = new Map<string, { allocatedBytes: Option.Option<number>; sharedBytes: Option.Option<number> }>()
  const max = (a: Option.Option<number>, b: Option.Option<number>) =>
    Option.match(a, { onNone: () => b, onSome: (a) => Option.some(Math.max(a, Option.getOrElse(b, () => 0))) })
  for (const [origin, row] of perOrigin) {
    const { extentGroupRef } = row.usage
    const { volumeId } = row.placement
    const group = Option.getOrElse(Option.map(Option.fromNullishOr(extentGroupRef),
      (extent) => `extent/${Option.getOrElse(Option.fromNullishOr(volumeId), () => "")}/${extent}`), () => `origin/${origin}`)
    const prior = Option.fromNullishOr(charges.get(group))
    charges.set(group, {
      allocatedBytes: max(Option.flatMap(prior, (item) => item.allocatedBytes), Option.fromNullishOr(row.usage.allocatedBytes)),
      sharedBytes: max(Option.flatMap(prior, (item) => item.sharedBytes), Option.fromNullishOr(row.usage.sharedBytes)),
    })
  }
  return [...charges.values()]
}
