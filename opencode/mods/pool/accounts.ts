// What the pool reads of its accounts at a time: whether one is held, where a
// new run of a session goes, and each account's load and live sessions. Pure
// functions of the AccountPool aggregate's state and `now`, so the commands
// that decide by them and the status the plugin answers read the same rules.
//
// - A run (a session from its first request until it goes idle) is pinned to
//   one account. It leaves that account only when the account is held.
// - A new run is placed by `rankPlacement`: held accounts last, accounts at
//   their share after those with room, then by recorded load and live
//   sessions, and equal accounts by the soonest weekly reset. The account
//   where the session's cache still lives is kept within one session.
// - An account is held until the time its refusal names: a plan limit until
//   its window resets, a rate limit for its `retry-after`, a rejected token
//   until the host refreshes it, a failed sign-in for as long as the provider
//   says. A window read as exhausted holds it until that reset.
import { Schema } from "effect"
import type { AccountPoolState } from "./account-pool.ts"
import { rankPlacement, type PlacementSlot } from "./placement.ts"
import type { AccountStatus, SessionAccount } from "./status.ts"
import type { QuotaReading } from "./quota.ts"

const MINUTE = 60_000

/** The window load and sessions are counted over. */
export const WINDOW_MS = 7 * 24 * 60 * MINUTE
/** How long a session's prompt cache lives on the account it last used. */
export const CACHE_LIFE_MS = 5 * MINUTE
/** A pin with no request for this long belongs to a run that stopped without going idle. */
export const PIN_IDLE_MS = 30 * MINUTE
/** A refusal without a time, or a refused response without a reading, holds the account this long. */
export const DEFAULT_HOLD_MS = 5 * MINUTE
/** The share of an account's 5-hour window a pool spends before the account has no room. */
export const FIVE_HOUR_SHARE = 0.9
/** The share of any other window a pool spends before the account has no room. */
export const OTHER_WINDOW_SHARE = 0.95

/** What a model request is for; a session's newest request of each kind has its own account. */
export const RequestKind = Schema.Literals(["primary", "compaction", "title", "generate"])
export type RequestKind = typeof RequestKind.Type

/** One priced step of a run, as the ledger records it. */
export const Step = Schema.Struct({
  at: Schema.Number,
  sessionID: Schema.String,
  credentialID: Schema.String,
  /** USD. */
  cost: Schema.Number,
})
export type Step = typeof Step.Type

/** Where a session's run, or its cache, is, and since when (epoch ms). */
export const Mark = Schema.Struct({ credentialID: Schema.String, at: Schema.Number })
export type Mark = typeof Mark.Type

/** The key of a session's newest request of a kind. */
export const placedKey = (sessionID: string, kind: RequestKind) => `${sessionID}:${kind}`

/** The same step, wherever it is held. */
export const stepIdentity = (step: Step) => `${step.at}/${step.sessionID}/${step.credentialID}/${step.cost}`

const shareOf = (window: string) => (window === "5h" ? FIVE_HOUR_SHARE : OTHER_WINDOW_SHARE)

export const held = (state: AccountPoolState, credentialID: string, now: number): boolean => {
  const hold = state.holds[credentialID]
  return hold !== undefined && hold.until > now
}

/** The newest reading, with each window that has since reset read as empty. */
const freshReading = (state: AccountPoolState, credentialID: string, now: number): QuotaReading | undefined => {
  const reading = state.readings[credentialID]
  if (reading === undefined) return undefined
  return {
    ...reading,
    windows: reading.windows.map((window) =>
      window.resetAt !== undefined && window.resetAt <= now ? { ...window, utilization: 0 } : window,
    ),
  }
}

/** At its share: a window spent to the pool's share of it. */
const noRoom = (reading: QuotaReading | undefined): boolean =>
  reading !== undefined && reading.windows.some((window) => window.utilization >= shareOf(window.name))

/** Each session whose run, or cache, is on an account now. */
const liveSessions = (state: AccountPoolState, now: number): Map<string, string> => {
  const where = new Map<string, string>()
  for (const [sessionID, mark] of Object.entries(state.recent))
    if (now - mark.at < CACHE_LIFE_MS) where.set(sessionID, mark.credentialID)
  for (const [sessionID, mark] of Object.entries(state.runs))
    if (now - mark.at < PIN_IDLE_MS) where.set(sessionID, mark.credentialID)
  return where
}

