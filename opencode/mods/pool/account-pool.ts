// One provider's logins as one pool, keyed by its integration (PoolId): which
// accounts it has, which are held and why, the readings and priced steps
// placement reads, and where each session's run and cache are.
//
// The holds, readings, steps and caches are its ledger: the next process reads
// them back (the Ledger contract in service.ts), so a restart moves no session
// off the account its cache is on. Pins and placements are this process's own.
//
// The AccountPool decider, made for the pool's rules (its cache life), and
// each command it decides with its events and rejections, in the order a
// request meets them.
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import {
  cacheLives,
  DEFAULT_HOLD_MS,
  held,
  Mark,
  PIN_IDLE_MS,
  placedKey,
  placedOn,
  rank,
  RequestKind,
  type Rules,
  Step,
  stepIdentity,
  WINDOW_MS,
} from "./accounts.ts"
import { QuotaReading } from "./quota.ts"
import { Hold } from "./status.ts"

/** One pool: the integration whose logins it holds (`anthropic`). Several providers may share one. */
export const PoolId = Schema.String.pipe(Schema.brand("PoolId"))
export type PoolId = typeof PoolId.Type

export const AccountPoolState = Schema.Struct({
  /** Accounts in pool order: the provider's logins, as its integration lists them, then each outside store's. */
  credentials: Schema.Array(Schema.String),
  holds: Schema.Record(Schema.String, Hold),
  readings: Schema.Record(Schema.String, QuotaReading),
  /** Priced steps in the window, oldest first. */
  steps: Schema.Array(Step),
  /** The pin of each running session. */
  runs: Schema.Record(Schema.String, Mark),
  /** Where each session last sent a request: its cache lives there for a while. */
  recent: Schema.Record(Schema.String, Mark),
  /** The account each session's newest request of each kind went out on, by `sessionID:kind`. */
  placed: Schema.Record(Schema.String, Schema.String),
})
export type AccountPoolState = typeof AccountPoolState.Type

/** The part of the state the ledger keeps between processes. */
export type LedgerState = Pick<AccountPoolState, "holds" | "readings" | "steps" | "recent">

export const empty: AccountPoolState = { credentials: [], holds: {}, readings: {}, steps: [], runs: {}, recent: {}, placed: {} }

/**
 * A pool that starts from the ledger a previous process wrote, each session's
 * cache where it was. Its first PruneLedger drops what has expired since (a
 * cache older than the cache life among it), from the ledger too.
 */
export const restored = (ledger: LedgerState): AccountPoolState => ({
  ...empty,
  holds: ledger.holds,
  readings: ledger.readings,
  steps: [...ledger.steps].sort((left, right) => left.at - right.at),
  recent: ledger.recent,
})

// ── ListLogins ──
// The provider's logins were read: they are the pool's accounts, in order.

export const ListLogins = Schema.TaggedStruct("ListLogins", {
  /** The integration's subscription logins in its order, then each outside store's. */
  credentials: Schema.Array(Schema.String),
})
export interface ListLogins extends Schema.Schema.Type<typeof ListLogins> {}

export const LoginsListed = Schema.TaggedStruct("LoginsListed", {
  credentials: Schema.Array(Schema.String),
})
export interface LoginsListed extends Schema.Schema.Type<typeof LoginsListed> {}

export declare namespace ListLogins {
  export type Rejections = never
}

const same = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((credentialID, index) => credentialID === right[index])

/** The list as read; nothing when the pool already holds exactly these accounts. */
const listLogins = (state: AccountPoolState, command: ListLogins): Effect.Effect<ReadonlyArray<LoginsListed>> =>
  Effect.succeed(same(state.credentials, command.credentials) ? [] : [LoginsListed.make({ credentials: command.credentials })])

// ── PlaceRequest ──
// A model request of a session goes out: on the run's pin while its account
// is not held, else on the first account of a new placement, which keeps the
// account its cache is on while the cache lives.

