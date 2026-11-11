// The fleet's claim leases: how hosts that read one provider account agree
// which of them claims its reset, with no host the master. Before a claim, a
// host asks each peer it reaches for the account's lease: an account is the
// set of reset ids its reading lists (resets.ts `grantsOf`), so two hosts
// name it alike though each has its own login for it.
//
// A peer grants the lease unless one of these holds:
// - it lent the account's lease to another host and that lease is live;
// - it has seen a claim on the account no older than the asker's reading;
// - it is claiming on the account itself;
// - it is asking for the lease at once and asked first. The ask made earlier
//   wins, then the lower host name, the same on both sides; the loser yields.
//
// A host claims only once every peer that answered granted it. It then holds
// the lease for its `holdMs` (a lease whose host went away lapses then) and
// releases it with the claim's time, so the peers know a claim was made. A
// peer that does not answer within the wait is passed over: the host claims
// on a fresh reading of the account (model.ts), and the claim's record says
// so. On a link that is down both ways, two hosts may both claim; they send
// one request id (resets.ts `claimRequestID`).
//
// The table is pure: `answer`, `begin`, `hold`, `finish` and `release` each
// return the new table. `make` keeps one table per host behind the `Leases`
// service; `HOST` is the process's, shared by every plugin instance in it.
import { Clock, Context, Effect, Schema, Semaphore } from "effect"
import { ResetProvider } from "./resets.ts"

const MINUTE = 60_000

/** How long a lease holds without a release: a claim reads the account, sends the claim and reads it again well within it. */
export const LEASE_MS = 2 * MINUTE
/** The longest lease a peer lends, whatever the asker asks. */
export const MAX_LEASE_MS = 10 * MINUTE
/** How long a host waits for each peer's answer before it passes over the peer. */
export const LEASE_WAIT_MS = 10_000
/** How long a claim is remembered against an older reading. */
const SEEN_MS = 24 * 60 * MINUTE

const LeaseFields = {
  /** The host asking, as the fleet names it (`FleetConfig.host`). */
  host: Schema.String,
  /** The ask's id: one claim's, released under it. */
  id: Schema.String,
  provider: ResetProvider,
  /** The account: the reset ids its reading lists. */
  grants: Schema.Array(Schema.String),
}

/** A host asks for an account's lease, on a reading taken at `readAt`, at `requestedAt`, to hold for `holdMs`. */
export const LeaseAsk = Schema.TaggedStruct("Ask", { ...LeaseFields, readAt: Schema.Number, requestedAt: Schema.Number, holdMs: Schema.Number })
export type LeaseAsk = typeof LeaseAsk.Type

/** A host releases a lease, with when its claim went through, if it did. */
export const LeaseRelease = Schema.TaggedStruct("Release", { ...LeaseFields, claimedAt: Schema.optionalKey(Schema.Number) })
export type LeaseRelease = typeof LeaseRelease.Type

export const LeaseMessage = Schema.Union([LeaseAsk, LeaseRelease])
export type LeaseMessage = typeof LeaseMessage.Type

/** A peer's answer: granted, or why not. A release is always granted. */
export const LeaseAnswer = Schema.Struct({ granted: Schema.Boolean, reason: Schema.optionalKey(Schema.String) })
export type LeaseAnswer = typeof LeaseAnswer.Type

interface Account {
  readonly provider: ResetProvider
  readonly grants: ReadonlyArray<string>
}

/** A lease this host asks for (`asking`), holds (`held`), or gave up to a host that asked first (`yielded`). */
export interface Own extends Account {
  readonly id: string
  readonly readAt: number
  readonly requestedAt: number
  readonly stage: "asking" | "held" | "yielded"
  readonly expiresAt: number
}

/** A lease this host lent another. */
export interface Lent extends Account {
  readonly host: string
  readonly id: string
  readonly expiresAt: number
}

/** A claim this host made or was told of. */
export interface Seen extends Account {
  readonly at: number
}

export interface LeaseTable {
  readonly own: ReadonlyArray<Own>
  readonly lent: ReadonlyArray<Lent>
  readonly seen: ReadonlyArray<Seen>
}

export const emptyTable: LeaseTable = { own: [], lent: [], seen: [] }

/** Whether two leases are on one account: one provider, a reset id in common. */
export const sameAccount = (left: Account, right: Account) => left.provider === right.provider && left.grants.some((id) => right.grants.includes(id))

/** Whether `left` asked before `right`: the earlier ask, then the lower host name. */
export const asksFirst = (left: { readonly requestedAt: number; readonly host: string }, right: { readonly requestedAt: number; readonly host: string }) =>
  left.requestedAt < right.requestedAt || (left.requestedAt === right.requestedAt && left.host < right.host)

const prune = (table: LeaseTable, now: number): LeaseTable => ({
  own: table.own.filter((item) => item.expiresAt > now),
  lent: table.lent.filter((item) => item.expiresAt > now),
  seen: table.seen.filter((item) => now - item.at < SEEN_MS),
})

const stamp = (at: number) => new Date(at).toISOString()