/** The accounts in placement order for a new run of `sessionID`; none when the pool has no account. */
export const rank = (state: AccountPoolState, sessionID: string, now: number): ReadonlyArray<string> => {
  const [first, ...others] = state.credentials
  if (first === undefined) return []
  const steps = state.steps.filter((step) => now - step.at < WINDOW_MS)
  const spent = steps.reduce((total, step) => total + step.cost, 0)
  const sessions = new Set(steps.filter((step) => step.cost > 0).map((step) => step.sessionID)).size
  const where = liveSessions(state, now)
  const slot = (credentialID: string): PlacementSlot<string> => {
    const reading = freshReading(state, credentialID, now)
    const weekly = reading?.windows.find((window) => window.name === "7d")
    return {
      slot: credentialID,
      load: steps.filter((step) => step.credentialID === credentialID).reduce((total, step) => total + step.cost, 0),
      live: [...where].filter(([session, account]) => session !== sessionID && account === credentialID).length,
      held: held(state, credentialID, now),
      noRoom: noRoom(reading),
      ...(weekly?.resetAt === undefined ? {} : { weeklyResetAt: weekly.resetAt }),
    }
  }
  const cache = state.recent[sessionID]
  const preferred = cache !== undefined && now - cache.at < CACHE_LIFE_MS ? cache.credentialID : undefined
  return rankPlacement({
    slots: [slot(first), ...others.map(slot)],
    spent,
    sessions,
    ...(preferred === undefined ? {} : { preferred }),
  })
}

/** The account the session's newest request of `kind` went out on. */
export const placedOn = (state: AccountPoolState, sessionID: string, kind: RequestKind): string | undefined =>
  state.placed[placedKey(sessionID, kind)]

/** When the session last sent a request through this pool, epoch ms. */
export const lastPlacedAt = (state: AccountPoolState, sessionID: string): number | undefined =>
  state.recent[sessionID]?.at ?? state.runs[sessionID]?.at

/**
 * Whether a failed primary request of `sessionID` should go again at once:
 * its account is now held and another account is not.
 */
export const shouldFailOver = (state: AccountPoolState, sessionID: string, now: number): boolean => {
  const account = placedOn(state, sessionID, "primary")
  if (account === undefined || !held(state, account, now)) return false
  return state.credentials.some((credentialID) => credentialID !== account && !held(state, credentialID, now))
}

/**
 * The account a session is on, as the session method reports it (without the
 * login's label, which its store holds): where its newest primary request went
 * out, else, before it has sent one, the pool's pick for its first (`rank`).
 * The reading counts a window that has reset since as empty. None when the
 * pool has no account.
 */
export const sessionAccount = (
  state: AccountPoolState,
  sessionID: string,
  now: number,
): Omit<SessionAccount, "pool" | "label"> | undefined => {
  const placed = placedOn(state, sessionID, "primary")
  const credentialID = placed ?? rank(state, sessionID, now)[0]
  if (credentialID === undefined) return undefined
  const hold = state.holds[credentialID]
  const reading = freshReading(state, credentialID, now)
  return {
    credentialID,
    on: placed === undefined ? "next" : "placed",
    ...(hold !== undefined && hold.until > now ? { hold } : {}),
    ...(reading === undefined ? {} : { reading }),
  }
}

/** Each account as the status method reports it. */
export const status = (state: AccountPoolState, now: number): ReadonlyArray<AccountStatus> => {
  const where = liveSessions(state, now)
  return state.credentials.map((credentialID) => {
    const hold = state.holds[credentialID]
    const reading = state.readings[credentialID]
    return {
      credentialID,
      ...(hold !== undefined && hold.until > now ? { hold } : {}),
      ...(reading === undefined ? {} : { reading }),
      load: state.steps
        .filter((step) => step.credentialID === credentialID && now - step.at < WINDOW_MS)
        .reduce((total, step) => total + step.cost, 0),
      live: [...where.values()].filter((account) => account === credentialID).length,
      noRoom: noRoom(freshReading(state, credentialID, now)),
    }
  })
}