export const PlaceRequest = Schema.TaggedStruct("PlaceRequest", {
  sessionID: Schema.String,
  kind: RequestKind,
})
export interface PlaceRequest extends Schema.Schema.Type<typeof PlaceRequest> {}

/** The request goes out on `credentialID`; the session's run is pinned there from `at` (epoch ms). */
export const RequestPlaced = Schema.TaggedStruct("RequestPlaced", {
  sessionID: Schema.String,
  kind: RequestKind,
  credentialID: Schema.String,
  at: Schema.Number,
})
export interface RequestPlaced extends Schema.Schema.Type<typeof RequestPlaced> {}

/** The pool has no account to place the request on: the provider lists no login. */
export class NoAccount extends Schema.TaggedError<NoAccount>()("NoAccount", {
  sessionID: Schema.String,
  kind: RequestKind,
}) {}

export declare namespace PlaceRequest {
  export type Rejections = NoAccount
}

const placeRequest = (
  rules: Rules,
  state: AccountPoolState,
  command: PlaceRequest,
  now: number,
): Effect.Effect<ReadonlyArray<RequestPlaced>, NoAccount> => {
  const pin = state.runs[command.sessionID]
  const pinned =
    pin !== undefined &&
    now - pin.at < PIN_IDLE_MS &&
    state.credentials.includes(pin.credentialID) &&
    !held(state, pin.credentialID, now)
      ? pin.credentialID
      : undefined
  const choice = pinned ?? rank(state, command.sessionID, now, rules)[0]
  if (choice === undefined) return Effect.fail(new NoAccount({ sessionID: command.sessionID, kind: command.kind }))
  return Effect.succeed([
    RequestPlaced.make({ sessionID: command.sessionID, kind: command.kind, credentialID: choice, at: now }),
  ])
}

// ── TakeReading ──
// A reading of one account came in. A live refusal holds the account until the
// refusal's time; a window read as exhausted holds it until that window resets.

export const TakeReading = Schema.TaggedStruct("TakeReading", {
  credentialID: Schema.String,
  reading: QuotaReading,
})
export interface TakeReading extends Schema.Schema.Type<typeof TakeReading> {}

/**
 * The account's newest reading, and the hold it sets, when it holds the
 * account longer than it is held now. A hold only grows: a shorter refusal
 * never frees an account a longer one holds.
 */
export const ReadingTaken = Schema.TaggedStruct("ReadingTaken", {
  credentialID: Schema.String,
  reading: QuotaReading,
  hold: Schema.optionalKey(Hold),
})
export interface ReadingTaken extends Schema.Schema.Type<typeof ReadingTaken> {}

export declare namespace TakeReading {
  export type Rejections = never
}

const takeReading = (
  state: AccountPoolState,
  command: TakeReading,
  now: number,
): Effect.Effect<ReadonlyArray<ReadingTaken>> => {
  const { credentialID, reading } = command
  const refusal = reading.refusal
  const refused =
    refusal !== undefined && (refusal.until === undefined || refusal.until > now)
      ? { kind: refusal.kind, until: refusal.until ?? now + DEFAULT_HOLD_MS }
      : undefined
  const exhausted = reading.windows
    .filter((window) => window.utilization >= 1 && window.resetAt !== undefined && window.resetAt > now)
    .reduce<number | undefined>((latest, window) => Math.max(latest ?? 0, window.resetAt ?? 0), undefined)
  const until = Math.max(refused?.until ?? 0, exhausted ?? 0)
  const current = state.holds[credentialID]
  const grows = until > now && (current === undefined || current.until < until)
  return Effect.succeed([
    ReadingTaken.make({
      credentialID,
      reading,
      ...(grows ? { hold: { kind: refused?.kind ?? "usage-limit", until, at: now } } : {}),
    }),
  ])
}

// ── RefuseRequest ──
// A request on an account was refused (401 or 429) and no reading said for
// how long: the account is held for the default time, unless it already is.