/** Why the account is not free for a lease `ask`ed by `asker` on a reading at `readAt`, by what was lent and seen; none when it is. */
const taken = (table: LeaseTable, account: Account & { readonly readAt: number }, asker: string): string | undefined => {
  const lent = table.lent.find((item) => item.host !== asker && sameAccount(item, account))
  if (lent !== undefined) return `${lent.host} holds the account's lease until ${stamp(lent.expiresAt)}`
  const seen = table.seen.find((item) => sameAccount(item, account) && item.at >= account.readAt)
  if (seen !== undefined) return `a claim at ${stamp(seen.at)} is newer than the reading`
  return undefined
}

/** `self`'s answer to a peer's `ask`, and its table after it. */
export const answer = (table: LeaseTable, self: string, ask: LeaseAsk, now: number): readonly [LeaseAnswer, LeaseTable] => {
  const current = prune(table, now)
  const refuse = (reason: string) => [{ granted: false, reason }, current] as const
  const why = taken(current, ask, ask.host)
  if (why !== undefined) return refuse(why)
  const mine = current.own.find((item) => item.stage !== "yielded" && sameAccount(item, ask))
  if (mine?.stage === "held") return refuse(`${self} is claiming on the account`)
  if (mine !== undefined && asksFirst({ requestedAt: mine.requestedAt, host: self }, ask)) return refuse(`${self} asked first`)
  const own = current.own.map((item) => (item === mine ? { ...item, stage: "yielded" as const } : item))
  const lent = [
    ...current.lent.filter((item) => !(item.host === ask.host && item.id === ask.id)),
    { host: ask.host, id: ask.id, provider: ask.provider, grants: ask.grants, expiresAt: now + Math.min(Math.max(ask.holdMs, 0), MAX_LEASE_MS) },
  ]
  return [{ granted: true }, { ...current, own, lent }]
}

/** A peer released its lease: lent no more, and its claim, if one went through, seen. */
export const release = (table: LeaseTable, message: LeaseRelease, now: number): LeaseTable => {
  const current = prune(table, now)
  return {
    ...current,
    lent: current.lent.filter((item) => !(item.host === message.host && item.id === message.id)),
    seen: message.claimedAt === undefined ? current.seen : [...current.seen, { provider: message.provider, grants: message.grants, at: message.claimedAt }],
  }
}

/** This host starts asking for a lease; why it may not, if so (another host's lease, a newer claim, a claim in hand here). */
export const begin = (
  table: LeaseTable,
  self: string,
  ask: Pick<LeaseAsk, "id" | "provider" | "grants" | "readAt" | "requestedAt" | "holdMs">,
  now: number,
): readonly [string | undefined, LeaseTable] => {
  const current = prune(table, now)
  const why = taken(current, ask, self) ?? (current.own.some((item) => item.stage !== "yielded" && sameAccount(item, ask)) ? "a claim on the account is in hand here" : undefined)
  if (why !== undefined) return [why, current]
  const own: Own = { ...ask, stage: "asking", expiresAt: now + ask.holdMs }
  return [undefined, { ...current, own: [...current.own.filter((item) => item.id !== ask.id), own] }]
}

/** Every peer that answered granted: hold the lease, unless this host yielded it meanwhile (false). */
export const hold = (table: LeaseTable, id: string, holdMs: number, now: number): readonly [boolean, LeaseTable] => {
  const mine = table.own.find((item) => item.id === id)
  if (mine === undefined || mine.stage === "yielded" || mine.expiresAt <= now) return [false, table]
  return [true, { ...table, own: table.own.map((item) => (item === mine ? { ...item, stage: "held" as const, expiresAt: now + holdMs } : item)) }]
}

/** The claim is done (or not made): the lease ends, and a claim that went through is seen. */
export const finish = (table: LeaseTable, id: string, claimedAt: number | undefined): LeaseTable => {
  const mine = table.own.find((item) => item.id === id)
  return {
    ...table,
    own: table.own.filter((item) => item.id !== id),
    seen: mine === undefined || claimedAt === undefined ? table.seen : [...table.seen, { provider: mine.provider, grants: mine.grants, at: claimedAt }],
  }
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
    readonly hold: (id: string, holdMs: number) => Effect.Effect<boolean>
    readonly finish: (id: string, claimedAt: number | undefined) => Effect.Effect<void>
  }
>()("dotfiles-opencode/pool/Leases") {}

/** A host's leases in memory: a fresh table and locks. */
export const make = (): Leases["Service"] => {
  let table = emptyTable
  const locks = new Map<ResetProvider, Semaphore.Semaphore>()
  /** Change the table at the clock's time, and answer what the change says. */
  const change = <A>(body: (at: number) => readonly [A, LeaseTable]) =>
    Effect.map(Clock.currentTimeMillis, (at) => {
      const [result, next] = body(at)
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
    answer: (self, ask) => change((at) => answer(table, self, ask, at)),
    release: (message) => change((at) => [undefined, release(table, message, at)] as const),
    begin: (self, ask) => change((at) => begin(table, self, ask, at)),
    hold: (id, holdMs) => change((at) => hold(table, id, holdMs, at)),
    finish: (id, claimedAt) => change(() => [undefined, finish(table, id, claimedAt)] as const),
  }
}

/** This process's leases: every plugin instance on the host shares them. */
export const HOST = make()
