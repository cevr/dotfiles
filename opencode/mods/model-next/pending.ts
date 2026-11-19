// A model switch queued for a session, and the rules that decide it, as pure
// decisions over plain facts (no host, no clock).
//
// The value lives in the session's own metadata under `KEY`: durable, moved
// with the session, read live by the TUI. It names the session it was queued
// for, so a child or a fork that copied its parent's metadata finds a value
// naming another session and treats it as absent (`pendingOf`). It names the
// model the session was on when it was queued (`from`): a model selection
// that moves the session off that model, the owner's or anyone's, ends it
// (`endedBy`), and a selection that leaves it there (a stale event of a
// switch made before the queue) does not.
//
// It applies at whichever comes first:
// - a completed compaction (`atCompaction`): the outgoing model wrote the
//   summary, and the next request reads only the summary, so the new model's
//   first request writes about the summary and no more;
// - the session's next wake once the cache the last request wrote has expired
//   (`atWake`): past the request's start, plus its lifetime, plus a grace,
//   the next request writes the whole context whichever model takes it.
//   Never early: an unknown lifetime, an uncached request, no request since
//   the last compaction, or a compaction after it means no apply.
import { Data, Option, Schema } from "effect"

/** The metadata key the queued switch lives under. */
export const KEY = "modelNext"

const text = { type: "string" } as const
const object = (properties: Record<string, unknown>, required: ReadonlyArray<string>) => ({ type: "object", properties, required }) as const
const ref = object({ providerID: text, id: text, variant: text }, ["providerID", "id"])

/**
 * The mod's RPC.
 * - `queue({ sessionID, model })`: queue a switch to `model` for the session. `Answer` says `Queued`, or why not.
 * - `cancel({ sessionID })`: drop the session's queued switch. `Cancelled`.
 * - `show({ sessionID })`: the session's queued switch, if any (`Shown`).
 */
export const MODEL_NEXT = {
  id: "dotfiles-opencode.model-next",
  methods: {
    queue: { input: object({ sessionID: text, model: ref }, ["sessionID", "model"]), output: { type: "object" } },
    cancel: { input: object({ sessionID: text }, ["sessionID"]), output: { type: "object" } },
    show: { input: object({ sessionID: text }, ["sessionID"]), output: { type: "object" } },
  },
  events: {},
} as const

/** A model as a session selects it. A model with no variant runs at its `default`. */
export const ModelRef = Schema.Struct({ providerID: Schema.String, id: Schema.String, variant: Schema.optional(Schema.String) })
export type ModelRef = typeof ModelRef.Type

/** The queued switch, as the session's metadata keeps it. */
export const Pending = Schema.Struct({
  sessionID: Schema.String,
  model: ModelRef,
  /** The session's model when it was queued: a selection that moves it off this one ends the queued switch. */
  from: Schema.optional(ModelRef),
  /** Epoch ms. */
  queuedAt: Schema.Number,
})
export type Pending = typeof Pending.Type

const decodePending = Schema.decodeUnknownOption(Pending)
const Metadata = Schema.Record(Schema.String, Schema.Unknown)
const decodeMetadata = Schema.decodeUnknownOption(Metadata)

/** The variant a reference runs at. */
const variantOf = (model: ModelRef) => model.variant ?? "default"

/** Whether two references name one model at one variant, as the host's `switchModel` compares them. */
export const sameModel = (left: ModelRef, right: ModelRef): boolean =>
  left.providerID === right.providerID && left.id === right.id && variantOf(left) === variantOf(right)

/** `provider/id`, with `#variant` when it names one. */
export const label = (model: ModelRef): string => `${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}`