export const RefuseRequest = Schema.TaggedStruct("RefuseRequest", {
  credentialID: Schema.String,
  /** The response's HTTP status. */
  status: Schema.Number,
})
export interface RefuseRequest extends Schema.Schema.Type<typeof RefuseRequest> {}

export const RequestRefused = Schema.TaggedStruct("RequestRefused", {
  credentialID: Schema.String,
  hold: Hold,
})
export interface RequestRefused extends Schema.Schema.Type<typeof RequestRefused> {}

export declare namespace RefuseRequest {
  export type Rejections = never
}

const refuseRequest = (
  state: AccountPoolState,
  command: RefuseRequest,
  now: number,
): Effect.Effect<ReadonlyArray<RequestRefused>> => {
  if (held(state, command.credentialID, now)) return Effect.succeed([])
  const kind = command.status === 401 ? "unauthorized" : "rate-limit"
  return Effect.succeed([
    RequestRefused.make({ credentialID: command.credentialID, hold: { kind, until: now + DEFAULT_HOLD_MS, at: now } }),
  ])
}

// ── RecordStep ──
// A step of a session's run ended with its price: it counts on the account
// the run's primary request went out on, and the session's cache is there.

export const RecordStep = Schema.TaggedStruct("RecordStep", {
  sessionID: Schema.String,
  /** USD, as the host reported it; not a price when it is not a finite number at least 0. */
  cost: Schema.Number,
})
export interface RecordStep extends Schema.Schema.Type<typeof RecordStep> {}

export const StepRecorded = Schema.TaggedStruct("StepRecorded", { step: Step })
export interface StepRecorded extends Schema.Schema.Type<typeof StepRecorded> {}

export declare namespace RecordStep {
  export type Rejections = never
}

/** Nothing when the session has no account in this pool or the cost is not a price. */
const recordStep = (
  state: AccountPoolState,
  command: RecordStep,
  now: number,
): Effect.Effect<ReadonlyArray<StepRecorded>> => {
  const { sessionID, cost } = command
  const credentialID = placedOn(state, sessionID, "primary") ?? state.runs[sessionID]?.credentialID
  if (credentialID === undefined || !Number.isFinite(cost) || cost < 0) return Effect.succeed([])
  return Effect.succeed([StepRecorded.make({ step: { at: now, sessionID, credentialID, cost } })])
}

// ── ReleaseRun ──
// A session went idle: its run ended, and its next request is placed afresh,
// near its cache while the cache lives.

export const ReleaseRun = Schema.TaggedStruct("ReleaseRun", { sessionID: Schema.String })
export interface ReleaseRun extends Schema.Schema.Type<typeof ReleaseRun> {}

export const RunReleased = Schema.TaggedStruct("RunReleased", { sessionID: Schema.String })
export interface RunReleased extends Schema.Schema.Type<typeof RunReleased> {}

export declare namespace ReleaseRun {
  export type Rejections = never
}

/** Nothing when the session has no run here. */
const releaseRun = (state: AccountPoolState, command: ReleaseRun): Effect.Effect<ReadonlyArray<RunReleased>> =>
  Effect.succeed(state.runs[command.sessionID] === undefined ? [] : [RunReleased.make({ sessionID: command.sessionID })])

// ── PruneLedger ──
// Forget what has expired: steps out of the window, past holds, the pins of
// runs that stopped without going idle, and caches that no longer live.

export const PruneLedger = Schema.TaggedStruct("PruneLedger", {})
export interface PruneLedger extends Schema.Schema.Type<typeof PruneLedger> {}

export const LedgerPruned = Schema.TaggedStruct("LedgerPruned", {
  /** Steps out of the window. */
  steps: Schema.Array(Step),
  /** Accounts whose hold has passed. */
  holds: Schema.Array(Schema.String),
  /** Sessions whose pin has gone idle. */
  runs: Schema.Array(Schema.String),
  /** Sessions whose cache no longer lives. */
  caches: Schema.Array(Schema.String),
})
export interface LedgerPruned extends Schema.Schema.Type<typeof LedgerPruned> {}

