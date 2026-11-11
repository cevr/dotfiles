// The fleet's spend authority: how the hosts that read one provider agree
// which of them may spend a reset, with no host the master (the Mac may be
// asleep, or on the move). Positive agreement: a claim no one asked for is
// sent only once every peer the fleet knows of granted this host the
// provider's lease. A peer that does not answer is no grant: the claim is
// not sent, and the pool asks the owner instead (model.ts), since that peer
// may be claiming too. The owner's yes is the authority in a partition: it
// sends with the reachable peers' grants alone. `verdict` says which.
//
// The lease is per provider, not per account: a host's login is its own, and
// the reset ids two hosts list for one account may differ (one host's list
// lags), so no reading names the account alike on every host. Claims are
// rare; one at a time per provider across the fleet only delays a second.
//
// A peer grants the lease unless one of these holds:
// - it is quiet: its leases started (a restart) less than QUIET_MS ago,
//   so it may have lent a lease it no longer remembers;
// - it lent the lease to another host, and that lease is live;
// - it was told of a peer's claim on the provider (a release) that a
//   reading taken before SETTLE_MS after it may not show yet (the
//   provider's lag), or it sent one itself: the claims its Resets store
//   keeps across a restart (resets.ts `claimOut`, which model.ts asks
//   first, for a peer's ask and for its own claim alike);
// - it is claiming itself: from its hold until its claim comes back;
// - it is asking at once and asked first: the earlier ask, then the lower
//   host name, the same on both sides; the loser yields.
//
// The asker's hold never outlasts what it asked for (`requestedAt + holdMs`),
// so the lender's lease, lent at least that long, covers it. Once held, the
// host reads the account again and sends only if the lease still holds.
// Every sent claim is released with its time, whatever came back: a claim
// that may have gone through holds the next off for SETTLE_MS.
//
// The table is pure: `answer`, `begin`, `hold`, `finish` and `release` each
// return the new table. `make` keeps one table per host behind the `Leases`
// service; `HOST` is the process's, shared by every plugin instance in it.
import { Clock, Context, Effect, Schema, Semaphore } from "effect"
import { ResetProvider, SETTLE_MS } from "./resets.ts"

export { SETTLE_MS }

const MINUTE = 60_000

/** How long a lease holds: a claim reads the account, sends the claim and reads it again well within it. */
export const LEASE_MS = 2 * MINUTE
/** The longest lease a peer lends, whatever the asker asks. */
export const MAX_LEASE_MS = 5 * MINUTE
/** How long a host just started lends nothing: a lease it lent, or a claim it sent, before it started has run out and shows. */
export const QUIET_MS = Math.max(MAX_LEASE_MS, SETTLE_MS)
/** How long a host waits for each peer's answer. */
export const LEASE_WAIT_MS = 10_000
/** How long a claim is remembered. */
const SEEN_MS = 24 * 60 * MINUTE

const LeaseFields = {
  /** The host asking, as the fleet names it (`FleetConfig.host`). */
  host: Schema.String,
  /** The ask's id: one claim's, released under it. */
  id: Schema.String,
  provider: ResetProvider,
  /** The reset ids the asker's reading lists, for the record. */
  grants: Schema.Array(Schema.String),
}

/** A host asks for a provider's lease, on a reading taken at `readAt`, at `requestedAt`, to hold for `holdMs`. */
export const LeaseAsk = Schema.TaggedStruct("Ask", { ...LeaseFields, readAt: Schema.Number, requestedAt: Schema.Number, holdMs: Schema.Number })
export type LeaseAsk = typeof LeaseAsk.Type

/** A host releases a lease, with when its claim was sent, if it was. */
export const LeaseRelease = Schema.TaggedStruct("Release", { ...LeaseFields, claimedAt: Schema.optionalKey(Schema.Number) })
export type LeaseRelease = typeof LeaseRelease.Type

export const LeaseMessage = Schema.Union([LeaseAsk, LeaseRelease])
export type LeaseMessage = typeof LeaseMessage.Type

/** A peer's answer: granted, or why not. A release is always granted. */
export const LeaseAnswer = Schema.Struct({ granted: Schema.Boolean, reason: Schema.optionalKey(Schema.String) })
export type LeaseAnswer = typeof LeaseAnswer.Type

interface Scoped {
  readonly provider: ResetProvider
}

/** A lease this host asks for (`asking`), holds while its claim is out (`held`), or gave up to a host that asked first (`yielded`). */
export interface Own extends Scoped {
  readonly id: string
  readonly grants: ReadonlyArray<string>
  readonly readAt: number
  readonly requestedAt: number
  readonly stage: "asking" | "held" | "yielded"
  /** When the lease ends: `requestedAt + holdMs`, never later. A held lease stays until its claim is finished. */
  readonly expiresAt: number
}

/** A lease this host lent another. */
export interface Lent extends Scoped {
  readonly host: string
  readonly id: string
  readonly expiresAt: number
}

