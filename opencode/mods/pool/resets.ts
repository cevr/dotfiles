// Rate-limit resets: when the pool claims one, and when it asks the owner
// first. A Codex reset credit restarts the account's whole week, so the pool
// claims one on its own when every Codex account is held by a spent window
// and a start waits; a Claude grant clears the 5-hour window (and the model's
// own week) but does not move the weekly reset, so it is worth only the time
// left until that reset: the pool asks the owner, once per hold, with that
// value, and claims only on a yes.
//
// The Resets aggregate keeps, across every pool of the host, the newest start
// each pool's pace held (a latch asks again every two minutes, so a wait
// older than WAIT_MS has gone), each hold's reset as it is worked (asked,
// claiming, settled, declined, withdrawn) under the hold's key, and the
// claims made with what they did to the windows. A hold's key names the
// account and the reset of its spent window, so a claim or a question is made
// once per hold; the claim's request id comes from the key, so a claim sent
// again (a restart, a retry) is the same claim to the provider.
//
// `Review` is the decision: it reads every pool's accounts as the pool holds
// them now and records what is due. The model (model.ts) carries it out.
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { accountWide, QuotaWindow, type ResetCredit } from "./quota.ts"
import type { AccountStatus } from "./status.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A held start older than this no longer waits: its latch would have asked again. */
export const WAIT_MS = 5 * MINUTE
/** A Codex credit that expires within this is claimed rather than lost, once its account's week is half spent. */
export const EXPIRING_MS = DAY
/** The weekly use at which an expiring Codex credit is worth claiming. */
export const EXPIRING_WEEKLY_USE = 0.5
/** Below this much time to the weekly reset, a Claude reset is probably not worth it. */
export const NOT_WORTH_MS = DAY
/** A claim that did not go through is sent again (under the same request id) after this. */
export const RETRY_MS = 10 * MINUTE
/** A claim is tried this many times at most. */
export const MAX_ATTEMPTS = 3
/** A finished reset is forgotten this long after its hold lifted. */
export const KEEP_MS = 7 * DAY
/** The claims kept, newest last. */
export const MAX_CLAIMS = 20
/** A hold's reset time is bucketed this coarsely in its key, so a reading's jitter keeps the key. */
const KEY_BUCKET_MS = 30 * MINUTE

/** Whose resets a pool holds: Claude grants are asked about, Codex credits claimed. */
export const ResetProvider = Schema.Literals(["claude", "codex"])
export type ResetProvider = typeof ResetProvider.Type

/** A start the pace held: when, and the session that made the call, if the pace was told. */
export const Wait = Schema.Struct({ at: Schema.Number, sessionID: Schema.optionalKey(Schema.String) })
export type Wait = typeof Wait.Type

/**
 * What a claim came to, as the providers answer: `reset` (the windows were
 * emptied), `nothing-to-reset` (not limited), `no-credit` (none left, or
 * ineligible), `already-redeemed` (this request id was claimed before),
 * `cooldown`, `rate-limited`, `unconfirmed` (the provider could not say),
 * `signed-out` (the login was refused), `failed` (no answer, or one that does
 * not read).
 */
export const ClaimOutcome = Schema.Literals([
  "reset",
  "nothing-to-reset",
  "no-credit",
  "already-redeemed",
  "cooldown",
  "rate-limited",
  "unconfirmed",
  "signed-out",
  "failed",
])
export type ClaimOutcome = typeof ClaimOutcome.Type

/** The outcomes worth sending the same claim again for, later. */
export const retryable = (outcome: ClaimOutcome): boolean =>
  outcome === "cooldown" || outcome === "rate-limited" || outcome === "unconfirmed" || outcome === "failed"

/** Why a reset is worked: every account is held and a start waits, or a credit is about to expire unused. */
export const ResetWhy = Schema.Literals(["held", "expiring"])
export type ResetWhy = typeof ResetWhy.Type

