import { Context, Effect, Match, Option, Result, Schema } from "effect"
import { AdmissionUnavailable } from "../admission.ts"
import { Counter, OpaqueId } from "../admission-wire.ts"
import {
  HolderKind, HolderOwner, HolderPlacement, HolderUsage, type Holder, type HolderSnapshot,
  ResourceRef, EMPTY_PROOF,
} from "../host-resources.ts"
import { POLICY } from "../host-supply.ts"
import { birthRef, type BootHost, ref } from "./admission.ts"
import { descriptorHolders, type ProcessPin } from "./launchers.ts"

/** This service is for the composition root of an owning adapter. The
 * caller supplies context from its authenticated lifecycle, never argv,
 * environment, observation IDs or an owner assertion from a client. */
export const Authority = Schema.Struct({
  hostId: OpaqueId, bootId: OpaqueId, owner: HolderOwner, authorityId: OpaqueId, epoch: Counter,
})
export type Authority = typeof Authority.Type
export const AuthorityRef = Schema.Struct({ authorityId: OpaqueId, epoch: Counter })
export type AuthorityRef = typeof AuthorityRef.Type

export const Intent = Schema.Struct({
  nonce: OpaqueId, resourceId: OpaqueId, incarnation: OpaqueId, kind: HolderKind,
  dependsOn: Schema.Array(OpaqueId),
  parentResourceId: Schema.OptionFromNullOr(OpaqueId),
  placement: HolderPlacement,
  protection: Schema.Literals(["eligible-class", "protected", "unknown"]),
  usage: HolderUsage,
  coverage: Schema.Literals(["complete", "partial", "unknown"]),
})
export type Intent = typeof Intent.Type

export const OwnershipEvent = Schema.TaggedUnion({
  bind: { at: ResourceRef, objectRef: OpaqueId, confinementRef: Schema.optionalKey(OpaqueId) },
  publish: { at: ResourceRef },
  reconcile: {
    at: ResourceRef, objectRef: OpaqueId, fact: Schema.Literals(["live", "draining", "unknown", "gone"]),
    witness: OpaqueId, sequence: Counter, sampleBootMs: Counter,
  },
  handoff: { at: ResourceRef, successor: AuthorityRef },
  adopt: { at: ResourceRef },
  borrow: { at: ResourceRef, use: OpaqueId },
  release: { at: ResourceRef, use: OpaqueId },
})
export type OwnershipEvent = typeof OwnershipEvent.Type

export interface OwnedReceipt {
  readonly holder: Holder
  /** Only the caller that wins publish receives permission to start. A
   * journal read, reconcile, owner transfer, or replay is not that permit. */
  readonly disposition: "recorded" | "unchanged" | "start-once"
}

export interface OwnerSession {
  readonly intent: (intent: Intent, nowBootMs: number) => Effect.Effect<OwnedReceipt, AdmissionUnavailable>
  readonly change: (event: OwnershipEvent, nowBootMs: number) => Effect.Effect<OwnedReceipt, AdmissionUnavailable>
  readonly rememberLocator: (at: ResourceRef, locator: NativeLocator) => Effect.Effect<void, AdmissionUnavailable>
  readonly locator: (at: ResourceRef) => Effect.Effect<Option.Option<string>, AdmissionUnavailable>
}

export interface NativeLocator {
  readonly objectRef: string
  readonly path: string
}

export class OwnershipJournal extends Context.Service<OwnershipJournal, {
  readonly forOwner: (authority: Authority) => OwnerSession
}>()("dotfiles-opencode/guard/OwnershipJournal") {}

export const owns = (actual: AuthorityRef, expected: AuthorityRef) =>
  actual.authorityId === expected.authorityId && actual.epoch === expected.epoch

export const trustedAuthority = (authority: Authority) =>
  authority.owner.class !== "unknown" && authority.authorityId === authority.owner.authorityId

const keyOf = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))
export const controllerKey = (resource: Pick<Intent, "resourceId" | "incarnation">) =>
  ref("owned", keyOf([resource.resourceId, resource.incarnation]))
export const borrowerKey = (resource: Pick<Intent, "resourceId" | "incarnation">, who: Authority) => {
  const lane = Option.fromNullishOr(who.owner.laneId)
  const scope = Option.match(lane, { onNone: () => ["owner", who.authorityId, String(who.epoch)], onSome: (id) => ["lane", id] })
  return ref("borrowed", keyOf([resource.resourceId, resource.incarnation, ...scope]))
}
export const useKey = (who: Authority, use: string) => keyOf([who.authorityId, String(who.epoch), use])

export const Control = Schema.Struct({
  epoch: Counter,
  bound: Schema.Boolean,
  evidenceSeq: Schema.OptionFromNullOr(Counter),
  successor: Schema.OptionFromNullOr(AuthorityRef),
})
export type Control = typeof Control.Type
export const newControl = (epoch: number): Control =>
  ({ epoch, bound: false, evidenceSeq: Option.none(), successor: Option.none() })
export const controls = (row: Holder, control: Control, who: AuthorityRef) =>
  row.owner.authorityId === who.authorityId && control.epoch === who.epoch