/** A peer's claim this host was told of. */
export interface Seen extends Scoped {
  readonly at: number
}

export interface LeaseTable {
  readonly own: ReadonlyArray<Own>
  readonly lent: ReadonlyArray<Lent>
  readonly seen: ReadonlyArray<Seen>
  /** Until when this host lends nothing: its leases started then (a restart), and it may have lent one it forgot. */
  readonly quietUntil?: number
}

export const emptyTable: LeaseTable = { own: [], lent: [], seen: [] }

/** A host's table as it starts: empty, and quiet for `quietMs` from `now`. */
export const started = (now: number, quietMs: number = QUIET_MS): LeaseTable => ({ ...emptyTable, quietUntil: now + quietMs })

/** Whether `left` asked before `right`: the earlier ask, then the lower host name. */
export const asksFirst = (left: { readonly requestedAt: number; readonly host: string }, right: { readonly requestedAt: number; readonly host: string }) =>
  left.requestedAt < right.requestedAt || (left.requestedAt === right.requestedAt && left.host < right.host)

const prune = (table: LeaseTable, now: number): LeaseTable => ({
  ...table,
  own: table.own.filter((item) => item.stage === "held" || item.expiresAt > now),
  lent: table.lent.filter((item) => item.expiresAt > now),
  seen: table.seen.filter((item) => now - item.at < SEEN_MS),
})

const stamp = (at: number) => new Date(at).toISOString()

/** Why the provider is not free for a lease asked by `asker` on a reading at `readAt`, by what was lent and seen; none when it is. */
const taken = (table: LeaseTable, ask: Scoped & { readonly readAt: number }, asker: string): string | undefined => {
  const lent = table.lent.find((item) => item.host !== asker && item.provider === ask.provider)
  if (lent !== undefined) return `${lent.host} holds the ${ask.provider} lease until ${stamp(lent.expiresAt)}`
  const seen = table.seen.find((item) => item.provider === ask.provider && ask.readAt < item.at + SETTLE_MS)
  if (seen !== undefined) return `a claim at ${stamp(seen.at)} may not show yet in a reading from ${stamp(ask.readAt)}`
  return undefined
}

/** `self`'s answer to a peer's `ask`, and its table after it. */
export const answer = (table: LeaseTable, self: string, ask: LeaseAsk, now: number): readonly [LeaseAnswer, LeaseTable] => {
  const current = prune(table, now)
  const refuse = (reason: string) => [{ granted: false, reason }, current] as const
  if (current.quietUntil !== undefined && now < current.quietUntil) return refuse(`${self} started lately and lends nothing until ${stamp(current.quietUntil)}`)
  const why = taken(current, ask, ask.host)
  if (why !== undefined) return refuse(why)
  const mine = current.own.find((item) => item.stage !== "yielded" && item.provider === ask.provider)
  if (mine?.stage === "held") return refuse(`${self} is claiming on ${ask.provider}`)
  if (mine !== undefined && asksFirst({ requestedAt: mine.requestedAt, host: self }, ask)) return refuse(`${self} asked first`)
  const own = current.own.map((item) => (item === mine ? { ...item, stage: "yielded" as const } : item))
  const lent = [
    ...current.lent.filter((item) => !(item.host === ask.host && item.id === ask.id)),
    { host: ask.host, id: ask.id, provider: ask.provider, expiresAt: now + Math.min(Math.max(ask.holdMs, 0), MAX_LEASE_MS) },
  ]
  return [{ granted: true }, { ...current, own, lent }]
}

/** A peer released its lease: lent no more, and its claim, if it sent one, seen. */
export const release = (table: LeaseTable, message: LeaseRelease, now: number): LeaseTable => {
  const current = prune(table, now)
  return {
    ...current,
    lent: current.lent.filter((item) => !(item.host === message.host && item.id === message.id)),
    seen: message.claimedAt === undefined ? current.seen : [...current.seen, { provider: message.provider, at: message.claimedAt }],
  }
}

/** This host starts asking for a lease; why it may not, if so (another host's lease, a claim that may not show yet, a claim out here). */
export const begin = (
  table: LeaseTable,
  self: string,
  ask: Pick<LeaseAsk, "id" | "provider" | "grants" | "readAt" | "requestedAt" | "holdMs">,
  now: number,
): readonly [string | undefined, LeaseTable] => {
  const current = prune(table, now)
  const why = taken(current, ask, self) ?? (current.own.some((item) => item.stage !== "yielded" && item.provider === ask.provider) ? `a ${ask.provider} claim is in hand here` : undefined)
  if (why !== undefined) return [why, current]
  const own: Own = { id: ask.id, provider: ask.provider, grants: ask.grants, readAt: ask.readAt, requestedAt: ask.requestedAt, stage: "asking", expiresAt: ask.requestedAt + ask.holdMs }
  return [undefined, { ...current, own: [...current.own.filter((item) => item.id !== ask.id), own] }]
}