export const Stage = Schema.Literals(["asked", "claiming", "failed", "settled", "declined", "withdrawn"])
export type Stage = typeof Stage.Type

/** One hold's reset as the pool works it. */
export const Reset = Schema.Struct({
  key: Schema.String,
  pool: Schema.String,
  provider: ResetProvider,
  credentialID: Schema.String,
  /** The account's name as its store lists it, never a secret. */
  label: Schema.String,
  creditID: Schema.String,
  /** The claim's idempotency key, from the hold's key. */
  requestID: Schema.String,
  why: ResetWhy,
  stage: Stage,
  /** When it entered its stage (epoch ms). */
  at: Schema.Number,
  /** Claims sent so far. */
  attempts: Schema.Number,
  /** The session asked in, and the question, for a Claude reset. */
  sessionID: Schema.optionalKey(Schema.String),
  question: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(ClaimOutcome),
  message: Schema.optionalKey(Schema.String),
})
export type Reset = typeof Reset.Type

/** Whether the weekly window's reset moved with a claim: the open question about Claude's grants. */
export const WeeklyMove = Schema.Literals(["moved", "kept", "unread"])
export type WeeklyMove = typeof WeeklyMove.Type

/** A claim made, and the account's windows just before and just after it. */
export const Claim = Schema.Struct({
  key: Schema.String,
  pool: Schema.String,
  provider: ResetProvider,
  credentialID: Schema.String,
  label: Schema.String,
  creditID: Schema.String,
  requestID: Schema.String,
  at: Schema.Number,
  outcome: ClaimOutcome,
  message: Schema.optionalKey(Schema.String),
  before: Schema.Array(QuotaWindow),
  after: Schema.optionalKey(Schema.Array(QuotaWindow)),
  weekly: WeeklyMove,
})
export type Claim = typeof Claim.Type

export const ResetsState = Schema.Struct({
  /** The newest held start of each pool. */
  waits: Schema.Record(Schema.String, Wait),
  /** Each hold's reset, by its key. */
  resets: Schema.Record(Schema.String, Reset),
  /** The claims made, oldest first, at most MAX_CLAIMS. */
  claims: Schema.Array(Claim),
})
export type ResetsState = typeof ResetsState.Type

export const empty: ResetsState = { waits: {}, resets: {}, claims: [] }

// ── What an account's quota says ──

/** A window that holds an account: the 5-hour or the weekly one, spent until it resets. */
const spentWindows = (account: AccountStatus, now: number): ReadonlyArray<QuotaWindow> =>
  (account.reading?.windows ?? []).filter(
    (window) =>
      accountWide(window) &&
      (window.name === "5h" || window.name === "7d") &&
      window.utilization >= 1 &&
      window.resetAt !== undefined &&
      window.resetAt > now,
  )

/**
 * Until when the account is held by a spent window: the latest reset of its
 * spent windows, or its usage-limit hold when no reading says which window.
 * None when no spent window holds it (a rate limit or a sign-in is not one).
 */
export const spentUntil = (account: AccountStatus, now: number): number | undefined => {
  const spent = spentWindows(account, now)
  if (spent.length > 0) return Math.max(...spent.map((window) => window.resetAt ?? 0))
  const hold = account.hold
  return hold !== undefined && hold.kind === "usage-limit" && hold.until > now ? hold.until : undefined
}

/** The account's weekly window, as read. */
const weekly = (account: AccountStatus): QuotaWindow | undefined =>
  account.reading?.windows.find((window) => window.name === "7d" && accountWide(window))

/** The credits an account can claim now, soonest to expire first (one with no expiry last). */
export const usableCredits = (account: AccountStatus, now: number): ReadonlyArray<ResetCredit> =>
  (account.reading?.resets?.credits ?? [])
    .filter((credit) => credit.usable && credit.count > 0 && (credit.expiresAt === undefined || credit.expiresAt > now))
    .toSorted((left, right) => (left.expiresAt ?? Number.POSITIVE_INFINITY) - (right.expiresAt ?? Number.POSITIVE_INFINITY))