export declare namespace PruneLedger {
  export type Rejections = never
}

/** Nothing when nothing has expired. */
const pruneLedger = (
  rules: Rules,
  state: AccountPoolState,
  _command: PruneLedger,
  now: number,
): Effect.Effect<ReadonlyArray<LedgerPruned>> => {
  const steps = state.steps.filter((step) => now - step.at >= WINDOW_MS)
  const holds = Object.entries(state.holds).flatMap(([credentialID, hold]) => (hold.until > now ? [] : [credentialID]))
  const runs = Object.entries(state.runs).flatMap(([sessionID, mark]) => (now - mark.at >= PIN_IDLE_MS ? [sessionID] : []))
  const caches = Object.entries(state.recent).flatMap(([sessionID, mark]) => (cacheLives(rules, mark.at, now) ? [] : [sessionID]))
  if (steps.length + holds.length + runs.length + caches.length === 0) return Effect.succeed([])
  return Effect.succeed([LedgerPruned.make({ steps, holds, runs, caches })])
}

// ── The aggregate ──

export type Command = ListLogins | PlaceRequest | TakeReading | RefuseRequest | RecordStep | ReleaseRun | PruneLedger
export type Event = LoginsListed | RequestPlaced | ReadingTaken | RequestRefused | StepRecorded | RunReleased | LedgerPruned
export type Rejection = NoAccount

const without = <A>(record: Readonly<Record<string, A>>, keys: ReadonlyArray<string>): Record<string, A> => {
  const drop = new Set(keys)
  return Object.fromEntries(Object.entries(record).filter(([key]) => !drop.has(key)))
}

/** The pool's aggregate under `rules`: how long a session's cache lives decides where its next run goes. */
export const AccountPool = (rules: Rules): Decider<AccountPoolState, Command, Event, Rejection> => ({
  initial: empty,
  decide: (state, command, now) => {
    switch (command._tag) {
      case "ListLogins":
        return listLogins(state, command)
      case "PlaceRequest":
        return placeRequest(rules, state, command, now)
      case "TakeReading":
        return takeReading(state, command, now)
      case "RefuseRequest":
        return refuseRequest(state, command, now)
      case "RecordStep":
        return recordStep(state, command, now)
      case "ReleaseRun":
        return releaseRun(state, command)
      case "PruneLedger":
        return pruneLedger(rules, state, command, now)
    }
  },
  evolve: (state, event) => {
    switch (event._tag) {
      case "LoginsListed":
        return { ...state, credentials: event.credentials }
      case "RequestPlaced": {
        const mark = { credentialID: event.credentialID, at: event.at }
        return {
          ...state,
          runs: { ...state.runs, [event.sessionID]: mark },
          recent: { ...state.recent, [event.sessionID]: mark },
          placed: { ...state.placed, [placedKey(event.sessionID, event.kind)]: event.credentialID },
        }
      }
      case "ReadingTaken":
        return {
          ...state,
          readings: { ...state.readings, [event.credentialID]: event.reading },
          ...(event.hold === undefined ? {} : { holds: { ...state.holds, [event.credentialID]: event.hold } }),
        }
      case "RequestRefused":
        return { ...state, holds: { ...state.holds, [event.credentialID]: event.hold } }
      case "StepRecorded":
        return {
          ...state,
          steps: [...state.steps, event.step],
          recent: { ...state.recent, [event.step.sessionID]: { credentialID: event.step.credentialID, at: event.step.at } },
        }
      case "RunReleased":
        return { ...state, runs: without(state.runs, [event.sessionID]) }
      case "LedgerPruned": {
        const pruned = new Set(event.steps.map(stepIdentity))
        return {
          ...state,
          steps: state.steps.filter((step) => !pruned.has(stepIdentity(step))),
          holds: without(state.holds, event.holds),
          runs: without(state.runs, event.runs),
          recent: without(state.recent, event.caches),
        }
      }
    }
  },
})