/** Every peer granted: hold the lease until it ends (never longer), unless this host yielded it meanwhile or it ended (false). */
export const hold = (table: LeaseTable, id: string, now: number): readonly [boolean, LeaseTable] => {
  const mine = table.own.find((item) => item.id === id)
  if (mine === undefined || mine.stage !== "asking" || mine.expiresAt <= now) return [false, table]
  return [true, { ...table, own: table.own.map((item) => (item === mine ? { ...item, stage: "held" as const } : item)) }]
}

/** Whether this host still holds the lease `id` at `now`: checked right before the claim is sent. */
export const holds = (table: LeaseTable, id: string, now: number): boolean =>
  table.own.some((item) => item.id === id && item.stage === "held" && item.expiresAt > now)

/** The claim is done (or not sent): the lease ends. A claim this host sent its Resets store keeps (resets.ts `claimOut`), not this table. */
export const finish = (table: LeaseTable, id: string): LeaseTable => ({ ...table, own: table.own.filter((item) => item.id !== id) })

/** What the peers' answers allow: send (every peer granted, or the owner said yes and no reachable peer refused), back off, or ask the owner. */
export type Verdict =
  | { readonly _tag: "send"; readonly granted: ReadonlyArray<string>; readonly passedOver: ReadonlyArray<string> }
  | { readonly _tag: "refused"; readonly reasons: ReadonlyArray<string> }
  | { readonly _tag: "unreachable"; readonly peers: ReadonlyArray<string> }

/**
 * The spend rule. A refusal from any peer backs off. A peer with no answer
 * (unreachable, or silent past the wait) is no grant: a claim no one asked
 * for is not sent, it becomes the owner's question; the owner's `yes` sends
 * it anyway, with the reachable peers' grants.
 */
export const verdict = (answers: ReadonlyArray<{ readonly peer: string; readonly answer: LeaseAnswer | undefined }>, yes: boolean): Verdict => {
  const refused = answers.flatMap((item) => (item.answer !== undefined && !item.answer.granted ? [`${item.peer}: ${item.answer.reason ?? "refused"}`] : []))
  if (refused.length > 0) return { _tag: "refused", reasons: refused }
  const silent = answers.flatMap((item) => (item.answer === undefined ? [item.peer] : []))
  const granted = answers.flatMap((item) => (item.answer?.granted === true ? [item.peer] : []))
  if (silent.length > 0 && !yes) return { _tag: "unreachable", peers: silent }
  return { _tag: "send", granted, passedOver: silent }
}

/**
 * One host's leases, and its claim lock per provider: one claim at a time on
 * the host, across its pools and plugin instances, each judged on a reading
 * taken under the lock.
 */
export class Leases extends Context.Service<
  Leases,
  {
    readonly lock: (provider: ResetProvider) => Semaphore.Semaphore
    readonly answer: (self: string, ask: LeaseAsk) => Effect.Effect<LeaseAnswer>
    readonly release: (message: LeaseRelease) => Effect.Effect<void>
    readonly begin: (self: string, ask: Pick<LeaseAsk, "id" | "provider" | "grants" | "readAt" | "requestedAt" | "holdMs">) => Effect.Effect<string | undefined>
    readonly hold: (id: string) => Effect.Effect<boolean>
    readonly holds: (id: string) => Effect.Effect<boolean>
    readonly finish: (id: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/pool/Leases") {}

/**
 * A host's leases in memory, and its locks. The table starts at the first
 * time it is used, quiet for `quietMs` (default QUIET_MS): a process
 * cannot tell a first start from a restart that forgot a lease it lent.
 */
export const make = (options: { readonly quietMs?: number } = {}): Leases["Service"] => {
  let table: LeaseTable | undefined
  const locks = new Map<ResetProvider, Semaphore.Semaphore>()
  /** Change the table at the clock's time, and answer what the change says. */
  const change = <A>(body: (current: LeaseTable, at: number) => readonly [A, LeaseTable]) =>
    Effect.map(Clock.currentTimeMillis, (at) => {
      const [result, next] = body(table ?? started(at, options.quietMs ?? QUIET_MS), at)
      table = next
      return result
    })
  return {
    lock: (provider) => {
      const held = locks.get(provider)
      if (held !== undefined) return held
      const lock = Semaphore.makeUnsafe(1)
      locks.set(provider, lock)
      return lock
    },
    answer: (self, ask) => change((current, at) => answer(current, self, ask, at)),
    release: (message) => change((current, at) => [undefined, release(current, message, at)] as const),
    begin: (self, ask) => change((current, at) => begin(current, self, ask, at)),
    hold: (id) => change((current, at) => hold(current, id, at)),
    holds: (id) => change((current, at) => [holds(current, id, at), current] as const),
    finish: (id) => change((current) => [undefined, finish(current, id)] as const),
  }
}

/** This process's leases: every plugin instance on the host shares them. */
export const HOST = make()