/** The key of the hold `until` on an account. */
export const holdKey = (provider: ResetProvider, pool: string, credentialID: string, until: number) =>
  `${provider}:${pool}:${credentialID}:${Math.floor(until / KEY_BUCKET_MS)}`

/** The key of a Codex credit claimed before it expires. */
export const expiringKey = (pool: string, creditID: string) => `codex-expiring:${pool}:${creditID}`

/** FNV-1a, 32 bits, as 8 hex digits. */
const fnv = (text: string) => {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/**
 * A claim's request id from its key: the same key, the same id, so a claim
 * sent again is the same claim. Letters, digits and `-` only, as Claude's
 * endpoint takes (`[A-Za-z0-9_-]{1,64}`).
 */
export const requestIdOf = (key: string) => `pool-${fnv(key)}${fnv(`${key}#`)}${fnv(`#${key}`)}`

// ── The question a Claude reset asks ──

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10)

/** A span as the owner reads it: days to one decimal from a day on, else hours. */
export const spanOf = (ms: number) => (ms >= DAY ? `${(ms / DAY).toFixed(1)} days` : `${Math.max(1, Math.round(ms / HOUR))} h`)

/** The question's choices; the first is the yes. */
export const CLAIM = "Claim it"
export const KEEP = "Don't claim"
/** What the pool does until an answer arrives. */
export const ASSUME = "Don't claim: the start waits for the window to reset"

/** Whether an answer to a Claude reset's question is a yes. */
export const isYes = (answer: string): boolean => {
  const said = answer.replace(/\s+/g, " ").trim().toLowerCase()
  return said === "claim it" || said === "claim" || said === "yes" || said === "y" || said.startsWith("claim it ") || said.startsWith("yes ")
}

/**
 * The question a Claude reset asks the owner: what it buys (the 5-hour window
 * back; the weekly window only when the grant clears it), the days left until
 * the account's natural weekly reset, which a claim does not move, and the
 * grant's end. Under a day to the weekly reset it says it is probably not worth it.
 */
export const claudeQuestion = (label: string, account: AccountStatus, credit: ResetCredit, now: number): string => {
  const spent = spentWindows(account, now).map((window) => window.name)
  const clears = credit.clears ?? []
  const week = weekly(account)
  const weekSpent = spent.includes("7d")
  const buys = weekSpent
    ? clears.includes("seven_day")
      ? "buys the 5h and weekly windows back"
      : `buys the 5h window back, but its weekly window is spent too and the grant clears ${clears.length === 0 ? "only the 5h window" : clears.join(", ")}, not seven_day: it may not lift the hold`
    : "buys the 5h window back"
  const left = week?.resetAt === undefined || week.resetAt <= now ? undefined : week.resetAt - now
  const remain = left === undefined ? "the weekly reset is unread" : `${spanOf(left)} remain before the weekly reset (${dayOf(now + left)})`
  const ends = credit.expiresAt === undefined ? "" : ` The grant ends ${dayOf(credit.expiresAt)}.`
  const worth = left !== undefined && left < NOT_WORTH_MS ? ` The weekly reset is ${spanOf(left)} away: probably not worth it.` : ""
  return `Claude reset on account ${label} now: ${buys} and ${remain}.${ends}${worth} Claim it?`
}

/** The question's header, at most 30 characters. */
export const claudeHeader = (label: string) => {
  const header = `Claude reset · ${label}`
  return header.length <= 30 ? header : `${header.slice(0, 29)}…`
}

// ── Commands and events ──

/** One pool as the review reads it: whose resets it holds, its accounts now, and each account's label. */
export interface PoolView {
  readonly id: string
  readonly provider: ResetProvider
  readonly accounts: ReadonlyArray<AccountStatus>
  readonly labels: Readonly<Record<string, string>>
}

