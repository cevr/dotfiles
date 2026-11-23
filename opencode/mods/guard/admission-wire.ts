import { Effect, Order, Schema } from "effect"

export const Counter = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
export const OpaqueId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u))
export const Version = Schema.Literal(1)
export const Principal = Schema.Struct({
  kind: Schema.Literals(["external-runner", "native-shell", "wake-job"]),
  scopeId: OpaqueId,
  epoch: Counter,
})
export type Principal = typeof Principal.Type
export const VolumeReservation = Schema.Struct({ volumeId: OpaqueId, bytes: Counter })
export const KnownWidth = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 })).pipe(Schema.brand("HostWidth"))
export const Width = Schema.Union([KnownWidth, Schema.Literal("unknown")])
export type Width = typeof Width.Type
export const widthOf = Schema.decodeUnknownOption(KnownWidth)
export const Purpose = Schema.Literals(["check", "land-check", "vm", "inventory", "exclusive-check"])
export type Purpose = typeof Purpose.Type
export const purposeKeys = {
  check: [], "land-check": [], vm: ["vm"], inventory: ["trace"], "exclusive-check": [],
} as const satisfies Record<Purpose, ReadonlyArray<string>>
export const Demand = Schema.Struct({
  width: Width.pipe(Schema.withDecodingDefaultKey(Effect.succeed("unknown" as const))),
  cpuMilli: Counter,
  memoryBytes: Counter,
  ioClass: Schema.Literals(["idle", "normal"]),
  volumeReservations: Schema.Array(VolumeReservation),
  keys: Schema.Array(OpaqueId),
})
export type Demand = typeof Demand.Type
export const Request = Schema.Struct({
  version: Version,
  requestId: OpaqueId,
  principal: Principal,
  purpose: Purpose,
  tier: Schema.Literals(["small", "standard"]),
  demand: Demand,
  deadlineBootMs: Counter,
})
export type Request = typeof Request.Type
export const Phase = Schema.Literals(["queued", "granted", "running", "draining", "released", "expired", "cancelled", "refused"])
export type Phase = typeof Phase.Type
export const Reason = Schema.Literals([
  "queued", "fifo", "capacity", "resource", "pressure", "disk", "memory", "unknown-volume", "unknown-key", "unavailable",
  "stale-sample", "unqualified", "granted", "running", "stopped", "owner-gone", "owner-unknown", "scope-live", "scope-drained",
  "deadline", "expired-grant", "cancelled", "stale", "incompatible", "invalid-request", "unknown-id", "wrong-owner",
])
export type Reason = typeof Reason.Type
const ReplyModel = Schema.Struct({
  version: Version,
  hostId: OpaqueId,
  bootId: OpaqueId,
  id: Schema.OptionFromNullOr(OpaqueId),
  sequence: Counter,
  state: Phase,
  reason: Reason,
  sampleId: Schema.OptionFromNullOr(OpaqueId),
  admittedDemand: Schema.OptionFromNullOr(Demand),
  expiresBootMs: Schema.OptionFromNullOr(Counter),
})
export const reply = Schema.encodeSync(ReplyModel)
export const Reply = Schema.toEncoded(ReplyModel)
export type Reply = typeof Reply.Type

export const normalizeRequest = (request: Request): Request => ({
  ...request,
  demand: {
    ...request.demand,
    keys: [...new Set([...request.demand.keys, ...purposeKeys[request.purpose]])].toSorted(),
    volumeReservations: request.demand.volumeReservations.toSorted((a, b) => Order.String(a.volumeId, b.volumeId)),
  },
})