/** A `provider/id[#variant]` reference, as the CLI and an agent write one. */
export const parseRef = (input: string): Option.Option<ModelRef> => {
  const match = /^([^/#\s]+)\/([^#\s]+)(?:#([^#\s]+))?$/.exec(input.trim())
  if (match === null || match[1] === undefined || match[2] === undefined) return Option.none()
  return Option.some({ providerID: match[1], id: match[2], ...(match[3] === undefined ? {} : { variant: match[3] }) })
}

/** The session's queued switch, from its metadata: none when there is none, it does not read, or it names another session. */
export const pendingOf = (sessionID: string, metadata: unknown): Option.Option<Pending> =>
  Option.filter(
    Option.flatMap(decodeMetadata(metadata ?? {}), (record) => decodePending(record[KEY])),
    (pending) => pending.sessionID === sessionID,
  )

const decodeHolder = Schema.decodeUnknownOption(Schema.Struct({ metadata: Schema.optional(Schema.Unknown) }))

/** The switch queued on a session record as a client holds it (any object with `metadata`): what Prime's tray reads. */
export const pendingIn = (sessionID: string, session: unknown): Option.Option<Pending> =>
  Option.flatMap(decodeHolder(session), (held) => pendingOf(sessionID, held.metadata))

/** The session's metadata with the queued switch set, or taken out: every other key as it was. */
export const withPending = (metadata: unknown, pending: Option.Option<Pending>): Record<string, unknown> => {
  const read: Readonly<Record<string, unknown>> = Option.getOrElse(decodeMetadata(metadata ?? {}), () => ({}))
  const rest = Object.fromEntries(Object.entries(read).filter(([key]) => key !== KEY))
  return Option.match(pending, { onNone: () => rest, onSome: (value) => ({ ...rest, [KEY]: value }) })
}

// ── Answers ──

export const Refusal = Schema.Literals(["same-model", "unknown-model", "no-session", "native-compaction"])
export type Refusal = typeof Refusal.Type

export const Queued = Schema.TaggedStruct("Queued", { model: ModelRef, from: ModelRef })
export const Cancelled = Schema.TaggedStruct("Cancelled", { had: Schema.Boolean })
export const Refused = Schema.TaggedStruct("Refused", { reason: Refusal })
/** What `queue` and `cancel` answer: refusals are answers, not errors. */
export const Answer = Schema.Union([Queued, Cancelled, Refused])
export type Answer = typeof Answer.Type

/** What `show` answers: the session's queued switch, and the model it runs on now. */
export const Shown = Schema.Struct({ pending: Schema.optional(Pending), current: Schema.optional(ModelRef) })
export type Shown = typeof Shown.Type

/** A refusal in plain words, as the TUI toasts it and the CLI prints it. */
export const refusalText = (reason: Refusal): string =>
  ({
    "same-model": "the session already runs on that model",
    "unknown-model": "the catalog has no such model (or variant)",
    "no-session": "there is no such session",
    "native-compaction": "the session's model compacts natively: the next model would get the whole transcript",
  })[reason]

// ── Decisions ──

/** A model's catalog entry, as the decisions read it. */
export interface CatalogEntry {
  readonly variants: ReadonlyArray<string>
  /** Its settings say `compaction.type: "native"`: a window only it can replay. */
  readonly native: boolean
}

/** What the queue decision reads: the model the session runs on (none when it is gone), and the catalog's entries for the target and for that model. */
export interface QueueFacts {
  readonly current: Option.Option<ModelRef>
  readonly target: Option.Option<CatalogEntry>
  readonly own: Option.Option<CatalogEntry>
}

export type Queueing = Data.TaggedEnum<{ Keep: { readonly pending: Pending }; Refuse: { readonly reason: Refusal } }>
export const Queueing = Data.taggedEnum<Queueing>()

/** Whether the catalog's entry offers the reference's variant: a reference with none, or `default`, runs at the default. */
const offers = (entry: CatalogEntry, target: ModelRef) => target.variant === undefined || target.variant === "default" || entry.variants.includes(target.variant)

/** Queue `target` for the session at `now`: the value to keep, or why not. */
export const queue = (sessionID: string, target: ModelRef, facts: QueueFacts, now: number): Queueing => {
  if (Option.isNone(facts.current)) return Queueing.Refuse({ reason: "no-session" })
  const current = facts.current.value
  if (sameModel(current, target)) return Queueing.Refuse({ reason: "same-model" })
  if (!Option.exists(facts.target, (entry) => offers(entry, target))) return Queueing.Refuse({ reason: "unknown-model" })
  if (Option.exists(facts.own, (own) => own.native)) return Queueing.Refuse({ reason: "native-compaction" })
  return Queueing.Keep({ pending: { sessionID, model: target, from: current, queuedAt: now } })
}

/** Whether the target is still the catalog's to switch to at an apply point. */
export const present = (target: ModelRef, entry: Option.Option<CatalogEntry>): boolean => Option.exists(entry, (found) => offers(found, target))

/** Whether a model selection of the session (`session.model.selected`) ends the queued switch: it moved the session off the model it was queued from. */
export const endedBy = (pending: Pending, selected: ModelRef): boolean =>
  pending.from === undefined || !sameModel(pending.from, selected)

/** What an apply point decides. */
export type Apply = Data.TaggedEnum<{
  /** Switch to `model` now, and drop the queued value. */
  Switch: { readonly model: ModelRef }
  /** Leave it queued; `reason` for the log. */
  Wait: { readonly reason: WaitReason }
}>
export const Apply = Data.taggedEnum<Apply>()

export type WaitReason = "target-gone" | "no-request" | "compacted" | "uncached" | "ttl-unknown" | "warm"

/** At a completed compaction: switch, unless the catalog no longer has the target (it stays queued). */
export const atCompaction = (pending: Pending, present: boolean): Apply =>
  present ? Apply.Switch({ model: pending.model }) : Apply.Wait({ reason: "target-gone" })

/** The last request since the last compaction, as the cache sees it (idle-compact's `LastRequest`, what this reads of it). */
export interface LastRequest {
  /** Epoch ms: the cache's last refresh. */
  readonly startedAt: number
  readonly cached: boolean
  /** The lifetime the request got, in ms; none when unknown. */
  readonly ttl: Option.Option<number>
  /** Why the lifetime could not be read, when it could not. */
  readonly unresolved?: string | undefined
}

/** What the wake decision reads of the session's cache. */
export interface CacheFacts {
  readonly last: Option.Option<LastRequest>
  /** A compaction (completed, running or failed) came after the last request: its summary request refreshed the cache, or may have. */
  readonly compacted: boolean
}

/** The wake's settings: a lifetime over every model's (`ttlSeconds`), and the grace past the lifetime (`graceSeconds`). */
export interface Policy {
  readonly ttl: Option.Option<number>
  readonly grace: number
}

export const GRACE_SECONDS = 60

/**
 * At a wake, at `now` (epoch ms): switch once the last request's cache has expired, past `startedAt + ttl + grace`;
 * else wait. Every unknown waits: a late switch costs nothing, an early one is the full-price write this exists to avoid.
 */
export const atWake = (pending: Pending, cache: CacheFacts, policy: Policy, present: boolean, now: number): Apply => {
  if (cache.compacted) return Apply.Wait({ reason: "compacted" })
  if (Option.isNone(cache.last)) return Apply.Wait({ reason: "no-request" })
  const last = cache.last.value
  if (!last.cached) return Apply.Wait({ reason: "uncached" })
  if (last.unresolved !== undefined && Option.isNone(policy.ttl)) return Apply.Wait({ reason: "ttl-unknown" })
  const ttl = Option.orElse(policy.ttl, () => last.ttl)
  if (Option.isNone(ttl)) return Apply.Wait({ reason: "ttl-unknown" })
  if (now <= last.startedAt + ttl.value + policy.grace) return Apply.Wait({ reason: "warm" })
  if (!present) return Apply.Wait({ reason: "target-gone" })
  return Apply.Switch({ model: pending.model })
}