/** A start on the pool was held by its pace, from the session `sessionID` when the pace was told. */
export const NoteWait = Schema.TaggedStruct("NoteWait", { pool: Schema.String, sessionID: Schema.optionalKey(Schema.String) })
export interface NoteWait extends Schema.Schema.Type<typeof NoteWait> {}

/** Decide what is due, on every pool's accounts as the pool holds them now. */
export interface Review {
  readonly _tag: "Review"
  readonly pools: ReadonlyArray<PoolView>
}
export const Review = { make: (input: { readonly pools: ReadonlyArray<PoolView> }): Review => ({ _tag: "Review", ...input }) }

/** The owner answered a reset's question (`undefined`: the question went without an answer, dismissed). */
export const TakeAnswer = Schema.TaggedStruct("TakeAnswer", { key: Schema.String, answer: Schema.optionalKey(Schema.String) })
export interface TakeAnswer extends Schema.Schema.Type<typeof TakeAnswer> {}

/** A claim came back, with the account's windows before it and as read again after it. */
export const SettleClaim = Schema.TaggedStruct("SettleClaim", {
  key: Schema.String,
  outcome: ClaimOutcome,
  message: Schema.optionalKey(Schema.String),
  before: Schema.Array(QuotaWindow),
  after: Schema.optionalKey(Schema.Array(QuotaWindow)),
})
export interface SettleClaim extends Schema.Schema.Type<typeof SettleClaim> {}

export type Command = NoteWait | Review | TakeAnswer | SettleClaim

export const WaitNoted = Schema.TaggedStruct("WaitNoted", { pool: Schema.String, wait: Wait })
export interface WaitNoted extends Schema.Schema.Type<typeof WaitNoted> {}

/** A claim is due: the model sends it. */
export const ClaimDue = Schema.TaggedStruct("ClaimDue", { reset: Reset })
export interface ClaimDue extends Schema.Schema.Type<typeof ClaimDue> {}

/** The owner is asked whether to claim: the model asks in the reset's session. */
export const OwnerAsked = Schema.TaggedStruct("OwnerAsked", { reset: Reset })
export interface OwnerAsked extends Schema.Schema.Type<typeof OwnerAsked> {}

/** The owner said no (or dismissed the question): no claim for this hold. */
export const AnswerDeclined = Schema.TaggedStruct("AnswerDeclined", { key: Schema.String, at: Schema.Number })
export interface AnswerDeclined extends Schema.Schema.Type<typeof AnswerDeclined> {}

/** The question is no longer worth an answer: the model withdraws it. */
export const AskWithdrawn = Schema.TaggedStruct("AskWithdrawn", { key: Schema.String, at: Schema.Number, why: Schema.String })
export interface AskWithdrawn extends Schema.Schema.Type<typeof AskWithdrawn> {}

export const ClaimSettled = Schema.TaggedStruct("ClaimSettled", { claim: Claim, stage: Stage })
export interface ClaimSettled extends Schema.Schema.Type<typeof ClaimSettled> {}

/** Finished resets whose hold lifted long ago. */
export const ResetsForgotten = Schema.TaggedStruct("ResetsForgotten", { keys: Schema.Array(Schema.String) })
export interface ResetsForgotten extends Schema.Schema.Type<typeof ResetsForgotten> {}

export type Event = WaitNoted | ClaimDue | OwnerAsked | AnswerDeclined | AskWithdrawn | ClaimSettled | ResetsForgotten

// ── Review ──

/** The newest held start of the pool, while it still waits. */
const waiting = (state: ResetsState, pool: string, now: number): Wait | undefined => {
  const wait = state.waits[pool]
  return wait !== undefined && now - wait.at < WAIT_MS ? wait : undefined
}

/** Whether every account the pool can use is held by a spent window; false for a pool with none. */
const allSpent = (accounts: ReadonlyArray<AccountStatus>, now: number) =>
  accounts.length > 0 && accounts.every((account) => spentUntil(account, now) !== undefined)