type ControllerEvent = Exclude<OwnershipEvent, { readonly _tag: "borrow" | "release" }>
interface ControlChange {
  readonly row: Holder
  readonly control: Control
  readonly disposition: OwnedReceipt["disposition"]
}
const ownershipError = (reason: "wrong-owner" | "resource" | "stale") => Result.fail(reason)
const decision = (row: Holder, control: Control, disposition: OwnedReceipt["disposition"] = "recorded") =>
  Result.succeed({ row, control, disposition } satisfies ControlChange)

const reconcile = (
  row: Holder, control: Control, event: Extract<ControllerEvent, { readonly _tag: "reconcile" }>, now: number, borrowed: boolean,
) => {
  const { fact, sequence, witness, objectRef, sampleBootMs } = event
  if (row.placement.objectRef !== objectRef || Option.exists(control.evidenceSeq, (seen) => seen >= sequence)) return ownershipError("stale")
  if (sampleBootMs > now || now - sampleBootMs > POLICY.freshnessMs) return ownershipError("stale")
  if (fact === "gone" && borrowed) return ownershipError("resource")
  const next = { ...control, evidenceSeq: Option.some(sequence) }
  if (fact === "unknown") return decision({ ...row, state: "unknown", proof: EMPTY_PROOF }, next)
  if (fact === "live" || fact === "draining") {
    if (!control.bound) return ownershipError("stale")
    return decision({ ...row, state: fact, proof: EMPTY_PROOF }, next)
  }
  const proof: Holder["proof"] = {
    kind: "backend-quiescent", issuerId: row.owner.authorityId, evidenceRef: witness,
    epoch: control.epoch, validUntilBootMs: Math.min(Number.MAX_SAFE_INTEGER, sampleBootMs + POLICY.freshnessMs),
  }
  return decision({ ...row, state: "terminal", proof }, next)
}

export const changeControl = (
  row: Holder, control: Control, who: Authority, event: ControllerEvent, now: number, borrowed: boolean,
): Result.Result<ControlChange, "wrong-owner" | "resource" | "stale"> => {
  if (event._tag === "adopt") {
    if (!Option.exists(control.successor, (successor) => owns(successor, who))) return ownershipError("wrong-owner")
    if (row.state !== "handoff") return ownershipError("stale")
    return decision({ ...row, owner: who.owner, state: "unknown", proof: EMPTY_PROOF }, { ...newControl(who.epoch), bound: control.bound })
  }
  if (!controls(row, control, who)) return ownershipError("wrong-owner")
  if (row.state === "terminal" || row.state === "handoff") return ownershipError("stale")
  return Match.value(event).pipe(Match.tagsExhaustive({
    bind: (event) => {
      if (control.bound || row.placement.objectRef !== event.objectRef) return ownershipError("stale")
      return decision({
        ...row, state: "awaiting",
        placement: { ...row.placement, confinementRef: Option.getOrNull(Option.fromNullishOr(event.confinementRef)) },
      }, { ...control, bound: true })
    },
    publish: () => {
      if (!control.bound || row.state !== "awaiting") return ownershipError("stale")
      return decision({ ...row, state: "live" }, control, "start-once")
    },
    handoff: (event) => {
      if (!control.bound || (row.state !== "live" && row.state !== "unknown")) return ownershipError("stale")
      if (event.successor.authorityId === who.authorityId && event.successor.epoch <= who.epoch) return ownershipError("stale")
      return decision({ ...row, state: "handoff" }, { ...control, successor: Option.some(event.successor) })
    },
    reconcile: (event) => reconcile(row, control, event, now, borrowed),
  }))
}

/** Birth and binding are local evidence from checked descriptor identity, not
 * process ancestry. No path, PID, or handle is present in a HolderPage. */
export interface InheritedProcess {
  readonly bootId: string
  readonly birthRef: string
  readonly binding: string
}
export interface ProcessBirth { readonly pid: number; readonly start: number }
export const verifyInheritance = Effect.fn("Ownership.verifyInheritance")(function* <E>(
  bootId: string, pin: ProcessPin, candidate: ProcessBirth,
  holders: (pid: number) => Effect.Effect<ReadonlyArray<ProcessBirth>, E>,
) {
  if (pin.bootId !== bootId) return Option.none()
  const matches = yield* holders(candidate.pid)
  if (!matches.some((process) => process.pid === candidate.pid && process.start === candidate.start)) return Option.none()
  return Option.some({ bootId, binding: pin.ref, birthRef: birthRef(bootId, candidate) } satisfies InheritedProcess)
})

export const inheritedProcess = (host: BootHost, pin: ProcessPin, candidate: ProcessBirth) =>
  verifyInheritance(host.bootId, pin, candidate, (pid) => descriptorHolders(host, pin.descriptor, [pid]))

export const inheritedController = (snapshot: HolderSnapshot, process: InheritedProcess): Option.Option<Holder> => {
  if (snapshot.bootId !== process.bootId) return Option.none()
  const matches = snapshot.records.filter((row) =>
    row.relation === "controller" && row.placement.confinementRef === process.binding && row.state !== "terminal")
  if (matches.length !== 1) return Option.none()
  return Option.fromNullishOr(matches[0])
}