/** Whether a reset is still being worked: asked, claiming, or failed with tries left while its hold lasts. */
const active = (reset: Reset, current: ReadonlySet<string>, now: number) =>
  reset.stage === "asked" ||
  (reset.stage === "claiming" && now - reset.at < RETRY_MS) ||
  retries(reset, current)

/**
 * Whether a claim goes again, the same claim, while its hold lasts and it
 * has tries left: one that did not go through, or one sent that never came
 * back (a stop mid-claim) once RETRY_MS has passed.
 */
const retries = (reset: Reset, current: ReadonlySet<string>) =>
  (reset.stage === "failed" || reset.stage === "claiming") && reset.attempts < MAX_ATTEMPTS && current.has(reset.key)

/** A reset's fields from its hold. */
const resetOf = (
  view: PoolView,
  account: AccountStatus,
  credit: ResetCredit,
  key: string,
  why: ResetWhy,
  stage: Stage,
  now: number,
): Reset => ({
  key,
  pool: view.id,
  provider: view.provider,
  credentialID: account.credentialID,
  label: view.labels[account.credentialID] ?? account.credentialID,
  creditID: credit.id,
  requestID: requestIdOf(key),
  why,
  stage,
  at: now,
  attempts: 0,
})

/** Whether a reset's hold is still current: its key is among the keys the pools' holds give now. */
const currentKeys = (pools: ReadonlyArray<PoolView>, now: number): ReadonlySet<string> =>
  new Set(
    pools.flatMap((view) =>
      view.accounts.flatMap((account) => {
        const until = spentUntil(account, now)
        const held = until === undefined ? [] : [holdKey(view.provider, view.id, account.credentialID, until)]
        const expiring = view.provider === "codex" ? usableCredits(account, now).map((credit) => expiringKey(view.id, credit.id)) : []
        return [...held, ...expiring]
      }),
    ),
  )

/** The Codex claims due in a pool: one credit when every account is held and a start waits, and each credit about to expire. */
const codexDue = (
  state: ResetsState,
  view: PoolView,
  pools: ReadonlyArray<PoolView>,
  current: ReadonlySet<string>,
  now: number,
): ReadonlyArray<Event> => {
  const events: Array<Event> = []
  const busy = Object.values(state.resets).some((reset) => reset.pool === view.id && reset.why === "held" && active(reset, current, now))
  const claudeHeld = pools.some((other) => other.provider === "claude" && allSpent(other.accounts, now) && waiting(state, other.id, now) !== undefined)
  if (!busy && allSpent(view.accounts, now) && (waiting(state, view.id, now) !== undefined || claudeHeld)) {
    const candidates = view.accounts.flatMap((account) => {
      const until = spentUntil(account, now)
      const credit = usableCredits(account, now)[0]
      if (until === undefined || credit === undefined) return []
      const key = holdKey("codex", view.id, account.credentialID, until)
      return state.resets[key] === undefined ? [{ account, credit, key }] : []
    })
    const soonest = candidates.toSorted(
      (left, right) => (left.credit.expiresAt ?? Number.POSITIVE_INFINITY) - (right.credit.expiresAt ?? Number.POSITIVE_INFINITY),
    )[0]
    if (soonest !== undefined) events.push(ClaimDue.make({ reset: resetOf(view, soonest.account, soonest.credit, soonest.key, "held", "claiming", now) }))
  }
  // A credit about to expire unused is claimed while its account's week is half spent: the reset restarts the week.
  const claimed = new Set(events.flatMap((event) => (event._tag === "ClaimDue" ? [event.reset.creditID] : [])))
  for (const account of view.accounts) {
    const used = weekly(account)?.utilization ?? 0
    if (used < EXPIRING_WEEKLY_USE) continue
    for (const credit of usableCredits(account, now)) {
      if (credit.expiresAt === undefined || credit.expiresAt - now > EXPIRING_MS || claimed.has(credit.id)) continue
      const key = expiringKey(view.id, credit.id)
      if (state.resets[key] !== undefined) continue
      claimed.add(credit.id)
      events.push(ClaimDue.make({ reset: resetOf(view, account, credit, key, "expiring", "claiming", now) }))
    }
  }
  return events
}

/**
 * The Claude question due in a pool: when every account is held by a spent
 * window and a start waits from a session, one question, about the account
 * whose claim buys the most: one held by its 5-hour window alone before one
 * whose week is spent too, then the most time left before its weekly reset.
 * None while one is open, and never twice for one hold.
 */
const claudeDue = (state: ResetsState, view: PoolView, current: ReadonlySet<string>, now: number): ReadonlyArray<Event> => {
  const wait = waiting(state, view.id, now)
  if (wait?.sessionID === undefined || !allSpent(view.accounts, now)) return []
  if (Object.values(state.resets).some((reset) => reset.pool === view.id && active(reset, current, now))) return []
  const candidates = view.accounts.flatMap((account) => {
    const until = spentUntil(account, now)
    const credit = usableCredits(account, now)[0]
    if (until === undefined || credit === undefined) return []
    const key = holdKey("claude", view.id, account.credentialID, until)
    if (state.resets[key] !== undefined) return []
    const weekSpent = spentWindows(account, now).some((window) => window.name === "7d")
    const left = (weekly(account)?.resetAt ?? now) - now
    return [{ account, credit, key, weekSpent, left }]
  })
  const best = candidates.toSorted((left, right) => Number(left.weekSpent) - Number(right.weekSpent) || right.left - left.left)[0]
  if (best === undefined) return []
  const reset = resetOf(view, best.account, best.credit, best.key, "held", "asked", now)
  return [OwnerAsked.make({ reset: { ...reset, sessionID: wait.sessionID, question: claudeQuestion(reset.label, best.account, best.credit, now) } })]
}

const review = (state: ResetsState, command: Review, now: number): ReadonlyArray<Event> => {
  const current = currentKeys(command.pools, now)
  const events: Array<Event> = []
  // A question whose hold lifted by itself, or whose grant is gone, is withdrawn first.
  const credits = new Set(
    command.pools.flatMap((view) => view.accounts.flatMap((account) => usableCredits(account, now).map((credit) => `${view.id}:${account.credentialID}:${credit.id}`))),
  )
  const withdrawn = new Set<string>()
  for (const reset of Object.values(state.resets)) {
    if (reset.stage !== "asked") continue
    const why = !current.has(reset.key)
      ? "the hold lifted"
      : !credits.has(`${reset.pool}:${reset.credentialID}:${reset.creditID}`)
        ? "the grant can no longer be claimed"
        : undefined
    if (why === undefined) continue
    withdrawn.add(reset.key)
    events.push(AskWithdrawn.make({ key: reset.key, at: now, why }))
  }
  const after = { ...state, resets: Object.fromEntries(Object.entries(state.resets).filter(([key]) => !withdrawn.has(key))) }
  // A claim that did not go through goes again, the same claim, while its hold lasts.
  for (const reset of Object.values(state.resets)) {
    if (retries(reset, current) && now - reset.at >= RETRY_MS)
      events.push(ClaimDue.make({ reset: { ...reset, stage: "claiming", at: now } }))
  }
  for (const view of command.pools)
    events.push(...(view.provider === "codex" ? codexDue(after, view, command.pools, current, now) : claudeDue(after, view, current, now)))
  const stale = Object.values(state.resets).flatMap((reset) =>
    reset.stage !== "asked" && reset.stage !== "claiming" && !current.has(reset.key) && now - reset.at >= KEEP_MS ? [reset.key] : [],
  )
  if (stale.length > 0) events.push(ResetsForgotten.make({ keys: stale }))
  return events
}

// ── The answer and the settling ──

const takeAnswer = (state: ResetsState, command: TakeAnswer, now: number): ReadonlyArray<Event> => {
  const reset = state.resets[command.key]
  if (reset === undefined || reset.stage !== "asked") return []
  return command.answer !== undefined && isYes(command.answer)
    ? [ClaimDue.make({ reset: { ...reset, stage: "claiming", at: now } })]
    : [AnswerDeclined.make({ key: command.key, at: now })]
}

/** The weekly window's reset before and after a claim: moved by more than a minute, kept, or not read on both sides. */
export const weeklyMove = (before: ReadonlyArray<QuotaWindow>, after: ReadonlyArray<QuotaWindow> | undefined): WeeklyMove => {
  const was = before.find((window) => window.name === "7d")?.resetAt
  const is = after?.find((window) => window.name === "7d")?.resetAt
  if (was === undefined || is === undefined) return "unread"
  return Math.abs(is - was) > MINUTE ? "moved" : "kept"
}

const settleClaim = (state: ResetsState, command: SettleClaim, now: number): ReadonlyArray<Event> => {
  const reset = state.resets[command.key]
  if (reset === undefined || reset.stage !== "claiming") return []
  const claim: Claim = {
    key: reset.key,
    pool: reset.pool,
    provider: reset.provider,
    credentialID: reset.credentialID,
    label: reset.label,
    creditID: reset.creditID,
    requestID: reset.requestID,
    at: now,
    outcome: command.outcome,
    ...(command.message === undefined ? {} : { message: command.message }),
    before: command.before,
    ...(command.after === undefined ? {} : { after: command.after }),
    weekly: weeklyMove(command.before, command.after),
  }
  return [ClaimSettled.make({ claim, stage: retryable(command.outcome) ? "failed" : "settled" })]
}

export const Resets: Decider<ResetsState, Command, Event> = {
  initial: empty,
  decide: (state, command, now) => {
    switch (command._tag) {
      case "NoteWait":
        return Effect.succeed([WaitNoted.make({ pool: command.pool, wait: { at: now, ...(command.sessionID === undefined ? {} : { sessionID: command.sessionID }) } })])
      case "Review":
        return Effect.succeed(review(state, command, now))
      case "TakeAnswer":
        return Effect.succeed(takeAnswer(state, command, now))
      case "SettleClaim":
        return Effect.succeed(settleClaim(state, command, now))
    }
  },
  evolve: (state, event) => evolve(state, event),
}

const withStage = (state: ResetsState, key: string, stage: Stage, at: number, extra: Partial<Reset> = {}): ResetsState => {
  const reset = state.resets[key]
  return reset === undefined ? state : { ...state, resets: { ...state.resets, [key]: { ...reset, ...extra, stage, at } } }
}

export const evolve = (state: ResetsState, event: Event): ResetsState => {
  switch (event._tag) {
    case "WaitNoted":
      return { ...state, waits: { ...state.waits, [event.pool]: event.wait } }
    case "ClaimDue":
      return { ...state, resets: { ...state.resets, [event.reset.key]: { ...event.reset, attempts: event.reset.attempts + 1 } } }
    case "OwnerAsked":
      return { ...state, resets: { ...state.resets, [event.reset.key]: event.reset } }
    case "AnswerDeclined":
      return withStage(state, event.key, "declined", event.at)
    case "AskWithdrawn":
      return withStage(state, event.key, "withdrawn", event.at, { message: event.why })
    case "ClaimSettled":
      return {
        ...withStage(state, event.claim.key, event.stage, event.claim.at, {
          outcome: event.claim.outcome,
          ...(event.claim.message === undefined ? {} : { message: event.claim.message }),
        }),
        claims: [...state.claims, event.claim].slice(-MAX_CLAIMS),
      }
    case "ResetsForgotten": {
      const drop = new Set(event.keys)
      return { ...state, resets: Object.fromEntries(Object.entries(state.resets).filter(([key]) => !drop.has(key))) }
    }
  }
}
